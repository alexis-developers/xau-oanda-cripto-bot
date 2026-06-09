import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import WebSocket from 'ws';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─── Config ───────────────────────────────────────────────────────────────────
const DERIV_TOKEN     = process.env.DERIV_TOKEN;
const DERIV_ACCOUNT_ID= process.env.DERIV_ACCOUNT_ID || 'DOT93096841';
const APP_ID          = process.env.DERIV_APP_ID     || '33v8gypvQ2TA7ORg5HNfb';
const SYMBOL          = process.env.SYMBOL           || 'frxXAUUSD';
const TIMEFRAME       = process.env.TIMEFRAME        || 'M15';
const MULTIPLIER      = parseInt(process.env.MULTIPLIER     || '100');
const STAKE           = parseFloat(process.env.STAKE        || '10');
const CAPITAL_TOTAL   = parseFloat(process.env.CAPITAL_TOTAL   || '10000');
const RISK_PERC       = parseFloat(process.env.RISK_PERC       || '1');
const SMA_PERIOD      = parseInt(process.env.SMA_PERIOD        || '20');
const SLOPE_THRESHOLD = parseFloat(process.env.SLOPE_THRESHOLD || '0.5');
const SL_POINTS       = parseFloat(process.env.SL_POINTS       || '2.0');
const TRAILING_BUFFER = parseFloat(process.env.TRAILING_BUFFER || '0.5');
const TP1_RATIO       = parseFloat(process.env.TP1_RATIO       || '2.0');
const TP1_CLOSE_PERC  = parseFloat(process.env.TP1_CLOSE_PERC  || '80');
const DAILY_LOSS_PERC = parseFloat(process.env.DAILY_LOSS_PERC || '5');
const PORT            = parseInt(process.env.PORT             || '8000');
const WEBHOOK_URL     = process.env.WEBHOOK_URL || '';

// Deriv granularity (seconds)
const GRAN_MAP = { M1:60, M5:300, M15:900, M30:1800, H1:3600, H4:14400, D1:86400 };
const GRANULARITY = GRAN_MAP[TIMEFRAME] || 900;

const TRADES_FILE = join(ROOT, 'trades.json');

if (!DERIV_TOKEN) {
  console.error('FATAL: DERIV_TOKEN é obrigatório no .env');
  process.exit(1);
}

// ─── State ────────────────────────────────────────────────────────────────────
let logs          = [];
let trades        = [];
let equity        = CAPITAL_TOTAL;
let dailyPnL      = 0;
let dailyDate     = new Date().toDateString();
let isWarmingUp   = true;
let candleCache   = [];
let formingCandle = null;
let httpStarted   = false;

// Posição ativa
let position = null;
// {
//   contractId, side, contractType,
//   fullStake, currentStake,
//   entryPrice, sl, slAmount, tp1Price,
//   tp1Hit, isBreakeven
// }

// ─── Logging & Webhook ────────────────────────────────────────────────────────
function log(msg, level = 'info') {
  const prefix = { info:'[INFO]', warning:'[WARNING]', error:'[ERROR]', system:'===' }[level] || '[INFO]';
  const line   = `${new Date().toISOString()} ${prefix} ${msg}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 50) logs.shift();
}

async function sendWebhook(content) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (e) { log(`Webhook error: ${e.message}`, 'error'); }
}

// ─── Persistence ──────────────────────────────────────────────────────────────
function loadTrades() {
  if (!existsSync(TRADES_FILE)) return [];
  try { return JSON.parse(readFileSync(TRADES_FILE, 'utf8')); }
  catch { return []; }
}

function saveTrade(trade) {
  trades.push(trade);
  writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

function rebuildEquity() {
  trades = loadTrades();
  equity = CAPITAL_TOTAL;
  for (const t of trades) {
    if (typeof t.pnl === 'number' && !isNaN(t.pnl)) equity += t.pnl;
  }
  log(`Equity reconstruído: $${equity.toFixed(2)} de ${trades.length} trades`, 'system');
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcSMA(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const s = closes.slice(i - period + 1, i + 1);
    return s.reduce((a, b) => a + b, 0) / period;
  });
}

// ─── Signal Engine ────────────────────────────────────────────────────────────
function detectSignal(candles) {
  if (candles.length < SMA_PERIOD + 5) return null;
  const closes  = candles.map(c => c.close);
  const sma     = calcSMA(closes, SMA_PERIOD);
  const n       = candles.length;
  const smaNow  = sma[n - 1], smaPrev = sma[n - 2], sma3 = sma[n - 4];
  if (!smaNow || !smaPrev || !sma3) return null;
  const trigger = candles[n - 1], pivot = candles[n - 2];
  const slope   = smaNow - sma3;
  const up      = slope >  SLOPE_THRESHOLD;
  const down    = slope < -SLOPE_THRESHOLD;
  if (up   && pivot.low  <= smaPrev && trigger.close > trigger.open && trigger.high > pivot.high) return 'buy';
  if (down && pivot.high >= smaPrev && trigger.close < trigger.open && trigger.low  < pivot.low)  return 'sell';
  return null;
}

// ─── Risk Manager ─────────────────────────────────────────────────────────────
function priceToUSD(stake, mult, entryPrice, priceDistance) {
  return parseFloat((stake * mult * Math.abs(priceDistance) / entryPrice).toFixed(2));
}

function calcSLPrice(side, pivot) {
  return side === 'buy' ? pivot.low - SL_POINTS : pivot.high + SL_POINTS;
}

// ─── Daily Reset ─────────────────────────────────────────────────────────────
function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== dailyDate) {
    log(`Novo dia. PnL anterior: $${dailyPnL.toFixed(2)}`, 'system');
    dailyPnL = 0; dailyDate = today;
  }
}
function isDailyLimitHit() {
  return dailyPnL <= -(equity * DAILY_LOSS_PERC / 100);
}

// ─── WebSocket Manager ────────────────────────────────────────────────────────
let ws;
let reqCounter  = 0;
let msgHandlers = new Map();
let wsReady     = false;

function sendWS(msg, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++reqCounter;
    msg.req_id = id;
    msgHandlers.set(id, { resolve, reject });
    ws.send(JSON.stringify(msg));
    setTimeout(() => {
      if (msgHandlers.has(id)) {
        msgHandlers.delete(id);
        reject(new Error(`WS timeout req_id=${id}`));
      }
    }, timeoutMs);
  });
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); }
  catch { return; }

  if (msg.req_id && msgHandlers.has(msg.req_id)) {
    const { resolve, reject } = msgHandlers.get(msg.req_id);
    msgHandlers.delete(msg.req_id);
    if (msg.error) reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
    else resolve(msg);
    return;
  }

  switch (msg.msg_type) {
    case 'ohlc':    handleOHLC(msg.ohlc);             break;
    case 'balance': handleBalance(msg.balance);        break;
    case 'proposal_open_contract': handleContractUpdate(msg.proposal_open_contract); break;
  }
}

function handleBalance(b) {
  if (b?.balance !== undefined) equity = parseFloat(b.balance);
}

// ─── OHLC Handler — detecta novo candle fechado ───────────────────────────────
function handleOHLC(ohlc) {
  if (!ohlc) return;
  const openTime = parseInt(ohlc.open_time);
  const tick = {
    time:  openTime,
    open:  parseFloat(ohlc.open),
    high:  parseFloat(ohlc.high),
    low:   parseFloat(ohlc.low),
    close: parseFloat(ohlc.close),
  };

  if (formingCandle && formingCandle.time !== openTime) {
    candleCache.push({ ...formingCandle });
    if (candleCache.length > 500) candleCache.shift();
    if (!isWarmingUp) {
      processNewCandle().catch(e => log(`Erro no tick: ${e.message}`, 'error'));
    }
  }

  formingCandle = tick;
}

// ─── Contract Update Handler ───────────────────────────────────────────────────
function handleContractUpdate(poc) {
  if (!poc || !position) return;
  if (poc.contract_id !== position.contractId) return;

  if (poc.is_sold || poc.status === 'sold') {
    const pl = parseFloat(poc.profit || 0);
    log(`Contrato ${position.contractId} fechado. PnL: $${pl.toFixed(2)}`, 'system');
    equity   += pl;
    dailyPnL += pl;
    saveTrade({
      id:        `close_${Date.now()}`,
      timestamp: Date.now(),
      datetime:  new Date().toISOString(),
      side:      position.side === 'buy' ? 'sell' : 'buy',
      type:      'stop_loss',
      price:     parseFloat(poc.exit_tick || 0),
      pnl:       pl
    });
    sendWebhook(`**SAÍDA (SL)** ${SYMBOL} | PnL: $${pl.toFixed(2)} | Equity: $${equity.toFixed(2)}`);
    position = null;
  }
}

// ─── Main Candle Logic ────────────────────────────────────────────────────────
async function processNewCandle() {
  checkDailyReset();
  const last = candleCache[candleCache.length - 1];
  log(`Novo candle: ${new Date(last.time * 1000).toISOString().slice(0,16)} | C:${last.close.toFixed(2)}`, 'info');

  if (position) {
    await managePosition();
    return;
  }

  if (isDailyLimitHit()) {
    log('Limite diário atingido. Sem novas entradas.', 'warning');
    return;
  }

  const signal = detectSignal(candleCache);
  if (signal) {
    log(`Sinal: ${signal.toUpperCase()}`, 'info');
    await enterTrade(signal);
  }
}

// ─── Trade Execution ──────────────────────────────────────────────────────────
async function enterTrade(signal) {
  if (position) return;

  const n         = candleCache.length;
  const pivot     = candleCache[n - 2];
  const trigger   = candleCache[n - 1];
  const slPrice   = calcSLPrice(signal, pivot);
  const slDist    = Math.abs(trigger.close - slPrice);
  const tp1Price  = signal === 'buy'
    ? trigger.close + slDist * TP1_RATIO
    : trigger.close - slDist * TP1_RATIO;

  const slAmount  = priceToUSD(STAKE, MULTIPLIER, trigger.close, slDist);
  const tp1Amount = priceToUSD(STAKE, MULTIPLIER, trigger.close, slDist * TP1_RATIO);
  const contractType = signal === 'buy' ? 'MULTUP' : 'MULTDOWN';

  log(`SINAL ${signal.toUpperCase()} | SL: ${slPrice.toFixed(2)} ($${slAmount}) | TP1: ${tp1Price.toFixed(2)} ($${tp1Amount})`, 'system');

  try {
    // Nova API Deriv: proposal → buy (2 passos)
    const proposalRes = await sendWS({
      proposal:          1,
      contract_type:     contractType,
      currency:          'USD',
      underlying_symbol: SYMBOL,
      amount:            STAKE,
      basis:             'stake',
      multiplier:        MULTIPLIER,
      limit_order: {
        stop_loss:   slAmount,
        take_profit: parseFloat((tp1Amount * (TP1_CLOSE_PERC / 100)).toFixed(2))
      }
    });
    const proposalId = proposalRes.proposal?.id;
    if (!proposalId) throw new Error('Proposal sem ID: ' + JSON.stringify(proposalRes));

    const result = await sendWS({ buy: proposalId, price: STAKE * 2 });

    const contract   = result.buy;
    const contractId = contract.contract_id;
    const entryPrice = parseFloat(contract.buy_price) || trigger.close;

    position = {
      contractId,
      side:         signal,
      contractType,
      fullStake:    STAKE,
      currentStake: STAKE,
      entryPrice,
      sl:           slPrice,
      slAmount,
      tp1Price,
      tp1Hit:       false,
      isBreakeven:  false
    };

    sendWS({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
      .catch(e => log(`Subscribe contrato: ${e.message}`, 'error'));

    saveTrade({
      id:        String(contractId),
      timestamp: Date.now(),
      datetime:  new Date().toISOString(),
      side:      signal,
      type:      'entry',
      price:     entryPrice,
      stake:     STAKE,
      sl:        slPrice,
      tp1:       tp1Price,
      pnl:       null
    });

    await sendWebhook(
      `**ENTRADA ${signal.toUpperCase()} ${SYMBOL}**\n` +
      `Preço: ${entryPrice} | SL: ${slPrice.toFixed(2)} | TP1: ${tp1Price.toFixed(2)}\n` +
      `Stake: $${STAKE} | Mult: ${MULTIPLIER}x | SL: $${slAmount} | Equity: $${equity.toFixed(2)}`
    );
    log(`Contrato aberto: ${contractId} @ ${entryPrice}`, 'info');

  } catch (e) {
    log(`Erro ao abrir contrato: ${e.message}`, 'error');
    await sendWebhook(`**ERRO** ${signal.toUpperCase()} ${SYMBOL}: ${e.message}`);
  }
}

async function managePosition() {
  if (!position) return;

  const n            = candleCache.length;
  const currentPrice = candleCache[n - 1].close;
  const prevCandle   = candleCache[n - 2];

  // ── TP1: fechar contrato e reabrir com 20% ────────────────────────────────
  if (!position.tp1Hit) {
    const tp1Reached = position.side === 'buy'
      ? currentPrice >= position.tp1Price
      : currentPrice <= position.tp1Price;

    if (tp1Reached) {
      try {
        const sellResult = await sendWS({ sell: position.contractId, price: 0 });
        const pl = parseFloat(sellResult.sell?.sold_for || 0) - position.currentStake;
        equity   += pl;
        dailyPnL += pl;

        saveTrade({
          id:        `tp1_${Date.now()}`,
          timestamp: Date.now(),
          datetime:  new Date().toISOString(),
          side:      position.side === 'buy' ? 'sell' : 'buy',
          type:      'tp1_close',
          price:     currentPrice,
          pnl:       pl
        });

        log(`TP1 atingido! PnL: $${pl.toFixed(2)}. Reabrindo 20%...`, 'system');

        const trailStake = parseFloat((position.fullStake * (1 - TP1_CLOSE_PERC / 100)).toFixed(2));
        const beSlDist   = 0.01;
        const beSlAmount = priceToUSD(trailStake, MULTIPLIER, currentPrice, beSlDist);

        await sleep(1000);
        const prop2 = await sendWS({
          proposal:          1,
          contract_type:     position.contractType,
          currency:          'USD',
          underlying_symbol: SYMBOL,
          amount:            trailStake,
          basis:             'stake',
          multiplier:        MULTIPLIER,
          limit_order:       { stop_loss: parseFloat(Math.max(0.13, beSlAmount).toFixed(2)) }
        });
        const result2 = await sendWS({ buy: prop2.proposal.id, price: trailStake * 2 });

        const c2 = result2.buy;
        position = {
          contractId:   c2.contract_id,
          side:         position.side,
          contractType: position.contractType,
          fullStake:    position.fullStake,
          currentStake: trailStake,
          entryPrice:   parseFloat(c2.buy_price) || currentPrice,
          sl:           currentPrice,
          slAmount:     beSlAmount,
          tp1Price:     position.tp1Price,
          tp1Hit:       true,
          isBreakeven:  true
        };

        sendWS({ proposal_open_contract: 1, contract_id: c2.contract_id, subscribe: 1 })
          .catch(e => log(`Subscribe trailing: ${e.message}`, 'error'));

        log(`Trailing aberto: ${c2.contract_id} | Stake: $${trailStake} | SL: breakeven`, 'info');
        await sendWebhook(
          `**TP1 ${SYMBOL}** | PnL: +$${pl.toFixed(2)}\n` +
          `Trailing aberto ($${trailStake}) com SL em breakeven`
        );

      } catch (e) {
        log(`Erro no TP1: ${e.message}`, 'error');
      }
      return;
    }
  }

  // ── Trailing Stop (após TP1) ───────────────────────────────────────────────
  if (position.tp1Hit) {
    let newSLPrice;
    if (position.side === 'buy') {
      newSLPrice = prevCandle.low - TRAILING_BUFFER;
      if (newSLPrice <= position.sl) return;
    } else {
      newSLPrice = prevCandle.high + TRAILING_BUFFER;
      if (newSLPrice >= position.sl) return;
    }

    const slDist      = Math.abs(position.entryPrice - newSLPrice);
    const newSLAmount = priceToUSD(position.currentStake, MULTIPLIER, position.entryPrice, slDist);

    try {
      await sendWS({
        contract_update: 1,
        contract_id:     position.contractId,
        limit_order: { stop_loss: parseFloat(Math.max(0.13, newSLAmount).toFixed(2)) }
      });
      log(`Trailing SL: ${position.sl.toFixed(2)} → ${newSLPrice.toFixed(2)} ($${newSLAmount.toFixed(2)})`, 'info');
      position.sl       = newSLPrice;
      position.slAmount = newSLAmount;
    } catch (e) {
      log(`Erro no trailing SL: ${e.message}`, 'error');
    }
  }
}

// ─── Deriv New API — OTP + WebSocket ─────────────────────────────────────────
async function getOTP() {
  const res = await fetch(
    `https://api.derivws.com/trading/v1/options/accounts/${DERIV_ACCOUNT_ID}/otp`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DERIV_TOKEN}`,
        'Deriv-App-ID':  APP_ID,
        'Content-Type':  'application/json'
      }
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OTP HTTP ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (!json.data?.url) throw new Error('OTP sem URL: ' + JSON.stringify(json));
  return json.data.url;
}

async function loadHistory() {
  const res = await sendWS({
    ticks_history: SYMBOL,
    adjust_start_time: 1,
    count:       500,
    end:         'latest',
    granularity: GRANULARITY,
    style:       'candles'
  });

  candleCache = (res.candles || []).map(c => ({
    time:  parseInt(c.epoch),
    open:  parseFloat(c.open),
    high:  parseFloat(c.high),
    low:   parseFloat(c.low),
    close: parseFloat(c.close)
  }));

  isWarmingUp = false;
  log(`Warm-up: ${candleCache.length} candles carregados para ${SYMBOL}`, 'system');
}

async function subscribeCandles() {
  await sendWS({
    ticks_history: SYMBOL,
    count:         1,
    end:           'latest',
    granularity:   GRANULARITY,
    style:         'candles',
    subscribe:     1
  });
  log(`Subscrito a candles ${SYMBOL} (${TIMEFRAME})`, 'system');
}

async function subscribeBalance() {
  await sendWS({ balance: 1, subscribe: 1 });
  log('Balance subscrito', 'system');
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connectWS() {
  log('Obtendo OTP Deriv...', 'system');
  let wsUrl;
  try {
    wsUrl = await getOTP();
  } catch (e) {
    log(`Erro OTP: ${e.message}. Tentando em 10s...`, 'error');
    setTimeout(connectWS, 10000);
    return;
  }

  log(`Conectando ao Deriv WebSocket (nova API)...`, 'system');
  ws = new WebSocket(wsUrl);

  ws.on('open', async () => {
    log('WebSocket conectado', 'system');
    wsReady = true;
    try {
      await loadHistory();
      await subscribeCandles();
    } catch (e) {
      log(`Erro crítico WS: ${e.message}`, 'error');
      return;
    }
    // Balance subscription é opcional — não bloqueia o restante
    subscribeBalance().catch(e => log(`Balance subscription: ${e.message}`, 'warning'));
    if (!httpStarted) { startHttpServer(); httpStarted = true; }
  });

  ws.on('message', (data) => handleMessage(data));

  ws.on('close', () => {
    wsReady = false;
    log('WebSocket desconectado. Reconectando em 5s...', 'warning');
    msgHandlers.forEach(({ reject }) => reject(new Error('WS disconnected')));
    msgHandlers.clear();
    setTimeout(connectWS, 5000);
  });

  ws.on('error', (err) => log(`WebSocket error: ${err.message}`, 'error'));
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
function startHttpServer() {
  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url.split('?')[0];
    if (url === '/status') {
      const last = candleCache[candleCache.length - 1];
      res.writeHead(200);
      res.end(JSON.stringify({
        broker:       'Deriv',
        accountId:    DERIV_ACCOUNT_ID,
        symbol:       SYMBOL,
        timeframe:    TIMEFRAME,
        currentPrice: last?.close ?? null,
        equity:       parseFloat(equity.toFixed(2)),
        dailyPnL:     parseFloat(dailyPnL.toFixed(2)),
        position,
        isWarmingUp,
        wsReady,
        config: { SMA_PERIOD, SLOPE_THRESHOLD, SL_POINTS, TRAILING_BUFFER, TP1_RATIO, TP1_CLOSE_PERC, MULTIPLIER, STAKE, RISK_PERC, DAILY_LOSS_PERC }
      }));
      return;
    }
    if (url === '/trades')  { res.writeHead(200); res.end(JSON.stringify(trades));      return; }
    if (url === '/logs')    { res.writeHead(200); res.end(JSON.stringify(logs));        return; }
    if (url === '/candles') { res.writeHead(200); res.end(JSON.stringify(candleCache)); return; }

    // Endpoint de teste — força entrada manual (apenas demo)
    if (url.startsWith('/force-trade')) {
      if (!wsReady || candleCache.length < 2) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Robot not ready' })); return;
      }
      if (position) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Position already open', position })); return;
      }
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const side = params.get('side') === 'sell' ? 'sell' : 'buy';
      res.writeHead(200); res.end(JSON.stringify({ ok: true, message: `Forcing ${side} entry...` }));
      enterTrade(side).catch(e => log(`force-trade error: ${e.message}`, 'error'));
      return;
    }

    // Endpoint de teste — fecha posição atual
    if (url === '/force-close') {
      if (!position) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'No open position' })); return;
      }
      res.writeHead(200); res.end(JSON.stringify({ ok: true, message: 'Closing position...' }));
      sendWS({ sell: position.contractId, price: 0 })
        .then(r => {
          const pl = parseFloat(r.sell?.sold_for || 0) - position.currentStake;
          equity += pl; dailyPnL += pl;
          saveTrade({ id: `manual_close_${Date.now()}`, timestamp: Date.now(), datetime: new Date().toISOString(), side: position.side === 'buy' ? 'sell' : 'buy', type: 'manual_close', price: candleCache[candleCache.length-1]?.close, pnl: pl });
          log(`Posição fechada manualmente. PnL: $${pl.toFixed(2)}`, 'system');
          position = null;
        })
        .catch(e => log(`force-close error: ${e.message}`, 'error'));
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  });
  server.listen(PORT, () => log(`Servidor HTTP na porta ${PORT}`, 'system'));
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function main() {
  log(`=== XAU/USD Deriv Robot v4.0 ===`, 'system');
  log(`${SYMBOL} ${TIMEFRAME} | Mult: ${MULTIPLIER}x | Stake: $${STAKE} | Conta: ${DERIV_ACCOUNT_ID}`, 'system');
  rebuildEquity();
  await connectWS();
}

main().catch(e => { console.error('Erro fatal:', e); process.exit(1); });

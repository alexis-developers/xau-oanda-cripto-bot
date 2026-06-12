import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import WebSocket from 'ws';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─── Credenciais (apenas via .env — nunca editáveis pela web) ─────────────────
const DERIV_TOKEN      = process.env.DERIV_TOKEN;
const DERIV_ACCOUNT_ID = process.env.DERIV_ACCOUNT_ID || 'DOT93096841';
const APP_ID           = process.env.DERIV_APP_ID     || '33v8gypvQ2TA7ORg5HNfb';
const PORT             = parseInt(process.env.PORT    || '8000');

if (!DERIV_TOKEN) {
  console.error('FATAL: DERIV_TOKEN é obrigatório no .env');
  process.exit(1);
}

// ─── Configuração Dinâmica (estilo ProfitTrailer) ─────────────────────────────
// Prioridade: config.json (web) > .env > defaults
// Schema: validação de tipo/limites + flag de reconexão quando aplicável
const CONFIG_FILE = join(ROOT, 'config.json');

const CONFIG_SCHEMA = {
  TRADING_ENABLED: { type: 'boolean', label: 'Trading Ativo' },
  SYMBOL:          { type: 'string',  reconnect: true },
  TIMEFRAME:       { type: 'string',  enum: ['M1','M5','M15','M30','H1','H4','D1'], reconnect: true },
  MULTIPLIER:      { type: 'number',  min: 1,   max: 1000, int: true },
  STAKE:           { type: 'number',  min: 1,   max: 2000 },
  CAPITAL_TOTAL:   { type: 'number',  min: 1,   max: 100000000 },
  RISK_PERC:       { type: 'number',  min: 0.1, max: 100 },
  DAILY_LOSS_PERC: { type: 'number',  min: 0.1, max: 100 },
  SMA_PERIOD:      { type: 'number',  min: 2,   max: 200, int: true },
  SLOPE_THRESHOLD: { type: 'number',  min: 0,   max: 1000 },
  SL_POINTS:       { type: 'number',  min: 0.1, max: 1000 },
  TRAILING_BUFFER: { type: 'number',  min: 0,   max: 1000 },
  TP1_RATIO:       { type: 'number',  min: 0.5, max: 20 },
  TP1_CLOSE_PERC:  { type: 'number',  min: 0,   max: 100 },
  WEBHOOK_URL:     { type: 'string' },
};

const DEFAULTS = {
  TRADING_ENABLED: true,
  SYMBOL:          'frxXAUUSD',
  TIMEFRAME:       'M15',
  MULTIPLIER:      100,
  STAKE:           10,
  CAPITAL_TOTAL:   10000,
  RISK_PERC:       1,
  DAILY_LOSS_PERC: 5,
  SMA_PERIOD:      20,
  SLOPE_THRESHOLD: 0.5,
  SL_POINTS:       2.0,
  TRAILING_BUFFER: 0.5,
  TP1_RATIO:       2.0,
  TP1_CLOSE_PERC:  80,
  WEBHOOK_URL:     '',
};

function envOverrides() {
  const out = {};
  for (const key of Object.keys(CONFIG_SCHEMA)) {
    const raw = process.env[key];
    if (raw === undefined || raw === '') continue;
    const spec = CONFIG_SCHEMA[key];
    if (spec.type === 'number')       out[key] = parseFloat(raw);
    else if (spec.type === 'boolean') out[key] = raw.toLowerCase() === 'true';
    else                              out[key] = raw;
  }
  return out;
}

function loadFileConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
}

let CFG = { ...DEFAULTS, ...envOverrides(), ...loadFileConfig() };

function saveConfig() {
  writeFileSync(CONFIG_FILE, JSON.stringify(CFG, null, 2));
}

// Valida e aplica updates. Retorna { ok, errors, reconnectRequired }
function applyConfigUpdate(updates) {
  const errors = {};
  const clean  = {};
  let reconnectRequired = false;

  for (const [key, value] of Object.entries(updates)) {
    const spec = CONFIG_SCHEMA[key];
    if (!spec) { errors[key] = 'Campo desconhecido'; continue; }

    let v = value;
    if (spec.type === 'number') {
      v = typeof v === 'string' ? parseFloat(v) : v;
      if (typeof v !== 'number' || isNaN(v)) { errors[key] = 'Número inválido'; continue; }
      if (spec.int) v = Math.round(v);
      if (spec.min !== undefined && v < spec.min) { errors[key] = `Mínimo: ${spec.min}`; continue; }
      if (spec.max !== undefined && v > spec.max) { errors[key] = `Máximo: ${spec.max}`; continue; }
    } else if (spec.type === 'boolean') {
      v = v === true || v === 'true';
    } else {
      v = String(v).trim();
      if (spec.enum && !spec.enum.includes(v)) { errors[key] = `Valores: ${spec.enum.join(', ')}`; continue; }
    }

    if (CFG[key] !== v) {
      clean[key] = v;
      if (spec.reconnect) reconnectRequired = true;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const capitalChanged = clean.CAPITAL_TOTAL !== undefined;
  Object.assign(CFG, clean);
  saveConfig();

  if (capitalChanged) rebuildEquity();

  if (reconnectRequired) {
    log(`Config: símbolo/timeframe alterado → reconectando (${CFG.SYMBOL} ${CFG.TIMEFRAME})`, 'system');
    candleCache   = [];
    formingCandle = null;
    isWarmingUp   = true;
    try { ws?.close(); } catch {} // close dispara o fluxo de reconexão com novo OTP
  }

  if (Object.keys(clean).length > 0) {
    log(`Config atualizada via painel: ${Object.keys(clean).join(', ')}`, 'system');
  }

  return { ok: true, applied: clean, reconnectRequired };
}

// Deriv granularity (seconds)
const GRAN_MAP = { M1:60, M5:300, M15:900, M30:1800, H1:3600, H4:14400, D1:86400 };
const granularity = () => GRAN_MAP[CFG.TIMEFRAME] || 900;

const TRADES_FILE = join(ROOT, 'trades.json');

// ─── State ────────────────────────────────────────────────────────────────────
let logs          = [];
let trades        = [];
let equity        = CFG.CAPITAL_TOTAL;
let dailyPnL      = 0;
let dailyDate     = new Date().toDateString();
let isWarmingUp   = true;
let candleCache   = [];
let formingCandle = null;

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
  if (!CFG.WEBHOOK_URL) return;
  try {
    await fetch(CFG.WEBHOOK_URL, {
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
  equity = CFG.CAPITAL_TOTAL;
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
  if (candles.length < CFG.SMA_PERIOD + 5) return null;
  const closes  = candles.map(c => c.close);
  const sma     = calcSMA(closes, CFG.SMA_PERIOD);
  const n       = candles.length;
  const smaNow  = sma[n - 1], smaPrev = sma[n - 2], sma3 = sma[n - 4];
  if (!smaNow || !smaPrev || !sma3) return null;
  const trigger = candles[n - 1], pivot = candles[n - 2];
  const slope   = smaNow - sma3;
  const up      = slope >  CFG.SLOPE_THRESHOLD;
  const down    = slope < -CFG.SLOPE_THRESHOLD;
  if (up   && pivot.low  <= smaPrev && trigger.close > trigger.open && trigger.high > pivot.high) return 'buy';
  if (down && pivot.high >= smaPrev && trigger.close < trigger.open && trigger.low  < pivot.low)  return 'sell';
  return null;
}

// ─── Risk Manager ─────────────────────────────────────────────────────────────
function priceToUSD(stake, mult, entryPrice, priceDistance) {
  return parseFloat((stake * mult * Math.abs(priceDistance) / entryPrice).toFixed(2));
}

function calcSLPrice(side, pivot) {
  return side === 'buy' ? pivot.low - CFG.SL_POINTS : pivot.high + CFG.SL_POINTS;
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
  return dailyPnL <= -(equity * CFG.DAILY_LOSS_PERC / 100);
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
    sendWebhook(`**SAÍDA (SL)** ${CFG.SYMBOL} | PnL: $${pl.toFixed(2)} | Equity: $${equity.toFixed(2)}`);
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

  if (!CFG.TRADING_ENABLED) return;

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
    ? trigger.close + slDist * CFG.TP1_RATIO
    : trigger.close - slDist * CFG.TP1_RATIO;

  const slAmount  = priceToUSD(CFG.STAKE, CFG.MULTIPLIER, trigger.close, slDist);
  const tp1Amount = priceToUSD(CFG.STAKE, CFG.MULTIPLIER, trigger.close, slDist * CFG.TP1_RATIO);
  const contractType = signal === 'buy' ? 'MULTUP' : 'MULTDOWN';

  log(`SINAL ${signal.toUpperCase()} | SL: ${slPrice.toFixed(2)} ($${slAmount}) | TP1: ${tp1Price.toFixed(2)} ($${tp1Amount})`, 'system');

  try {
    // Nova API Deriv: proposal → buy (2 passos)
    const proposalRes = await sendWS({
      proposal:          1,
      contract_type:     contractType,
      currency:          'USD',
      underlying_symbol: CFG.SYMBOL,
      amount:            CFG.STAKE,
      basis:             'stake',
      multiplier:        CFG.MULTIPLIER,
      limit_order: {
        stop_loss:   slAmount,
        take_profit: parseFloat((tp1Amount * (CFG.TP1_CLOSE_PERC / 100)).toFixed(2))
      }
    });
    const proposalId = proposalRes.proposal?.id;
    if (!proposalId) throw new Error('Proposal sem ID: ' + JSON.stringify(proposalRes));

    const result = await sendWS({ buy: proposalId, price: CFG.STAKE * 2 });

    const contract   = result.buy;
    const contractId = contract.contract_id;
    // buy_price na nova API Deriv é o stake, não o preço de mercado
    const entryPrice = trigger.close;

    position = {
      contractId,
      side:         signal,
      contractType,
      fullStake:    CFG.STAKE,
      currentStake: CFG.STAKE,
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
      stake:     CFG.STAKE,
      sl:        slPrice,
      tp1:       tp1Price,
      pnl:       null
    });

    await sendWebhook(
      `**ENTRADA ${signal.toUpperCase()} ${CFG.SYMBOL}**\n` +
      `Preço: ${entryPrice} | SL: ${slPrice.toFixed(2)} | TP1: ${tp1Price.toFixed(2)}\n` +
      `Stake: $${CFG.STAKE} | Mult: ${CFG.MULTIPLIER}x | SL: $${slAmount} | Equity: $${equity.toFixed(2)}`
    );
    log(`Contrato aberto: ${contractId} @ ${entryPrice}`, 'info');

  } catch (e) {
    log(`Erro ao abrir contrato: ${e.message}`, 'error');
    await sendWebhook(`**ERRO** ${signal.toUpperCase()} ${CFG.SYMBOL}: ${e.message}`);
  }
}

async function managePosition() {
  if (!position) return;

  const n            = candleCache.length;
  const currentPrice = candleCache[n - 1].close;
  const prevCandle   = candleCache[n - 2];

  // ── TP1: fechar contrato e reabrir com a fração restante ──────────────────
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

        log(`TP1 atingido! PnL: $${pl.toFixed(2)}. Reabrindo ${100 - CFG.TP1_CLOSE_PERC}%...`, 'system');

        const trailStake = parseFloat((position.fullStake * (1 - CFG.TP1_CLOSE_PERC / 100)).toFixed(2));
        if (trailStake < 1) {
          // Deriv exige stake mínimo de $1 — sem trailing se a fração for menor
          log('Fração de trailing abaixo do stake mínimo ($1). Posição encerrada no TP1.', 'warning');
          position = null;
          return;
        }
        const beSlDist   = 0.01;
        const beSlAmount = priceToUSD(trailStake, CFG.MULTIPLIER, currentPrice, beSlDist);

        await sleep(1000);
        const prop2 = await sendWS({
          proposal:          1,
          contract_type:     position.contractType,
          currency:          'USD',
          underlying_symbol: CFG.SYMBOL,
          amount:            trailStake,
          basis:             'stake',
          multiplier:        CFG.MULTIPLIER,
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
          entryPrice:   currentPrice,
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
          `**TP1 ${CFG.SYMBOL}** | PnL: +$${pl.toFixed(2)}\n` +
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
      newSLPrice = prevCandle.low - CFG.TRAILING_BUFFER;
      if (newSLPrice <= position.sl) return;
    } else {
      newSLPrice = prevCandle.high + CFG.TRAILING_BUFFER;
      if (newSLPrice >= position.sl) return;
    }

    const slDist      = Math.abs(position.entryPrice - newSLPrice);
    const newSLAmount = priceToUSD(position.currentStake, CFG.MULTIPLIER, position.entryPrice, slDist);

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
    ticks_history: CFG.SYMBOL,
    adjust_start_time: 1,
    count:       500,
    end:         'latest',
    granularity: granularity(),
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
  log(`Warm-up: ${candleCache.length} candles carregados para ${CFG.SYMBOL}`, 'system');
}

async function subscribeCandles() {
  await sendWS({
    ticks_history: CFG.SYMBOL,
    count:         1,
    end:           'latest',
    granularity:   granularity(),
    style:         'candles',
    subscribe:     1
  });
  log(`Subscrito a candles ${CFG.SYMBOL} (${CFG.TIMEFRAME})`, 'system');
}

async function subscribeBalance() {
  await sendWS({ balance: 1, subscribe: 1 });
  log('Balance subscrito', 'system');
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Re-tenta a subscrição quando o mercado está fechado (fim de semana, feriados)
let subRetryTimer = null;
function trySubscribeCandles() {
  clearTimeout(subRetryTimer);
  subscribeCandles().catch(e => {
    log(`Subscrição de candles falhou: ${e.message} — nova tentativa em 5 min`, 'warning');
    subRetryTimer = setTimeout(() => {
      if (wsReady) trySubscribeCandles();
    }, 5 * 60 * 1000);
  });
}

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
    } catch (e) {
      log(`Histórico falhou: ${e.message}`, 'error');
    }
    // Mercado fechado não é fatal — re-tenta até abrir
    trySubscribeCandles();
    subscribeBalance().catch(e => log(`Balance subscription: ${e.message}`, 'warning'));
  });

  ws.on('message', (data) => handleMessage(data));

  ws.on('close', () => {
    wsReady = false;
    clearTimeout(subRetryTimer);
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url.split('?')[0];

    if (url === '/status') {
      const last = candleCache[candleCache.length - 1];
      res.writeHead(200);
      res.end(JSON.stringify({
        broker:       'Deriv',
        accountId:    DERIV_ACCOUNT_ID,
        symbol:       CFG.SYMBOL,
        timeframe:    CFG.TIMEFRAME,
        currentPrice: last?.close ?? null,
        equity:       parseFloat(equity.toFixed(2)),
        dailyPnL:     parseFloat(dailyPnL.toFixed(2)),
        position,
        isWarmingUp,
        wsReady,
        tradingEnabled: CFG.TRADING_ENABLED,
        config: CFG
      }));
      return;
    }

    if (url === '/config') {
      if (req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ config: CFG, schema: CONFIG_SCHEMA }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
        req.on('end', () => {
          let updates;
          try { updates = JSON.parse(body); }
          catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'JSON inválido' })); return; }
          const result = applyConfigUpdate(updates);
          res.writeHead(result.ok ? 200 : 400);
          res.end(JSON.stringify({ ...result, config: CFG }));
        });
        return;
      }
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
  log(`=== XAU/USD Deriv Robot v5.0 — Config Dinâmica ===`, 'system');
  log(`${CFG.SYMBOL} ${CFG.TIMEFRAME} | Mult: ${CFG.MULTIPLIER}x | Stake: $${CFG.STAKE} | Trading: ${CFG.TRADING_ENABLED ? 'ON' : 'OFF'} | Conta: ${DERIV_ACCOUNT_ID}`, 'system');
  rebuildEquity();
  // HTTP primeiro: painel funciona mesmo com mercado fechado ou WS em falha
  startHttpServer();
  await connectWS();
}

main().catch(e => { console.error('Erro fatal:', e); process.exit(1); });

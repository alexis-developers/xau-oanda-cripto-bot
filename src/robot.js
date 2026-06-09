import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─── Config ───────────────────────────────────────────────────────────────────
const API_KEY       = process.env.CAPITAL_API_KEY;
const EMAIL         = process.env.CAPITAL_EMAIL;
const API_PASS      = process.env.CAPITAL_PASS;
const USE_DEMO      = process.env.CAPITAL_USE_DEMO !== 'false';
const BASE_URL      = USE_DEMO
  ? 'https://demo-api-capital.backend-capital.com/'
  : 'https://api-capital.backend-capital.com/';

const EPIC          = process.env.EPIC          || 'GOLD';
const TIMEFRAME     = process.env.TIMEFRAME     || 'M15';
const CAPITAL_TOTAL = parseFloat(process.env.CAPITAL_TOTAL   || '10000');
const RISK_PERC     = parseFloat(process.env.RISK_PERC       || '1');
const SMA_PERIOD    = parseInt(process.env.SMA_PERIOD        || '20');
const SLOPE_THRESHOLD= parseFloat(process.env.SLOPE_THRESHOLD|| '0.5');
const SL_POINTS     = parseFloat(process.env.SL_POINTS       || '2.0');
const TRAILING_BUFFER= parseFloat(process.env.TRAILING_BUFFER|| '0.5');
const TP1_RATIO     = parseFloat(process.env.TP1_RATIO       || '2.0');
const TP1_CLOSE_PERC= parseFloat(process.env.TP1_CLOSE_PERC  || '80');
const DAILY_LOSS_PERC= parseFloat(process.env.DAILY_LOSS_PERC|| '5');
const SIZE_FACTOR   = parseFloat(process.env.SIZE_FACTOR     || '1.0');
const MIN_SIZE      = parseFloat(process.env.MIN_SIZE        || '0.1');
const PORT          = parseInt(process.env.PORT              || '8000');
const WEBHOOK_URL   = process.env.WEBHOOK_URL || '';

// Timeframe mapping: M15 → MINUTE_15 (Capital.com format)
const TF_MAP = {
  M1: 'MINUTE', M5: 'MINUTE_5', M15: 'MINUTE_15',
  M30: 'MINUTE_30', H1: 'HOUR', H4: 'HOUR_4', D1: 'DAY', W1: 'WEEK'
};
const TF_MINUTES_MAP = {
  MINUTE: 1, MINUTE_5: 5, MINUTE_15: 15, MINUTE_30: 30,
  HOUR: 60, HOUR_4: 240, DAY: 1440, WEEK: 10080
};
const RESOLUTION  = TF_MAP[TIMEFRAME] || 'MINUTE_15';
const TF_MINUTES  = TF_MINUTES_MAP[RESOLUTION] || 15;

const TRADES_FILE = join(ROOT, 'trades.json');

if (!API_KEY || !EMAIL || !API_PASS) {
  console.error('FATAL: CAPITAL_API_KEY, CAPITAL_EMAIL e CAPITAL_PASS são obrigatórios no .env');
  process.exit(1);
}

// ─── State ────────────────────────────────────────────────────────────────────
let logs         = [];
let trades       = [];
let equity       = CAPITAL_TOTAL;
let dailyPnL     = 0;
let dailyDate    = new Date().toDateString();
let isWarmingUp  = true;
let lastCandleTime = null;
let candleCache  = [];

// Active position (null = flat)
// Estratégia de saída em 2 fases:
//   Fase 1: posição completa até TP1
//   Fase 2: fecha posição, reabre com 20% do size original + SL em breakeven + trailing
let position = null;
// {
//   dealId:       string,
//   side:         'buy'|'sell',
//   fullSize:     number,   — tamanho original (100%)
//   currentSize:  number,   — tamanho atual (100% → 20% após TP1)
//   entryPrice:   number,
//   sl:           number,
//   tp1Price:     number,
//   tp1Hit:       boolean,
//   isBreakeven:  boolean
// }

// ─── Session ──────────────────────────────────────────────────────────────────
let session = { cst: null, securityToken: null, lastRefresh: 0 };

async function createSession() {
  const res = await fetch(`${BASE_URL}api/v1/session`, {
    method: 'POST',
    headers: { 'X-CAP-API-KEY': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: EMAIL, password: API_PASS, encryptedPassword: false })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Falha na sessão Capital.com (${res.status}): ${err}`);
  }
  session.cst           = res.headers.get('CST');
  session.securityToken = res.headers.get('X-SECURITY-TOKEN');
  session.lastRefresh   = Date.now();
  log('Sessão Capital.com iniciada', 'system');
}

async function ensureSession() {
  // Renova sessão a cada 8 minutos (expira em 10)
  if (!session.cst || Date.now() - session.lastRefresh > 8 * 60 * 1000) {
    await createSession();
  }
}

// ─── Capital.com REST API ─────────────────────────────────────────────────────
async function capitalRequest(method, path, body = null) {
  await ensureSession();
  const opts = {
    method,
    headers: {
      'X-CAP-API-KEY':    API_KEY,
      'CST':              session.cst,
      'X-SECURITY-TOKEN': session.securityToken,
      'Content-Type':     'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}api/v1${path}`, opts);

  // A Capital.com atualiza os tokens a cada resposta
  if (res.headers.get('CST'))              session.cst           = res.headers.get('CST');
  if (res.headers.get('X-SECURITY-TOKEN')) session.securityToken = res.headers.get('X-SECURITY-TOKEN');
  session.lastRefresh = Date.now();

  // DELETE /positions retorna 200 sem body
  if (res.status === 200 && res.headers.get('content-length') === '0') return {};

  const data = await res.json();
  if (!res.ok) throw new Error(`Capital.com ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// ─── Market Data ──────────────────────────────────────────────────────────────
function parseCapTime(str) {
  // "2024/01/15 14:30:00" → Unix segundos (UTC)
  return Math.floor(new Date(str.replace(/\//g, '-').replace(' ', 'T') + 'Z').getTime() / 1000);
}

async function getCandles(count = 500) {
  const data = await capitalRequest('GET', `/prices/${EPIC}?resolution=${RESOLUTION}&max=${Math.min(count, 1000)}`);
  const nowSecs = Date.now() / 1000;

  return data.prices
    .map(p => {
      const time = parseCapTime(p.snapshotTimeUTC);
      return {
        time,
        open:   (p.openPrice.bid  + p.openPrice.ask)  / 2,
        high:   (p.highPrice.bid  + p.highPrice.ask)  / 2,
        low:    (p.lowPrice.bid   + p.lowPrice.ask)   / 2,
        close:  (p.closePrice.bid + p.closePrice.ask) / 2,
        volume: p.lastTradedVolume || 0
      };
    })
    // Filtra candle atual em formação
    .filter(c => c.time + TF_MINUTES * 60 < nowSecs);
}

async function getAccountBalance() {
  const data = await capitalRequest('GET', '/accounts');
  const acc  = data.accounts.find(a => a.preferred) || data.accounts[0];
  return parseFloat(acc?.balance?.available ?? 0);
}

// ─── Order Execution ──────────────────────────────────────────────────────────
async function placeOrder(side, size, slPrice) {
  const body = {
    epic:          EPIC,
    direction:     side.toUpperCase(),
    size:          parseFloat(size.toFixed(2)),
    guaranteedStop: false,
    stopLevel:     parseFloat(slPrice.toFixed(3))
  };

  const result = await capitalRequest('POST', '/positions', body);

  // Aguarda processamento antes de confirmar
  await sleep(800);
  const confirm = await capitalRequest('GET', `/confirms/${result.dealReference}`);

  if (confirm.status !== 'OPEN' && confirm.reason !== 'SUCCESS') {
    throw new Error(`Ordem não aberta: ${JSON.stringify(confirm)}`);
  }

  return {
    dealId:     confirm.dealId,
    entryPrice: parseFloat(confirm.level),
    size:       parseFloat(confirm.size)
  };
}

async function modifyStopLoss(dealId, newSl) {
  return capitalRequest('PUT', `/positions/${dealId}`, {
    stopLevel: parseFloat(newSl.toFixed(3))
  });
}

async function closePositionDeal(dealId) {
  return capitalRequest('DELETE', `/positions/${dealId}`);
}

async function getOpenPosition(dealId) {
  try {
    const data = await capitalRequest('GET', '/positions');
    return data.positions?.find(p => p.position.dealId === dealId) ?? null;
  } catch {
    return null;
  }
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
// SMA 20 Trend Following com Pullback + Price Action
function detectSignal(candles) {
  if (candles.length < SMA_PERIOD + 5) return null;

  const closes = candles.map(c => c.close);
  const sma    = calcSMA(closes, SMA_PERIOD);
  const n      = candles.length;

  const smaNow   = sma[n - 1];
  const smaPrev  = sma[n - 2];
  const sma3Bars = sma[n - 4];

  if (!smaNow || !smaPrev || !sma3Bars) return null;

  const trigger = candles[n - 1];
  const pivot   = candles[n - 2];

  const slope     = smaNow - sma3Bars;
  const uptrend   = slope >  SLOPE_THRESHOLD;
  const downtrend = slope < -SLOPE_THRESHOLD;

  const touchedLow  = pivot.low  <= smaPrev;
  const touchedHigh = pivot.high >= smaPrev;

  const bullClose  = trigger.close > trigger.open;
  const bearClose  = trigger.close < trigger.open;
  const longEntry  = bullClose && trigger.high > pivot.high;
  const shortEntry = bearClose && trigger.low  < pivot.low;

  if (uptrend   && touchedLow  && longEntry)  return 'buy';
  if (downtrend && touchedHigh && shortEntry) return 'sell';
  return null;
}

// ─── Risk Manager ─────────────────────────────────────────────────────────────
function calcSize(entryPrice, slPrice) {
  const riskAmount = equity * (RISK_PERC / 100);
  const slDist     = Math.abs(entryPrice - slPrice);
  if (slDist < 0.001) return 0;
  const raw = (riskAmount / slDist) / SIZE_FACTOR;
  return Math.max(MIN_SIZE, parseFloat(raw.toFixed(1)));
}

function calcSLPrice(side, pivot) {
  return side === 'buy'
    ? pivot.low  - SL_POINTS
    : pivot.high + SL_POINTS;
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

// ─── Logging & Webhook ────────────────────────────────────────────────────────
function log(msg, level = 'info') {
  const prefix = { info: '[INFO]', warning: '[WARNING]', error: '[ERROR]', system: '===' }[level] || '[INFO]';
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

// ─── Trade Execution ──────────────────────────────────────────────────────────
async function enterTrade(signal, candles) {
  if (position) return;

  const n       = candles.length;
  const pivot   = candles[n - 2];
  const trigger = candles[n - 1];
  const slPrice = calcSLPrice(signal, pivot);
  const estSize = calcSize(trigger.close, slPrice);

  if (estSize < MIN_SIZE) {
    log(`Tamanho muito pequeno (${estSize}). Pulando entrada.`, 'warning');
    return;
  }

  const slDist   = Math.abs(trigger.close - slPrice);
  const tp1Price = signal === 'buy'
    ? trigger.close + slDist * TP1_RATIO
    : trigger.close - slDist * TP1_RATIO;

  log(`SINAL ${signal.toUpperCase()} | Est. Entrada: ${trigger.close.toFixed(3)} | SL: ${slPrice.toFixed(3)} | TP1: ${tp1Price.toFixed(3)} | Size: ${estSize}`, 'system');

  try {
    const fill = await placeOrder(signal, estSize, slPrice);

    // Recalcula TP1 com preço real de entrada
    const actualSlDist = Math.abs(fill.entryPrice - slPrice);
    const actualTp1    = signal === 'buy'
      ? fill.entryPrice + actualSlDist * TP1_RATIO
      : fill.entryPrice - actualSlDist * TP1_RATIO;

    position = {
      dealId:      fill.dealId,
      side:        signal,
      fullSize:    fill.size,
      currentSize: fill.size,
      entryPrice:  fill.entryPrice,
      sl:          slPrice,
      tp1Price:    actualTp1,
      tp1Hit:      false,
      isBreakeven: false
    };

    saveTrade({
      id:        fill.dealId,
      timestamp: Date.now(),
      datetime:  new Date().toISOString(),
      side:      signal,
      type:      'entry',
      price:     fill.entryPrice,
      size:      fill.size,
      sl:        slPrice,
      tp1:       actualTp1,
      pnl:       null
    });

    await sendWebhook(
      `**ENTRADA ${signal.toUpperCase()} ${EPIC}**\n` +
      `Preço: ${fill.entryPrice} | SL: ${slPrice.toFixed(3)} | TP1: ${actualTp1.toFixed(3)}\n` +
      `Size: ${fill.size} | Equity: $${equity.toFixed(2)}`
    );
    log(`Posição aberta: Deal ${fill.dealId} @ ${fill.entryPrice}`, 'info');

  } catch (e) {
    log(`Erro ao abrir ordem: ${e.message}`, 'error');
    await sendWebhook(`**ERRO** ao abrir ${signal.toUpperCase()} ${EPIC}: ${e.message}`);
  }
}

async function managePosition(candles) {
  if (!position) return;

  const openPos = await getOpenPosition(position.dealId);

  // Posição fechada externamente (SL atingido ou fechamento manual)
  if (!openPos) {
    log(`Posição ${position.dealId} fechada externamente`, 'system');

    const closedPl = 0; // sem PnL real disponível aqui — atualiza equity no próximo /accounts
    try {
      const bal = await getAccountBalance();
      const pl  = bal - equity;
      equity    = bal;
      dailyPnL += pl;
      log(`PnL estimado: $${pl.toFixed(2)} | Equity: $${equity.toFixed(2)}`, 'info');
      await sendWebhook(`**SAÍDA (SL/Manual)** ${EPIC} | Equity: $${equity.toFixed(2)}`);
    } catch {}

    saveTrade({
      id:        `close_${Date.now()}`,
      timestamp: Date.now(),
      datetime:  new Date().toISOString(),
      side:      position.side === 'buy' ? 'sell' : 'buy',
      type:      'stop_loss',
      price:     0,
      size:      position.currentSize,
      pnl:       null
    });

    position = null;
    return;
  }

  const n            = candles.length;
  const currentPrice = candles[n - 1].close;
  const prevCandle   = candles[n - 2];

  // ── TP1: fecha posição atual e reabre com 20% + breakeven ─────────────────
  if (!position.tp1Hit) {
    const tp1Reached = position.side === 'buy'
      ? currentPrice >= position.tp1Price
      : currentPrice <= position.tp1Price;

    if (tp1Reached) {
      try {
        await closePositionDeal(position.dealId);

        // PnL estimado do fechamento no TP1
        const slDist     = Math.abs(position.entryPrice - position.sl);
        const estimatedPl = slDist * TP1_RATIO * position.currentSize;
        equity   += estimatedPl;
        dailyPnL += estimatedPl;

        saveTrade({
          id:        `tp1_${Date.now()}`,
          timestamp: Date.now(),
          datetime:  new Date().toISOString(),
          side:      position.side === 'buy' ? 'sell' : 'buy',
          type:      'tp1_close',
          price:     position.tp1Price,
          size:      position.currentSize,
          pnl:       estimatedPl
        });

        log(`TP1 atingido! Posição fechada. PnL est.: $${estimatedPl.toFixed(2)}`, 'system');

        // Reabre 20% com SL em breakeven
        const trailSize = Math.max(MIN_SIZE, parseFloat((position.fullSize * (1 - TP1_CLOSE_PERC / 100)).toFixed(2)));
        const beSL      = position.entryPrice;

        await sleep(1000);
        const fill2 = await placeOrder(position.side, trailSize, beSL);

        position = {
          dealId:      fill2.dealId,
          side:        position.side,
          fullSize:    position.fullSize,
          currentSize: fill2.size,
          entryPrice:  fill2.entryPrice,
          sl:          beSL,
          tp1Price:    position.tp1Price,
          tp1Hit:      true,
          isBreakeven: true
        };

        log(`Trailing aberto: Deal ${fill2.dealId} | Size: ${fill2.size} | SL (BE): ${beSL.toFixed(3)}`, 'info');
        await sendWebhook(
          `**TP1 ${EPIC}** | PnL est.: +$${estimatedPl.toFixed(2)}\n` +
          `Trailing aberto (${trailSize} units) com SL em breakeven`
        );

      } catch (e) {
        log(`Erro no TP1: ${e.message}`, 'error');
      }
      return;
    }
  }

  // ── Trailing stop (após TP1, na posição reaberta) ─────────────────────────
  if (position.tp1Hit && position.currentSize > 0) {
    let newSl;
    if (position.side === 'buy') {
      newSl = prevCandle.low - TRAILING_BUFFER;
      if (newSl <= position.sl) return;
    } else {
      newSl = prevCandle.high + TRAILING_BUFFER;
      if (newSl >= position.sl) return;
    }

    try {
      await modifyStopLoss(position.dealId, newSl);
      log(`Trailing SL: ${position.sl.toFixed(3)} → ${newSl.toFixed(3)}`, 'info');
      position.sl = newSl;
    } catch (e) {
      log(`Erro no trailing SL: ${e.message}`, 'error');
    }
  }
}

// ─── Daily Reset & Circuit Breaker ───────────────────────────────────────────
function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== dailyDate) {
    log(`Novo dia. PnL anterior: $${dailyPnL.toFixed(2)}`, 'system');
    dailyPnL  = 0;
    dailyDate = today;
  }
}

function isDailyLimitHit() {
  return dailyPnL <= -(equity * DAILY_LOSS_PERC / 100);
}

// ─── Main Loop ────────────────────────────────────────────────────────────────
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tick() {
  try {
    checkDailyReset();

    const fetchCount = isWarmingUp ? 500 : 50;
    const candles    = await getCandles(fetchCount);

    if (!candles.length) { log('Sem candles retornados', 'warning'); return; }

    candleCache = isWarmingUp ? candles : [...candleCache.slice(-490), ...candles.slice(-10)];

    if (isWarmingUp) {
      isWarmingUp    = false;
      lastCandleTime = candles[candles.length - 1].time;
      log(`Warm-up concluído. ${candles.length} candles carregados.`, 'system');
      return;
    }

    const latestTime = candles[candles.length - 1].time;
    if (latestTime === lastCandleTime) return;
    lastCandleTime = latestTime;

    const c = candles[candles.length - 1];
    log(`Novo candle: ${new Date(latestTime * 1000).toISOString().slice(0, 16)} | O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`, 'info');

    if (position) {
      await managePosition(candleCache);
      return;
    }

    if (isDailyLimitHit()) {
      log('Limite diário atingido. Sem novas entradas.', 'warning');
      return;
    }

    const signal = detectSignal(candleCache);
    if (signal) {
      log(`Sinal: ${signal.toUpperCase()}`, 'info');
      await enterTrade(signal, candleCache);
    }

  } catch (e) {
    log(`Erro no tick: ${e.message}`, 'error');
    // Sessão pode ter expirado — força renovação no próximo tick
    session.lastRefresh = 0;
  }
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
        broker:       'Capital.com',
        epic:         EPIC,
        timeframe:    TIMEFRAME,
        currentPrice: last?.close ?? null,
        equity:       parseFloat(equity.toFixed(2)),
        dailyPnL:     parseFloat(dailyPnL.toFixed(2)),
        position,
        isWarmingUp,
        useDemo:      USE_DEMO,
        config: { SMA_PERIOD, SLOPE_THRESHOLD, SL_POINTS, TRAILING_BUFFER, TP1_RATIO, TP1_CLOSE_PERC, RISK_PERC, DAILY_LOSS_PERC }
      }));
      return;
    }
    if (url === '/trades')  { res.writeHead(200); res.end(JSON.stringify(trades)); return; }
    if (url === '/logs')    { res.writeHead(200); res.end(JSON.stringify(logs));   return; }
    if (url === '/candles') { res.writeHead(200); res.end(JSON.stringify(candleCache)); return; }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, () => log(`Servidor HTTP na porta ${PORT}`, 'system'));
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function main() {
  log(`=== XAU/USD Capital.com Robot v2.0 ===`, 'system');
  log(`Ambiente: ${USE_DEMO ? 'DEMO' : 'LIVE'} | ${EPIC} ${TIMEFRAME}`, 'system');
  log(`Risco: ${RISK_PERC}% | SMA(${SMA_PERIOD}) | SL: ${SL_POINTS} pts | TP1: ${TP1_RATIO}:1`, 'system');

  rebuildEquity();
  await createSession(); // sessão inicial
  startHttpServer();

  log('Iniciando warm-up...', 'system');
  await tick();

  while (true) {
    await tick();
    await sleep(30_000);
  }
}

main().catch(e => { console.error('Erro fatal:', e); process.exit(1); });

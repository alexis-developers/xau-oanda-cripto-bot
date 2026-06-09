import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ─── Config ───────────────────────────────────────────────────────────────────
const OANDA_TOKEN     = process.env.OANDA_TOKEN;
const ACCOUNT_ID      = process.env.OANDA_ACCOUNT_ID;
const USE_PRACTICE    = process.env.OANDA_USE_PRACTICE !== 'false';
const BASE_URL        = USE_PRACTICE
  ? 'https://api-fxpractice.oanda.com'
  : 'https://api-fxtrade.oanda.com';

const INSTRUMENT      = process.env.INSTRUMENT      || 'XAU_USD';
const TIMEFRAME       = process.env.TIMEFRAME       || 'M15';
const CAPITAL_TOTAL   = parseFloat(process.env.CAPITAL_TOTAL   || '10000');
const RISK_PERC       = parseFloat(process.env.RISK_PERC       || '1');
const SMA_PERIOD      = parseInt(process.env.SMA_PERIOD        || '20');
const SLOPE_THRESHOLD = parseFloat(process.env.SLOPE_THRESHOLD || '0.5');
const SL_POINTS       = parseFloat(process.env.SL_POINTS       || '2.0');
const TRAILING_BUFFER = parseFloat(process.env.TRAILING_BUFFER || '0.5');
const TP1_RATIO       = parseFloat(process.env.TP1_RATIO       || '2.0');
const TP1_CLOSE_PERC  = parseFloat(process.env.TP1_CLOSE_PERC  || '80');
const DAILY_LOSS_PERC = parseFloat(process.env.DAILY_LOSS_PERC || '5');
const PORT            = parseInt(process.env.PORT              || '8000');
const WEBHOOK_URL     = process.env.WEBHOOK_URL || '';

const TRADES_FILE = join(ROOT, 'trades.json');

if (!OANDA_TOKEN || !ACCOUNT_ID) {
  console.error('FATAL: OANDA_TOKEN and OANDA_ACCOUNT_ID are required in .env');
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

// Active position (null when flat)
let position = null;
// {
//   tradeId: string,       — OANDA trade ID
//   side: 'buy'|'sell',
//   units: number,         — original units
//   remainingUnits: number,— units still open
//   entryPrice: number,
//   sl: number,            — current SL price
//   tp1Price: number,
//   tp1Hit: boolean,
//   isBreakeven: boolean
// }

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(msg, level = 'info') {
  const ts = new Date().toISOString();
  const prefix = { info: '[INFO]', warning: '[WARNING]', error: '[ERROR]', system: '===' }[level] || '[INFO]';
  const line = `${ts} ${prefix} ${msg}`;
  console.log(line);
  logs.push(line);
  if (logs.length > 50) logs.shift();
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
async function sendWebhook(content) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (e) {
    log(`Webhook error: ${e.message}`, 'error');
  }
}

// ─── OANDA REST V20 ───────────────────────────────────────────────────────────
async function oandaRequest(method, path, body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${OANDA_TOKEN}`,
      'Content-Type': 'application/json',
      'Accept-Datetime-Format': 'UNIX'
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(`OANDA ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function getCandles(count = 500) {
  const data = await oandaRequest(
    'GET',
    `/v3/instruments/${INSTRUMENT}/candles?granularity=${TIMEFRAME}&count=${count}&price=M`
  );
  return data.candles
    .filter(c => c.complete)
    .map(c => ({
      time:   parseInt(c.time),
      open:   parseFloat(c.mid.o),
      high:   parseFloat(c.mid.h),
      low:    parseFloat(c.mid.l),
      close:  parseFloat(c.mid.c),
      volume: c.volume
    }));
}

async function getAccountSummary() {
  const data = await oandaRequest('GET', `/v3/accounts/${ACCOUNT_ID}/summary`);
  return {
    balance:       parseFloat(data.account.balance),
    unrealizedPnL: parseFloat(data.account.unrealizedPL),
    nav:           parseFloat(data.account.NAV)
  };
}

async function getOpenTrade(tradeId) {
  try {
    const data = await oandaRequest('GET', `/v3/accounts/${ACCOUNT_ID}/trades/${tradeId}`);
    return data.trade;
  } catch {
    return null;
  }
}

async function placeMarketOrder(side, units, slPrice) {
  // OANDA: positive units = buy (long), negative = sell (short)
  const signedUnits = side === 'buy'
    ? String(Math.abs(Math.round(units)))
    : String(-Math.abs(Math.round(units)));

  return oandaRequest('POST', `/v3/accounts/${ACCOUNT_ID}/orders`, {
    order: {
      units:         signedUnits,
      instrument:    INSTRUMENT,
      timeInForce:   'FOK',
      type:          'MARKET',
      positionFill:  'DEFAULT',
      stopLossOnFill: {
        price:       slPrice.toFixed(3),
        timeInForce: 'GTC'
      }
    }
  });
}

async function modifyTradeSL(tradeId, newSl) {
  return oandaRequest('PATCH', `/v3/accounts/${ACCOUNT_ID}/trades/${tradeId}/orders`, {
    stopLoss: {
      price:       newSl.toFixed(3),
      timeInForce: 'GTC'
    }
  });
}

// Partial or full close of a trade
async function closeTrade(tradeId, units = null) {
  const body = units
    ? { units: String(Math.abs(Math.round(units))) }
    : {};
  return oandaRequest('PUT', `/v3/accounts/${ACCOUNT_ID}/trades/${tradeId}/close`, body);
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcSMA(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

// ─── Signal Engine ────────────────────────────────────────────────────────────
// Strategy: SMA 20 Trend Following with Pullback + Price Action Trigger
// Long:  slope up > threshold, prev candle low touches SMA, trigger candle breaks prev high
// Short: slope down > threshold, prev candle high touches SMA, trigger candle breaks prev low
function detectSignal(candles) {
  if (candles.length < SMA_PERIOD + 5) return null;

  const closes = candles.map(c => c.close);
  const sma    = calcSMA(closes, SMA_PERIOD);
  const n      = candles.length;

  const smaNow   = sma[n - 1]; // SMA at trigger candle
  const smaPrev  = sma[n - 2]; // SMA at pivot candle
  const sma3Bars = sma[n - 4]; // SMA 3 bars ago (slope reference)

  if (!smaNow || !smaPrev || !sma3Bars) return null;

  const trigger = candles[n - 1]; // current closed candle (entry trigger)
  const pivot   = candles[n - 2]; // previous candle (touched SMA)

  const slope = smaNow - sma3Bars;
  const uptrend   = slope >  SLOPE_THRESHOLD;
  const downtrend = slope < -SLOPE_THRESHOLD;

  // Pullback: pivot candle must have touched the SMA
  const touchedLow  = pivot.low  <= smaPrev; // price dipped to SMA (for longs)
  const touchedHigh = pivot.high >= smaPrev; // price spiked to SMA (for shorts)

  // Trigger: direction candle that breaks pivot's extreme
  const bullClose  = trigger.close > trigger.open;
  const bearClose  = trigger.close < trigger.open;
  const longEntry  = bullClose && trigger.high > pivot.high;
  const shortEntry = bearClose && trigger.low  < pivot.low;

  if (uptrend   && touchedLow  && longEntry)  return 'buy';
  if (downtrend && touchedHigh && shortEntry) return 'sell';
  return null;
}

// ─── Risk Manager ─────────────────────────────────────────────────────────────
function calcUnits(entryPrice, slPrice) {
  const riskAmount = equity * (RISK_PERC / 100);
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance < 0.001) return 0;
  // For XAU_USD: 1 unit = 1 troy oz → P&L = price_move * units
  return Math.floor(riskAmount / slDistance);
}

function calcSLPrice(side, pivotCandle) {
  // SL goes beyond the pivot candle's extreme with a small buffer
  return side === 'buy'
    ? pivotCandle.low  - SL_POINTS
    : pivotCandle.high + SL_POINTS;
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
  log(`Equity rebuilt: $${equity.toFixed(2)} from ${trades.length} trades`, 'system');
}

// ─── Trade Execution ──────────────────────────────────────────────────────────
async function enterTrade(signal, candles) {
  if (position) return;

  const n         = candles.length;
  const pivot     = candles[n - 2];
  const trigger   = candles[n - 1];
  const slPrice   = calcSLPrice(signal, pivot);
  const entryEst  = trigger.close; // estimate for sizing (actual fill may differ)
  const units     = calcUnits(entryEst, slPrice);

  if (units < 1) {
    log(`Insufficient units (${units}) for risk config. Skipping.`, 'warning');
    return;
  }

  const slDist  = Math.abs(entryEst - slPrice);
  const tp1Price = signal === 'buy'
    ? entryEst + slDist * TP1_RATIO
    : entryEst - slDist * TP1_RATIO;

  log(`SIGNAL ${signal.toUpperCase()} | Est. Entry: ${entryEst} | SL: ${slPrice.toFixed(3)} | TP1: ${tp1Price.toFixed(3)} | Units: ${units}`, 'system');

  try {
    const result = await placeMarketOrder(signal, units, slPrice);
    const fill   = result.orderFillTransaction;

    if (!fill) throw new Error('Order not filled — ' + JSON.stringify(result));

    const filledPrice = parseFloat(fill.price);
    const tradeId     = fill.tradeOpened?.tradeID;

    if (!tradeId) throw new Error('No tradeID in fill response');

    // Recalculate TP1 using actual fill price
    const actualSlDist = Math.abs(filledPrice - slPrice);
    const actualTp1    = signal === 'buy'
      ? filledPrice + actualSlDist * TP1_RATIO
      : filledPrice - actualSlDist * TP1_RATIO;

    position = {
      tradeId,
      side:           signal,
      units,
      remainingUnits: units,
      entryPrice:     filledPrice,
      sl:             slPrice,
      tp1Price:       actualTp1,
      tp1Hit:         false,
      isBreakeven:    false
    };

    saveTrade({
      id:        fill.id,
      timestamp: Date.now(),
      datetime:  new Date().toISOString(),
      side:      signal,
      type:      'entry',
      price:     filledPrice,
      units,
      sl:        slPrice,
      tp1:       actualTp1,
      pnl:       null
    });

    await sendWebhook(
      `**ENTRADA ${signal.toUpperCase()} XAU/USD**\n` +
      `Preço: ${filledPrice} | SL: ${slPrice.toFixed(3)} | TP1: ${actualTp1.toFixed(3)}\n` +
      `Unidades: ${units} | Equity: $${equity.toFixed(2)}`
    );
    log(`Trade aberto: ID ${tradeId} @ ${filledPrice}`, 'info');

  } catch (e) {
    log(`Erro ao abrir ordem: ${e.message}`, 'error');
    await sendWebhook(`**ERRO** ao abrir ordem ${signal.toUpperCase()}: ${e.message}`);
  }
}

async function managePosition(candles) {
  if (!position) return;

  const trade = await getOpenTrade(position.tradeId);

  // Trade was closed externally (SL hit, manual close, etc.)
  if (!trade || trade.state !== 'OPEN') {
    const realizedPnL = trade ? parseFloat(trade.realizedPL || 0) : 0;
    log(`Trade ${position.tradeId} fechado externamente. PnL: $${realizedPnL.toFixed(2)}`, 'system');

    saveTrade({
      id:        `close_${Date.now()}`,
      timestamp: Date.now(),
      datetime:  new Date().toISOString(),
      side:      position.side === 'buy' ? 'sell' : 'buy',
      type:      'stop_loss',
      price:     0,
      units:     position.remainingUnits,
      pnl:       realizedPnL
    });

    dailyPnL += realizedPnL;
    equity   += realizedPnL;
    await sendWebhook(`**SAÍDA (SL)** XAU/USD | PnL: $${realizedPnL.toFixed(2)} | Equity: $${equity.toFixed(2)}`);
    position = null;
    return;
  }

  const n            = candles.length;
  const currentPrice = candles[n - 1].close;
  const prevCandle   = candles[n - 2];

  // ── TP1: partial close ────────────────────────────────────────────────────
  if (!position.tp1Hit) {
    const tp1Reached = position.side === 'buy'
      ? currentPrice >= position.tp1Price
      : currentPrice <= position.tp1Price;

    if (tp1Reached) {
      const closeUnits = Math.floor(position.remainingUnits * TP1_CLOSE_PERC / 100);
      try {
        const result     = await closeTrade(position.tradeId, closeUnits);
        const fillTx     = result.orderFillTransaction;
        const closePrice = fillTx ? parseFloat(fillTx.price) : currentPrice;
        const pl         = fillTx?.pl ? parseFloat(fillTx.pl) : 0;

        position.remainingUnits -= closeUnits;
        position.tp1Hit          = true;

        await modifyTradeSL(position.tradeId, position.entryPrice);
        position.sl          = position.entryPrice;
        position.isBreakeven = true;

        saveTrade({
          id:        `tp1_${Date.now()}`,
          timestamp: Date.now(),
          datetime:  new Date().toISOString(),
          side:      position.side === 'buy' ? 'sell' : 'buy',
          type:      'partial_tp',
          price:     closePrice,
          units:     closeUnits,
          pnl:       pl
        });

        dailyPnL += pl;
        equity   += pl;

        log(`TP1 atingido! Fechado ${closeUnits} units @ ${closePrice}. Restando: ${position.remainingUnits}. SL → Breakeven`, 'system');
        await sendWebhook(
          `**TP1 XAU/USD** | ${closeUnits} units @ ${closePrice}\n` +
          `SL movido para breakeven | PnL parcial: $${pl.toFixed(2)}`
        );
      } catch (e) {
        log(`Erro no fechamento TP1: ${e.message}`, 'error');
      }
      return;
    }
  }

  // ── Trailing stop (after TP1, on remaining units) ─────────────────────────
  if (position.tp1Hit && position.remainingUnits > 0) {
    let newSl;
    if (position.side === 'buy') {
      // Trail SL to previous candle's low minus buffer, only if higher than current SL
      newSl = prevCandle.low - TRAILING_BUFFER;
      if (newSl <= position.sl) return; // never move SL against the trade
    } else {
      // Trail SL to previous candle's high plus buffer, only if lower than current SL
      newSl = prevCandle.high + TRAILING_BUFFER;
      if (newSl >= position.sl) return;
    }

    try {
      await modifyTradeSL(position.tradeId, newSl);
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
    log(`Novo dia. PnL do dia anterior: $${dailyPnL.toFixed(2)}. Resetando.`, 'system');
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

    // Warm-up: load history, calibrate, don't trade
    if (isWarmingUp) {
      isWarmingUp    = false;
      lastCandleTime = candles[candles.length - 1].time;
      log(`Warm-up concluído. ${candles.length} candles carregados.`, 'system');
      return;
    }

    const latestTime = candles[candles.length - 1].time;
    if (latestTime === lastCandleTime) return; // same candle, nothing new
    lastCandleTime = latestTime;

    const latest = candles[candles.length - 1];
    log(`Novo candle: ${new Date(latestTime * 1000).toISOString().slice(0, 16)} | O:${latest.open} H:${latest.high} L:${latest.low} C:${latest.close}`, 'info');

    // Manage open position first
    if (position) {
      await managePosition(candleCache);
      return;
    }

    // Circuit breaker
    if (isDailyLimitHit()) {
      log('Limite diário de perda atingido. Sem novas entradas hoje.', 'warning');
      return;
    }

    // Detect entry signal
    const signal = detectSignal(candleCache);
    if (signal) {
      log(`Sinal detectado: ${signal.toUpperCase()}`, 'info');
      await enterTrade(signal, candleCache);
    }

  } catch (e) {
    log(`Erro no tick: ${e.message}`, 'error');
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
        instrument:   INSTRUMENT,
        timeframe:    TIMEFRAME,
        currentPrice: last?.close ?? null,
        equity:       parseFloat(equity.toFixed(2)),
        dailyPnL:     parseFloat(dailyPnL.toFixed(2)),
        position,
        isWarmingUp,
        usePractice:  USE_PRACTICE,
        config: { SMA_PERIOD, SLOPE_THRESHOLD, SL_POINTS, TRAILING_BUFFER, TP1_RATIO, TP1_CLOSE_PERC, RISK_PERC, DAILY_LOSS_PERC }
      }));
      return;
    }

    if (url === '/trades') {
      res.writeHead(200);
      res.end(JSON.stringify(trades));
      return;
    }

    if (url === '/logs') {
      res.writeHead(200);
      res.end(JSON.stringify(logs));
      return;
    }

    if (url === '/candles') {
      res.writeHead(200);
      res.end(JSON.stringify(candleCache));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, () => log(`Servidor HTTP na porta ${PORT}`, 'system'));
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function main() {
  log(`=== XAU/USD OANDA Robot v1.0 ===`, 'system');
  log(`Ambiente: ${USE_PRACTICE ? 'PRACTICE' : 'LIVE'} | ${INSTRUMENT} ${TIMEFRAME}`, 'system');
  log(`Risco: ${RISK_PERC}% por trade | SMA(${SMA_PERIOD}) | SL: ${SL_POINTS} pts`, 'system');

  rebuildEquity();
  startHttpServer();

  log('Iniciando warm-up histórico...', 'system');
  await tick(); // loads 500 candles, sets isWarmingUp = false

  while (true) {
    await tick();
    await sleep(30_000); // poll every 30s (half a minute — well within 15m candle)
  }
}

main().catch(e => {
  console.error('Erro fatal:', e);
  process.exit(1);
});

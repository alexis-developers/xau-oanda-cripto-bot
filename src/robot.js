import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import WebSocket from 'ws';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Garantir que a pasta config/ exista
const CONFIG_DIR = join(ROOT, 'config');
if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

// Carregar chaves de API (Prioridade: config/keys.json > .env)
const KEYS_FILE = join(CONFIG_DIR, 'keys.json');
let KEYS = { deriv: { app_id: '', account_id: '' }, binance: { api_key: '', secret_key: '' } };
if (existsSync(KEYS_FILE)) {
  try {
    const fk = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
    KEYS = { deriv: { ...KEYS.deriv, ...fk.deriv }, binance: { ...KEYS.binance, ...fk.binance } };
  } catch (e) { console.error('Erro ao ler config/keys.json:', e.message); }
}

const PORT          = parseInt(process.env.PORT || '8000');
const PAPER_TRADING = (process.env.PAPER_TRADING ?? 'true').toLowerCase() === 'true';

let DERIV_ACCOUNT_ID   = KEYS.deriv.account_id   || process.env.DERIV_ACCOUNT_ID   || '';
let APP_ID             = KEYS.deriv.app_id        || process.env.DERIV_APP_ID       || '';
const DERIV_TOKEN      = process.env.DERIV_TOKEN  || '';
let BINANCE_API_KEY    = KEYS.binance.api_key     || process.env.BINANCE_API_KEY    || '';
let BINANCE_SECRET_KEY = KEYS.binance.secret_key  || process.env.BINANCE_SECRET_KEY || '';

// ─── Configuração Dinâmica (estilo ProfitTrailer) ─────────────────────────────
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

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
  BUY_STRATEGY_1:  { type: 'string', enum: ['SMA','RSI','BOLLINGER','MACD','EMA_CROSS'] },
  BUY_STRATEGY_2:  { type: 'string', enum: ['NONE','SMA','RSI','BOLLINGER','MACD','EMA_CROSS'] },
  BUY_LOGIC:       { type: 'string', enum: ['AND','OR'] },
  RSI_PERIOD:      { type: 'number', min: 2,   max: 100, int: true },
  RSI_OVERSOLD:    { type: 'number', min: 1,   max: 49 },
  RSI_OVERBOUGHT:  { type: 'number', min: 51,  max: 99 },
  BB_PERIOD:       { type: 'number', min: 5,   max: 200, int: true },
  BB_STD:          { type: 'number', min: 0.5, max: 5 },
  MACD_FAST:       { type: 'number', min: 2,   max: 50,  int: true },
  MACD_SLOW:       { type: 'number', min: 5,   max: 200, int: true },
  MACD_SIGNAL:     { type: 'number', min: 2,   max: 50,  int: true },
  EMA_FAST:        { type: 'number', min: 2,   max: 100, int: true },
  EMA_SLOW:        { type: 'number', min: 5,   max: 500, int: true },
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
  BUY_STRATEGY_1:  'SMA',
  BUY_STRATEGY_2:  'NONE',
  BUY_LOGIC:       'AND',
  RSI_PERIOD:      14,
  RSI_OVERSOLD:    30,
  RSI_OVERBOUGHT:  70,
  BB_PERIOD:       20,
  BB_STD:          2.0,
  MACD_FAST:       12,
  MACD_SLOW:       26,
  MACD_SIGNAL:     9,
  EMA_FAST:        9,
  EMA_SLOW:        21,
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

function saveConfig() { writeFileSync(CONFIG_FILE, JSON.stringify(CFG, null, 2)); }

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
    if (CFG[key] !== v) { clean[key] = v; if (spec.reconnect) reconnectRequired = true; }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const capitalChanged = clean.CAPITAL_TOTAL !== undefined;
  Object.assign(CFG, clean);
  saveConfig();
  if (capitalChanged) rebuildEquity();

  if (reconnectRequired) {
    log(`Config: símbolo/timeframe alterado → reconectando (${CFG.SYMBOL} ${CFG.TIMEFRAME})`, 'system');
    candleCache = []; formingCandle = null; isWarmingUp = true;
    try { ws?.close(); } catch {}
  }

  if (Object.keys(clean).length > 0) log(`Config atualizada: ${Object.keys(clean).join(', ')}`, 'system');
  return { ok: true, applied: clean, reconnectRequired };
}

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
let position      = null;

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
    await fetch(CFG.WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
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
  for (const t of trades) { if (typeof t.pnl === 'number' && !isNaN(t.pnl)) equity += t.pnl; }
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

function calcRSI(closes, period) {
  const r = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return r;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d > 0) ag += d; else al -= d; }
  ag /= period; al /= period;
  r[period] = 100 - 100 / (1 + (al === 0 ? Infinity : ag / al));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    r[i] = 100 - 100 / (1 + (al === 0 ? Infinity : ag / al));
  }
  return r;
}

function calcEMA(closes, period) {
  const r = new Array(closes.length).fill(null);
  if (closes.length < period) return r;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  r[period - 1] = ema;
  for (let i = period; i < closes.length; i++) { ema = closes[i] * k + ema * (1 - k); r[i] = ema; }
  return r;
}

function calcBollinger(closes, period, stdMult) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const s  = closes.slice(i - period + 1, i + 1);
    const m  = s.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / period);
    return { upper: m + stdMult * sd, middle: m, lower: m - stdMult * sd };
  });
}

function calcMACD(closes, fast, slow, signalP) {
  const ef = calcEMA(closes, fast);
  const es = calcEMA(closes, slow);
  const ml = closes.map((_, i) => ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null);
  const fi = ml.findIndex(v => v !== null);
  if (fi === -1) return { macdLine: ml, signalLine: ml.map(() => null), histogram: ml.map(() => null) };
  const sr   = calcEMA(ml.slice(fi), signalP);
  const sigL = ml.map((v, i) => i < fi ? null : (sr[i - fi] ?? null));
  const hist = ml.map((v, i) => v !== null && sigL[i] !== null ? v - sigL[i] : null);
  return { macdLine: ml, signalLine: sigL, histogram: hist };
}

// ─── Signal Engine ────────────────────────────────────────────────────────────
function checkStrategySignal(name, candles, side) {
  const n      = candles.length;
  const closes = candles.map(c => c.close);
  switch (name) {
    case 'SMA': {
      if (n < CFG.SMA_PERIOD + 5) return false;
      const sma = calcSMA(closes, CFG.SMA_PERIOD);
      const [sN, sP, s3] = [sma[n-1], sma[n-2], sma[n-4]];
      if (!sN || !sP || !s3) return false;
      const [trig, pivot] = [candles[n-1], candles[n-2]];
      const slope = sN - s3;
      if (side === 'buy')  return slope >  CFG.SLOPE_THRESHOLD && pivot.low  <= sP && trig.close > trig.open && trig.high > pivot.high;
      if (side === 'sell') return slope < -CFG.SLOPE_THRESHOLD && pivot.high >= sP && trig.close < trig.open && trig.low  < pivot.low;
      return false;
    }
    case 'RSI': {
      const rsi = calcRSI(closes, CFG.RSI_PERIOD);
      const [rN, rP] = [rsi[n-1], rsi[n-2]];
      if (rN === null || rP === null) return false;
      if (side === 'buy')  return rP <= CFG.RSI_OVERSOLD   && rN > CFG.RSI_OVERSOLD;
      if (side === 'sell') return rP >= CFG.RSI_OVERBOUGHT && rN < CFG.RSI_OVERBOUGHT;
      return false;
    }
    case 'BOLLINGER': {
      if (n < CFG.BB_PERIOD + 2) return false;
      const bb  = calcBollinger(closes, CFG.BB_PERIOD, CFG.BB_STD);
      const bbP = bb[n-2];
      if (!bbP) return false;
      const [trig, pivot] = [candles[n-1], candles[n-2]];
      if (side === 'buy')  return pivot.low  <= bbP.lower  && trig.close > trig.open;
      if (side === 'sell') return pivot.high >= bbP.upper  && trig.close < trig.open;
      return false;
    }
    case 'MACD': {
      const { macdLine: ml, signalLine: sl } = calcMACD(closes, CFG.MACD_FAST, CFG.MACD_SLOW, CFG.MACD_SIGNAL);
      const [mN, mP, sN, sP] = [ml[n-1], ml[n-2], sl[n-1], sl[n-2]];
      if ([mN, mP, sN, sP].some(v => v === null)) return false;
      if (side === 'buy')  return mP < sP && mN >= sN;
      if (side === 'sell') return mP > sP && mN <= sN;
      return false;
    }
    case 'EMA_CROSS': {
      const ef = calcEMA(closes, CFG.EMA_FAST), es = calcEMA(closes, CFG.EMA_SLOW);
      const [fN, fP, sN, sP] = [ef[n-1], ef[n-2], es[n-1], es[n-2]];
      if ([fN, fP, sN, sP].some(v => v === null)) return false;
      if (side === 'buy')  return fP < sP && fN >= sN;
      if (side === 'sell') return fP > sP && fN <= sN;
      return false;
    }
    default: return false;
  }
}

function detectSignal(candles) {
  const minBars = Math.max(
    CFG.SMA_PERIOD + 5, CFG.RSI_PERIOD + 2,
    CFG.BB_PERIOD + 2, CFG.MACD_SLOW + CFG.MACD_SIGNAL + 5, CFG.EMA_SLOW + 5
  );
  if (candles.length < minBars) return null;
  for (const side of ['buy', 'sell']) {
    const s1 = checkStrategySignal(CFG.BUY_STRATEGY_1, candles, side);
    if (CFG.BUY_STRATEGY_2 === 'NONE') {
      if (s1) return side;
    } else {
      const s2 = checkStrategySignal(CFG.BUY_STRATEGY_2, candles, side);
      if (CFG.BUY_LOGIC === 'AND' && s1 && s2) return side;
      if (CFG.BUY_LOGIC === 'OR'  && (s1 || s2)) return side;
    }
  }
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
  if (today !== dailyDate) { log(`Novo dia. PnL anterior: $${dailyPnL.toFixed(2)}`, 'system'); dailyPnL = 0; dailyDate = today; }
}

function isDailyLimitHit() { return dailyPnL <= -(equity * CFG.DAILY_LOSS_PERC / 100); }

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
      if (msgHandlers.has(id)) { msgHandlers.delete(id); reject(new Error(`WS timeout req_id=${id}`)); }
    }, timeoutMs);
  });
}

function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }

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
  if (!PAPER_TRADING && b?.balance !== undefined) equity = parseFloat(b.balance);
}

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
    if (!isWarmingUp) processNewCandle().catch(e => log(`Erro no tick: ${e.message}`, 'error'));
  }

  formingCandle = tick;
}

function handleContractUpdate(poc) {
  if (PAPER_TRADING || !poc || !position) return;
  if (poc.contract_id !== position.contractId) return;
  if (poc.is_sold || poc.status === 'sold') {
    const pl = parseFloat(poc.profit || 0);
    log(`Contrato ${position.contractId} fechado. PnL: $${pl.toFixed(2)}`, 'system');
    equity += pl; dailyPnL += pl;
    saveTrade({ id: `close_${Date.now()}`, timestamp: Date.now(), datetime: new Date().toISOString(),
      side: position.side === 'buy' ? 'sell' : 'buy', type: 'stop_loss',
      price: parseFloat(poc.exit_tick || 0), pnl: pl });
    sendWebhook(`**SAÍDA (SL)** ${CFG.SYMBOL} | PnL: $${pl.toFixed(2)} | Equity: $${equity.toFixed(2)}`);
    position = null;
  }
}

// ─── Main Candle Logic ────────────────────────────────────────────────────────
async function processNewCandle() {
  checkDailyReset();
  const last = candleCache[candleCache.length - 1];
  log(`Novo candle: ${new Date(last.time * 1000).toISOString().slice(0,16)} | C:${last.close.toFixed(2)}`, 'info');

  if (position) { await managePosition(); return; }
  if (!CFG.TRADING_ENABLED) return;
  if (isDailyLimitHit()) { log('Limite diário atingido. Sem novas entradas.', 'warning'); return; }

  const signal = detectSignal(candleCache);
  if (signal) { log(`Sinal: ${signal.toUpperCase()}`, 'info'); await enterTrade(signal); }
}

// ─── Paper Trading — Gerenciamento de Posição ─────────────────────────────────
async function managePaperPosition(candle, prevCandle) {
  const side = position.side;

  // TP1
  if (!position.tp1Hit) {
    const tp1Reached = side === 'buy' ? candle.high >= position.tp1Price : candle.low <= position.tp1Price;
    if (tp1Reached) {
      const pl = position.tp1Amount;
      equity += pl; dailyPnL += pl;
      saveTrade({ id: `tp1_${Date.now()}`, timestamp: Date.now(), datetime: new Date().toISOString(),
        side: side === 'buy' ? 'sell' : 'buy', type: 'tp1_close', price: position.tp1Price, pnl: pl });

      const trailStake = parseFloat((position.fullStake * (1 - CFG.TP1_CLOSE_PERC / 100)).toFixed(2));
      if (trailStake < 1) {
        log(`[PAPER] TP1! +$${pl.toFixed(2)} | Equity: $${equity.toFixed(2)}. Posição encerrada.`, 'system');
        await sendWebhook(`**[PAPER] TP1 ${CFG.SYMBOL}** | +$${pl.toFixed(2)} | Equity: $${equity.toFixed(2)}`);
        position = null;
        return;
      }
      log(`[PAPER] TP1! +$${pl.toFixed(2)} | Trailing $${trailStake} com SL em breakeven`, 'system');
      await sendWebhook(`**[PAPER] TP1 ${CFG.SYMBOL}** | PnL: +$${pl.toFixed(2)}\nTrailing ($${trailStake}) com SL em breakeven`);
      position = { ...position, currentStake: trailStake, entryPrice: position.tp1Price,
        sl: position.tp1Price, slAmount: 0, tp1Hit: true, isBreakeven: true };
      return;
    }
  }

  // SL
  const slHit = side === 'buy' ? candle.low <= position.sl : candle.high >= position.sl;
  if (slHit) {
    const move = side === 'buy' ? position.sl - position.entryPrice : position.entryPrice - position.sl;
    const pl   = parseFloat((position.currentStake * CFG.MULTIPLIER * move / position.entryPrice).toFixed(2));
    equity += pl; dailyPnL += pl;
    saveTrade({ id: `sl_${Date.now()}`, timestamp: Date.now(), datetime: new Date().toISOString(),
      side: side === 'buy' ? 'sell' : 'buy', type: 'stop_loss', price: position.sl, pnl: pl });
    log(`[PAPER] SL @ ${position.sl.toFixed(2)} | PnL: $${pl.toFixed(2)} | Equity: $${equity.toFixed(2)}`, 'system');
    await sendWebhook(`**[PAPER] SAÍDA SL ${CFG.SYMBOL}** | PnL: $${pl.toFixed(2)} | Equity: $${equity.toFixed(2)}`);
    position = null;
    return;
  }

  // Trailing Stop update (após TP1)
  if (position.tp1Hit) {
    let newSL;
    if (side === 'buy') { newSL = prevCandle.low - CFG.TRAILING_BUFFER; if (newSL <= position.sl) return; }
    else                { newSL = prevCandle.high + CFG.TRAILING_BUFFER; if (newSL >= position.sl) return; }
    const move = side === 'buy' ? newSL - position.entryPrice : position.entryPrice - newSL;
    position.sl       = newSL;
    position.slAmount = parseFloat((position.currentStake * CFG.MULTIPLIER * Math.abs(move) / position.entryPrice).toFixed(2));
    log(`[PAPER] Trailing SL → ${newSL.toFixed(2)}`, 'info');
  }
}

// ─── Trade Execution ──────────────────────────────────────────────────────────
async function enterTrade(signal) {
  if (position) return;

  const n          = candleCache.length;
  const pivot      = candleCache[n - 2];
  const trigger    = candleCache[n - 1];
  const slPrice    = calcSLPrice(signal, pivot);
  const slDist     = Math.abs(trigger.close - slPrice);
  const tp1Price   = signal === 'buy'
    ? trigger.close + slDist * CFG.TP1_RATIO
    : trigger.close - slDist * CFG.TP1_RATIO;
  const slAmount   = priceToUSD(CFG.STAKE, CFG.MULTIPLIER, trigger.close, slDist);
  const tp1Amount  = priceToUSD(CFG.STAKE, CFG.MULTIPLIER, trigger.close, slDist * CFG.TP1_RATIO);
  const contractType = signal === 'buy' ? 'MULTUP' : 'MULTDOWN';

  log(`SINAL ${signal.toUpperCase()} | SL: ${slPrice.toFixed(2)} ($${slAmount}) | TP1: ${tp1Price.toFixed(2)} ($${tp1Amount})`, 'system');

  // ── Paper Trading ──────────────────────────────────────────────────────────
  if (PAPER_TRADING) {
    const id = `PAPER_${Date.now()}`;
    position = {
      contractId: id, side: signal, contractType,
      fullStake: CFG.STAKE, currentStake: CFG.STAKE,
      entryPrice: trigger.close, sl: slPrice, slAmount,
      tp1Price, tp1Amount: parseFloat((tp1Amount * CFG.TP1_CLOSE_PERC / 100).toFixed(2)),
      tp1Hit: false, isBreakeven: false
    };
    saveTrade({ id, timestamp: Date.now(), datetime: new Date().toISOString(), side: signal, type: 'entry',
      price: trigger.close, stake: CFG.STAKE, sl: slPrice, tp1: tp1Price, pnl: null });
    log(`[PAPER] Posição aberta: ${signal.toUpperCase()} @ ${trigger.close} | SL: ${slPrice.toFixed(2)} | TP1: ${tp1Price.toFixed(2)}`, 'system');
    await sendWebhook(`**[PAPER] ENTRADA ${signal.toUpperCase()} ${CFG.SYMBOL}**\nPreço: ${trigger.close} | SL: ${slPrice.toFixed(2)} | TP1: ${tp1Price.toFixed(2)}\nStake: $${CFG.STAKE} | Mult: ${CFG.MULTIPLIER}x | Equity: $${equity.toFixed(2)}`);
    return;
  }

  // ── Real Trading ───────────────────────────────────────────────────────────
  try {
    const proposalRes = await sendWS({
      proposal: 1, contract_type: contractType, currency: 'USD',
      underlying_symbol: CFG.SYMBOL, amount: CFG.STAKE, basis: 'stake', multiplier: CFG.MULTIPLIER,
      limit_order: { stop_loss: slAmount, take_profit: parseFloat((tp1Amount * (CFG.TP1_CLOSE_PERC / 100)).toFixed(2)) }
    });
    const proposalId = proposalRes.proposal?.id;
    if (!proposalId) throw new Error('Proposal sem ID: ' + JSON.stringify(proposalRes));

    const result     = await sendWS({ buy: proposalId, price: CFG.STAKE * 2 });
    const contractId = result.buy.contract_id;

    position = { contractId, side: signal, contractType, fullStake: CFG.STAKE, currentStake: CFG.STAKE,
      entryPrice: trigger.close, sl: slPrice, slAmount, tp1Price, tp1Hit: false, isBreakeven: false };

    sendWS({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
      .catch(e => log(`Subscribe contrato: ${e.message}`, 'error'));

    saveTrade({ id: String(contractId), timestamp: Date.now(), datetime: new Date().toISOString(),
      side: signal, type: 'entry', price: trigger.close, stake: CFG.STAKE, sl: slPrice, tp1: tp1Price, pnl: null });
    await sendWebhook(
      `**ENTRADA ${signal.toUpperCase()} ${CFG.SYMBOL}**\n` +
      `Preço: ${trigger.close} | SL: ${slPrice.toFixed(2)} | TP1: ${tp1Price.toFixed(2)}\n` +
      `Stake: $${CFG.STAKE} | Mult: ${CFG.MULTIPLIER}x | Equity: $${equity.toFixed(2)}`
    );
    log(`Contrato aberto: ${contractId} @ ${trigger.close}`, 'info');
  } catch (e) {
    log(`Erro ao abrir contrato: ${e.message}`, 'error');
    await sendWebhook(`**ERRO** ${signal.toUpperCase()} ${CFG.SYMBOL}: ${e.message}`);
  }
}

async function managePosition() {
  if (!position) return;
  const n          = candleCache.length;
  const candle     = candleCache[n - 1];
  const prevCandle = candleCache[n - 2];

  if (PAPER_TRADING) { await managePaperPosition(candle, prevCandle); return; }

  const currentPrice = candle.close;

  // ── TP1 ───────────────────────────────────────────────────────────────────
  if (!position.tp1Hit) {
    const tp1Reached = position.side === 'buy' ? currentPrice >= position.tp1Price : currentPrice <= position.tp1Price;
    if (tp1Reached) {
      try {
        const sellResult = await sendWS({ sell: position.contractId, price: 0 });
        const pl = parseFloat(sellResult.sell?.sold_for || 0) - position.currentStake;
        equity += pl; dailyPnL += pl;
        saveTrade({ id: `tp1_${Date.now()}`, timestamp: Date.now(), datetime: new Date().toISOString(),
          side: position.side === 'buy' ? 'sell' : 'buy', type: 'tp1_close', price: currentPrice, pnl: pl });
        log(`TP1 atingido! PnL: $${pl.toFixed(2)}. Reabrindo ${100 - CFG.TP1_CLOSE_PERC}%...`, 'system');

        const trailStake = parseFloat((position.fullStake * (1 - CFG.TP1_CLOSE_PERC / 100)).toFixed(2));
        if (trailStake < 1) { log('Fração de trailing < $1. Posição encerrada no TP1.', 'warning'); position = null; return; }
        const beSlAmount = priceToUSD(trailStake, CFG.MULTIPLIER, currentPrice, 0.01);
        await sleep(1000);
        const prop2   = await sendWS({ proposal: 1, contract_type: position.contractType, currency: 'USD',
          underlying_symbol: CFG.SYMBOL, amount: trailStake, basis: 'stake', multiplier: CFG.MULTIPLIER,
          limit_order: { stop_loss: parseFloat(Math.max(0.13, beSlAmount).toFixed(2)) } });
        const result2 = await sendWS({ buy: prop2.proposal.id, price: trailStake * 2 });
        const c2      = result2.buy;
        position = { contractId: c2.contract_id, side: position.side, contractType: position.contractType,
          fullStake: position.fullStake, currentStake: trailStake, entryPrice: currentPrice,
          sl: currentPrice, slAmount: beSlAmount, tp1Price: position.tp1Price, tp1Hit: true, isBreakeven: true };
        sendWS({ proposal_open_contract: 1, contract_id: c2.contract_id, subscribe: 1 })
          .catch(e => log(`Subscribe trailing: ${e.message}`, 'error'));
        log(`Trailing aberto: ${c2.contract_id} | $${trailStake} | SL: breakeven`, 'info');
        await sendWebhook(`**TP1 ${CFG.SYMBOL}** | PnL: +$${pl.toFixed(2)}\nTrailing ($${trailStake}) com SL em breakeven`);
      } catch (e) { log(`Erro no TP1: ${e.message}`, 'error'); }
      return;
    }
  }

  // ── Trailing Stop ─────────────────────────────────────────────────────────
  if (position.tp1Hit) {
    let newSLPrice;
    if (position.side === 'buy') { newSLPrice = prevCandle.low - CFG.TRAILING_BUFFER; if (newSLPrice <= position.sl) return; }
    else                         { newSLPrice = prevCandle.high + CFG.TRAILING_BUFFER; if (newSLPrice >= position.sl) return; }
    const newSLAmount = priceToUSD(position.currentStake, CFG.MULTIPLIER, position.entryPrice, Math.abs(position.entryPrice - newSLPrice));
    try {
      await sendWS({ contract_update: 1, contract_id: position.contractId,
        limit_order: { stop_loss: parseFloat(Math.max(0.13, newSLAmount).toFixed(2)) } });
      log(`Trailing SL: ${position.sl.toFixed(2)} → ${newSLPrice.toFixed(2)} ($${newSLAmount.toFixed(2)})`, 'info');
      position.sl = newSLPrice; position.slAmount = newSLAmount;
    } catch (e) { log(`Erro no trailing SL: ${e.message}`, 'error'); }
  }
}

// ─── Deriv New API — OTP + WebSocket ─────────────────────────────────────────
async function getOTP() {
  const res = await fetch(
    `https://api.derivws.com/trading/v1/options/accounts/${DERIV_ACCOUNT_ID}/otp`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${DERIV_TOKEN}`, 'Deriv-App-ID': APP_ID, 'Content-Type': 'application/json' } }
  );
  if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error(`OTP HTTP ${res.status}: ${body}`); }
  const json = await res.json();
  if (!json.data?.url) throw new Error('OTP sem URL: ' + JSON.stringify(json));
  return json.data.url;
}

async function loadHistory() {
  const res = await sendWS({
    ticks_history: CFG.SYMBOL, adjust_start_time: 1, count: 500, end: 'latest', granularity: granularity(), style: 'candles'
  });
  candleCache = (res.candles || []).map(c => ({
    time: parseInt(c.epoch), open: parseFloat(c.open), high: parseFloat(c.high), low: parseFloat(c.low), close: parseFloat(c.close)
  }));
  isWarmingUp = false;
  log(`Warm-up: ${candleCache.length} candles carregados para ${CFG.SYMBOL}`, 'system');
}

async function subscribeCandles() {
  await sendWS({ ticks_history: CFG.SYMBOL, count: 1, end: 'latest', granularity: granularity(), style: 'candles', subscribe: 1 });
  log(`Subscrito a candles ${CFG.SYMBOL} (${CFG.TIMEFRAME})`, 'system');
}

async function subscribeBalance() {
  if (PAPER_TRADING) return;
  await sendWS({ balance: 1, subscribe: 1 });
  log('Balance subscrito', 'system');
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let subRetryTimer = null;
function trySubscribeCandles() {
  clearTimeout(subRetryTimer);
  subscribeCandles().catch(e => {
    log(`Subscrição de candles falhou: ${e.message} — nova tentativa em 5 min`, 'warning');
    subRetryTimer = setTimeout(() => { if (wsReady) trySubscribeCandles(); }, 5 * 60 * 1000);
  });
}

async function connectWS() {
  let wsUrl;
  if (PAPER_TRADING) {
    log('Modo PAPER TRADING — usando feed público Deriv (sem conta real)', 'system');
    wsUrl = 'wss://ws.derivws.com/websockets/v3?app_id=1089';
  } else {
    log('Obtendo OTP Deriv...', 'system');
    try { wsUrl = await getOTP(); }
    catch (e) { log(`Erro OTP: ${e.message}. Tentando em 10s...`, 'error'); setTimeout(connectWS, 10000); return; }
  }

  log('Conectando ao Deriv WebSocket...', 'system');
  ws = new WebSocket(wsUrl);

  ws.on('open', async () => {
    log('WebSocket conectado', 'system');
    wsReady = true;
    try { await loadHistory(); } catch (e) { log(`Histórico falhou: ${e.message}`, 'error'); }
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
  const WEB_DIR = join(ROOT, 'web');
  const MIME = {
    html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
    png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', ico: 'image/x-icon',
  };

  const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url.split('?')[0];

    // ── API Routes ─────────────────────────────────────────────────────────────
    if (url === '/status') {
      const last = candleCache[candleCache.length - 1];
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        broker: 'Deriv', accountId: DERIV_ACCOUNT_ID, symbol: CFG.SYMBOL, timeframe: CFG.TIMEFRAME,
        currentPrice: last?.close ?? null, equity: parseFloat(equity.toFixed(2)),
        dailyPnL: parseFloat(dailyPnL.toFixed(2)), position, isWarmingUp, wsReady,
        tradingEnabled: CFG.TRADING_ENABLED, paperTrading: PAPER_TRADING, config: CFG
      }));
      return;
    }

    if (url === '/config') {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') { res.writeHead(200); res.end(JSON.stringify({ config: CFG, schema: CONFIG_SCHEMA })); return; }
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

    if (url === '/keys') {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, keys: {
          deriv:   { app_id: APP_ID ? '***' : '', account_id: DERIV_ACCOUNT_ID ? '***' : '' },
          binance: { api_key: BINANCE_API_KEY ? '***' : '', secret_key: '' }
        }}));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
        req.on('end', () => {
          let updates;
          try { updates = JSON.parse(body); }
          catch { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'JSON inválido' })); return; }
          if (!updates.deriv && !updates.binance) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Nenhum campo reconhecido' })); return; }
          if (updates.deriv?.app_id)          KEYS.deriv.app_id        = updates.deriv.app_id;
          if (updates.deriv?.account_id)      KEYS.deriv.account_id    = updates.deriv.account_id;
          if (updates.binance?.api_key)       KEYS.binance.api_key     = updates.binance.api_key;
          if (updates.binance?.secret_key)    KEYS.binance.secret_key  = updates.binance.secret_key;
          try { writeFileSync(KEYS_FILE, JSON.stringify(KEYS, null, 2)); }
          catch (err) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: 'Erro ao salvar chaves' })); return; }
          DERIV_ACCOUNT_ID   = KEYS.deriv.account_id   || DERIV_ACCOUNT_ID;
          APP_ID             = KEYS.deriv.app_id        || APP_ID;
          BINANCE_API_KEY    = KEYS.binance.api_key     || BINANCE_API_KEY;
          BINANCE_SECRET_KEY = KEYS.binance.secret_key  || BINANCE_SECRET_KEY;
          log('Chaves de API atualizadas via painel', 'system');
          if (!PAPER_TRADING) { wsReady = false; try { ws?.close(); } catch {} }
          res.writeHead(200); res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
    }

    if (url === '/trades')  { res.setHeader('Content-Type', 'application/json'); res.writeHead(200); res.end(JSON.stringify(trades)); return; }
    if (url === '/logs')    { res.setHeader('Content-Type', 'application/json'); res.writeHead(200); res.end(JSON.stringify(logs)); return; }
    if (url === '/candles') { res.setHeader('Content-Type', 'application/json'); res.writeHead(200); res.end(JSON.stringify(candleCache)); return; }

    if (url.startsWith('/force-trade')) {
      res.setHeader('Content-Type', 'application/json');
      if (!wsReady || candleCache.length < 2) { res.writeHead(400); res.end(JSON.stringify({ error: 'Robot not ready' })); return; }
      if (position) { res.writeHead(400); res.end(JSON.stringify({ error: 'Position already open', position })); return; }
      const params = new URLSearchParams(req.url.split('?')[1] || '');
      const side   = params.get('side') === 'sell' ? 'sell' : 'buy';
      res.writeHead(200); res.end(JSON.stringify({ ok: true, message: `Forcing ${side} entry...` }));
      enterTrade(side).catch(e => log(`force-trade error: ${e.message}`, 'error'));
      return;
    }

    if (url === '/force-close') {
      res.setHeader('Content-Type', 'application/json');
      if (!position) { res.writeHead(400); res.end(JSON.stringify({ error: 'No open position' })); return; }
      res.writeHead(200); res.end(JSON.stringify({ ok: true, message: 'Closing position...' }));
      if (PAPER_TRADING) {
        const exitPrice = candleCache[candleCache.length - 1]?.close ?? position.entryPrice;
        const move = position.side === 'buy' ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
        const pl   = parseFloat((position.currentStake * CFG.MULTIPLIER * move / position.entryPrice).toFixed(2));
        equity += pl; dailyPnL += pl;
        saveTrade({ id: `manual_${Date.now()}`, timestamp: Date.now(), datetime: new Date().toISOString(),
          side: position.side === 'buy' ? 'sell' : 'buy', type: 'manual_close', price: exitPrice, pnl: pl });
        log(`[PAPER] Posição fechada manualmente. PnL: $${pl.toFixed(2)}`, 'system');
        position = null;
      } else {
        sendWS({ sell: position.contractId, price: 0 })
          .then(r => {
            const pl = parseFloat(r.sell?.sold_for || 0) - position.currentStake;
            equity += pl; dailyPnL += pl;
            saveTrade({ id: `manual_${Date.now()}`, timestamp: Date.now(), datetime: new Date().toISOString(),
              side: position.side === 'buy' ? 'sell' : 'buy', type: 'manual_close',
              price: candleCache[candleCache.length-1]?.close, pnl: pl });
            log(`Posição fechada manualmente. PnL: $${pl.toFixed(2)}`, 'system');
            position = null;
          })
          .catch(e => log(`force-close error: ${e.message}`, 'error'));
      }
      return;
    }

    // ── Static Files (dashboard web) ──────────────────────────────────────────
    if (req.method === 'GET') {
      const filePath = join(WEB_DIR, url === '/' ? 'index.html' : url.substring(1));
      if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
      if (existsSync(filePath)) {
        const ext = filePath.split('.').pop();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.writeHead(200);
        res.end(readFileSync(filePath));
        return;
      }
    }

    res.setHeader('Content-Type', 'application/json');
    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, () => log(`Servidor HTTP na porta ${PORT} | Modo: ${PAPER_TRADING ? 'PAPER TRADING' : 'REAL'} | Dashboard: http://localhost:${PORT}`, 'system'));
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function main() {
  log(`=== Multi Trader Pro v5.1 ===`, 'system');
  log(`Modo: ${PAPER_TRADING ? 'PAPER TRADING' : 'REAL'} | ${CFG.SYMBOL} ${CFG.TIMEFRAME} | Mult: ${CFG.MULTIPLIER}x | Stake: $${CFG.STAKE} | Trading: ${CFG.TRADING_ENABLED ? 'ON' : 'OFF'}`, 'system');
  rebuildEquity();
  startHttpServer();
  await connectWS();
}

main().catch(e => { console.error('Erro fatal:', e); process.exit(1); });

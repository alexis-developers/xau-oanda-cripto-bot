// ─── Colors ───────────────────────────────────────────────────────────────────
const COLORS = {
  bull:        '#00e676',
  bear:        '#ff1744',
  sma:         '#ffb300',
  bbUpper:     'rgba(33,150,243,0.7)',
  bbMiddle:    'rgba(33,150,243,0.35)',
  bbLower:     'rgba(33,150,243,0.7)',
  emaFast:     '#e91e63',
  emaSlow:     '#9c27b0',
  rsi:         '#00bcd4',
  macdLine:    '#2196f3',
  macdSignal:  '#ff9800',
  macdBull:    'rgba(0,230,118,0.75)',
  macdBear:    'rgba(255,23,68,0.75)',
  entry:       '#2196f3',
  sl:          '#ff1744',
  tp1:         '#00e676',
  buyMarker:   '#00e676',
  sellMarker:  '#ff1744',
  bg:          '#0d1117',
  grid:        '#1e2430',
  text:        '#8b949e',
  border:      '#30363d',
};

// ─── API URL ──────────────────────────────────────────────────────────────────
let apiUrl = localStorage.getItem('roland_api_url') || 'https://alexisprofit-bot.desenvolvimentodesites.dev.br';
const apiInput = document.getElementById('api-url-input');
apiInput.value = apiUrl;
document.getElementById('api-url-save').addEventListener('click', () => {
  apiUrl = apiInput.value.trim().replace(/\/$/, '');
  localStorage.setItem('roland_api_url', apiUrl);
  init();
});

// ─── Main Chart ───────────────────────────────────────────────────────────────
const chartEl = document.getElementById('chart-main');
const chart = LightweightCharts.createChart(chartEl, {
  layout:          { background: { color: COLORS.bg }, textColor: COLORS.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
  grid:            { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
  crosshair:       { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
  timeScale:       { borderColor: COLORS.border, timeVisible: true, secondsVisible: false },
});

const candleSeries = chart.addCandlestickSeries({
  upColor: COLORS.bull, downColor: COLORS.bear,
  borderUpColor: COLORS.bull, borderDownColor: COLORS.bear,
  wickUpColor: COLORS.bull, wickDownColor: COLORS.bear,
});

const smaSeries    = chart.addLineSeries({ color: COLORS.sma,      lineWidth: 2, title: 'SMA',      priceLineVisible: false, lastValueVisible: true });
const bbUpperSer   = chart.addLineSeries({ color: COLORS.bbUpper,  lineWidth: 1, title: 'BB+',      priceLineVisible: false, lastValueVisible: false });
const bbMiddleSer  = chart.addLineSeries({ color: COLORS.bbMiddle, lineWidth: 1, title: 'BB',       priceLineVisible: false, lastValueVisible: false, lineStyle: LightweightCharts.LineStyle.Dashed });
const bbLowerSer   = chart.addLineSeries({ color: COLORS.bbLower,  lineWidth: 1, title: 'BB-',      priceLineVisible: false, lastValueVisible: false });
const emaFastSer   = chart.addLineSeries({ color: COLORS.emaFast,  lineWidth: 1, title: 'EMA Fast', priceLineVisible: false, lastValueVisible: false });
const emaSlowSer   = chart.addLineSeries({ color: COLORS.emaSlow,  lineWidth: 1, title: 'EMA Slow', priceLineVisible: false, lastValueVisible: false });

// ─── RSI Sub-chart ────────────────────────────────────────────────────────────
const rsiEl = document.getElementById('chart-rsi');
const rsiChart = LightweightCharts.createChart(rsiEl, {
  layout:          { background: { color: COLORS.bg }, textColor: COLORS.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 },
  grid:            { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
  crosshair:       { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.1, bottom: 0.1 } },
  timeScale:       { borderColor: COLORS.border, timeVisible: false, secondsVisible: false },
});
const rsiSeries = rsiChart.addLineSeries({ color: COLORS.rsi, lineWidth: 1, title: 'RSI', priceLineVisible: false });
rsiSeries.createPriceLine({ price: 70, color: 'rgba(255,23,68,0.45)',   lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, title: 'OB 70' });
rsiSeries.createPriceLine({ price: 50, color: 'rgba(139,148,158,0.25)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, title: '50' });
rsiSeries.createPriceLine({ price: 30, color: 'rgba(0,230,118,0.45)',   lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, title: 'OS 30' });

// ─── MACD Sub-chart ───────────────────────────────────────────────────────────
const macdEl = document.getElementById('chart-macd');
const macdChart = LightweightCharts.createChart(macdEl, {
  layout:          { background: { color: COLORS.bg }, textColor: COLORS.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 },
  grid:            { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
  crosshair:       { mode: LightweightCharts.CrosshairMode.Normal },
  rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.1, bottom: 0.1 } },
  timeScale:       { borderColor: COLORS.border, timeVisible: false, secondsVisible: false },
});
const macdHistSer   = macdChart.addHistogramSeries({ priceLineVisible: false, color: COLORS.macdBull });
const macdLineSer   = macdChart.addLineSeries({ color: COLORS.macdLine,   lineWidth: 1, title: 'MACD',   priceLineVisible: false });
const macdSignalSer = macdChart.addLineSeries({ color: COLORS.macdSignal, lineWidth: 1, title: 'Signal', priceLineVisible: false });

// ─── Time Scale Sync ──────────────────────────────────────────────────────────
let syncing = false;
function syncCharts(source, ...targets) {
  if (syncing) return;
  syncing = true;
  const range = source.timeScale().getVisibleRange();
  if (range) targets.forEach(t => { try { t.timeScale().setVisibleRange(range); } catch {} });
  syncing = false;
}
chart.timeScale().subscribeVisibleTimeRangeChange(    () => syncCharts(chart, rsiChart, macdChart));
rsiChart.timeScale().subscribeVisibleTimeRangeChange( () => syncCharts(rsiChart, chart, macdChart));
macdChart.timeScale().subscribeVisibleTimeRangeChange(() => syncCharts(macdChart, chart, rsiChart));

// ─── Resize ───────────────────────────────────────────────────────────────────
new ResizeObserver(() => chart.applyOptions({ width: chartEl.clientWidth,   height: chartEl.clientHeight   })).observe(chartEl);
new ResizeObserver(() => rsiChart.applyOptions({ width: rsiEl.clientWidth,  height: rsiEl.clientHeight     })).observe(rsiEl);
new ResizeObserver(() => macdChart.applyOptions({ width: macdEl.clientWidth,height: macdEl.clientHeight   })).observe(macdEl);

// ─── Price Lines (active position) ───────────────────────────────────────────
let entryLine = null, slLine = null, tp1Line = null;
function clearPriceLines() {
  if (entryLine) { candleSeries.removePriceLine(entryLine); entryLine = null; }
  if (slLine)    { candleSeries.removePriceLine(slLine);    slLine    = null; }
  if (tp1Line)   { candleSeries.removePriceLine(tp1Line);   tp1Line   = null; }
}
function drawPriceLines(pos) {
  clearPriceLines();
  if (!pos) return;
  entryLine = candleSeries.createPriceLine({ price: pos.entryPrice, color: COLORS.entry, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, title: `Entry ${pos.side.toUpperCase()}` });
  slLine    = candleSeries.createPriceLine({ price: pos.sl,         color: COLORS.sl,    lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, title: pos.isBreakeven ? 'BE / Trail' : 'SL' });
  if (!pos.tp1Hit) tp1Line = candleSeries.createPriceLine({ price: pos.tp1Price, color: COLORS.tp1, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, title: 'TP1' });
}

// ─── Indicator Calculations (frontend — independent of backend) ───────────────
let currentCfg = {};
let latestStatus = {};

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
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  r[period] = 100 - 100 / (1 + (al === 0 ? Infinity : ag / al));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
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
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    r[i] = ema;
  }
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
  const sl   = ml.map((v, i) => i < fi ? null : (sr[i - fi] ?? null));
  const hist = ml.map((v, i) => v !== null && sl[i] !== null ? v - sl[i] : null);
  return { macdLine: ml, signalLine: sl, histogram: hist };
}

// ─── Chart Data ───────────────────────────────────────────────────────────────
const GRAN_MAP = { M1:60, M5:300, M15:900, M30:1800, H1:3600, H4:14400, D1:86400 };
let currentGran = 900;

function toSeries(vals, candles) {
  return vals.map((v, i) => v !== null ? { time: candles[i].time, value: v } : null).filter(Boolean);
}

function applyCandles(candles) {
  if (!candles || candles.length === 0) return;
  const cfg    = currentCfg;
  const closes = candles.map(c => c.close);

  candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));

  // SMA
  const smaPer = cfg.SMA_PERIOD || 20;
  smaSeries.setData(toSeries(calcSMA(closes, smaPer), candles));
  smaSeries.applyOptions({ title: `SMA ${smaPer}` });

  // Bollinger Bands
  const bbVals = calcBollinger(closes, cfg.BB_PERIOD || 20, cfg.BB_STD || 2);
  bbUpperSer.setData( bbVals.map((v, i) => v ? { time: candles[i].time, value: v.upper  } : null).filter(Boolean));
  bbMiddleSer.setData(bbVals.map((v, i) => v ? { time: candles[i].time, value: v.middle } : null).filter(Boolean));
  bbLowerSer.setData( bbVals.map((v, i) => v ? { time: candles[i].time, value: v.lower  } : null).filter(Boolean));
  bbUpperSer.applyOptions({ title: `BB(${cfg.BB_PERIOD||20},${cfg.BB_STD||2})+` });
  bbLowerSer.applyOptions({ title: `BB-` });

  // EMA Cross
  const emaF = cfg.EMA_FAST || 9, emaS = cfg.EMA_SLOW || 21;
  emaFastSer.setData(toSeries(calcEMA(closes, emaF), candles));
  emaSlowSer.setData(toSeries(calcEMA(closes, emaS), candles));
  emaFastSer.applyOptions({ title: `EMA ${emaF}` });
  emaSlowSer.applyOptions({ title: `EMA ${emaS}` });

  // RSI
  rsiSeries.setData(toSeries(calcRSI(closes, cfg.RSI_PERIOD || 14), candles));
  rsiSeries.applyOptions({ title: `RSI ${cfg.RSI_PERIOD || 14}` });

  // MACD
  const { macdLine, signalLine, histogram } = calcMACD(
    closes, cfg.MACD_FAST || 12, cfg.MACD_SLOW || 26, cfg.MACD_SIGNAL || 9
  );
  macdHistSer.setData(histogram.map((v, i) => v !== null ? { time: candles[i].time, value: v, color: v >= 0 ? COLORS.macdBull : COLORS.macdBear } : null).filter(Boolean));
  macdLineSer.setData(toSeries(macdLine, candles));
  macdSignalSer.setData(toSeries(signalLine, candles));

  if (!candlesLoaded) {
    chart.timeScale().fitContent();
    rsiChart.timeScale().fitContent();
    macdChart.timeScale().fitContent();
  }
}

function applyTradeMarkers(trades) {
  const GRAN = currentGran;
  const markers = trades
    .filter(t => ['entry','tp1_close','stop_loss','manual_close','close'].includes(t.type))
    .map(t => {
      const ts   = Math.floor(t.timestamp / 1000);
      const time = Math.floor(ts / GRAN) * GRAN;
      const isEntry = t.type === 'entry';
      const isBuy   = t.side === 'buy';
      const isSL    = t.type === 'stop_loss';
      const pnlStr  = t.pnl != null ? ` ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : '';
      return {
        time,
        position: isEntry ? (isBuy ? 'belowBar' : 'aboveBar') : (isSL ? 'belowBar' : 'aboveBar'),
        color:    isEntry ? (isBuy ? COLORS.buyMarker : COLORS.sellMarker) : (isSL ? COLORS.bear : COLORS.tp1),
        shape:    isEntry ? (isBuy ? 'arrowUp' : 'arrowDown') : 'circle',
        text:     isEntry ? `${t.side.toUpperCase()} ${t.price?.toFixed(2) ?? ''}` : `${isSL ? 'SL' : 'TP'}${pnlStr}`,
      };
    })
    .sort((a, b) => a.time - b.time);
  candleSeries.setMarkers(markers);
}

// ─── Status & UI Updates ─────────────────────────────────────────────────────
function updateStatusDot(ok) {
  document.getElementById('status-dot').className = ok ? 'connected' : 'error';
}

function setStatValue(id, value, cls = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.className = 'stat-value' + (cls ? ' ' + cls : '');
}

function updateStats(status) {
  setStatValue('stat-price', status.currentPrice ? status.currentPrice.toFixed(2) : '—');
  const eq  = parseFloat(status.equity);
  setStatValue('stat-equity', `$${eq.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  const pnl = parseFloat(status.dailyPnL);
  setStatValue('stat-daily-pnl', `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, pnl >= 0 ? 'positive' : 'negative');

  const cfg = status.config || {};
  const strat = `${cfg.BUY_STRATEGY_1 || 'SMA'}${cfg.BUY_STRATEGY_2 && cfg.BUY_STRATEGY_2 !== 'NONE' ? ` ${cfg.BUY_LOGIC || 'AND'} ${cfg.BUY_STRATEGY_2}` : ''}`;
  setStatValue('stat-strategy', strat);
  setStatValue('stat-risk', `${cfg.RISK_PERC ?? '—'}%`);

  currentGran = GRAN_MAP[status.timeframe] || 900;
  document.getElementById('tf-badge').textContent  = status.timeframe ?? '—';
  const isPaper = status.paperTrading !== false;
  document.getElementById('env-badge').className   = `badge ${isPaper ? 'practice' : 'live'}`;
  document.getElementById('env-badge').textContent = isPaper ? 'PAPER' : 'LIVE';

  const tBadge = document.getElementById('trading-badge');
  if (tBadge && status.tradingEnabled !== undefined) {
    tBadge.className   = `badge ${status.tradingEnabled ? 'trading-on' : 'trading-off'}`;
    tBadge.textContent = status.tradingEnabled ? 'TRADING ON' : 'TRADING OFF';
  }

  const NAMES = {
    frxXAUUSD:'Ouro (XAU/USD)', frxXAGUSD:'Prata (XAG/USD)',
    frxEURUSD:'EUR/USD', frxGBPUSD:'GBP/USD', frxUSDJPY:'USD/JPY',
    frxAUDUSD:'AUD/USD', frxUSDCAD:'USD/CAD', frxUSDCHF:'USD/CHF',
    cryBTCUSD:'Bitcoin (BTC/USD)', cryETHUSD:'Ethereum (ETH/USD)',
    OTC_DJI:'Wall Street 30', OTC_SPC:'US 500', OTC_NDX:'US Tech 100',
    OTC_FTSE:'UK 100', OTC_GDAXI:'Germany 40',
    R_25:'Volatility 25', R_50:'Volatility 50', R_75:'Volatility 75', R_100:'Volatility 100',
  };
  const title = document.getElementById('header-title');
  if (title && status.symbol) title.textContent = `Multi Trader Pro — ${NAMES[status.symbol] ?? status.symbol}`;
}

function updateConfig(cfg) {
  if (!cfg) return;
  currentCfg = cfg;
  document.getElementById('cfg-sma').textContent   = cfg.SMA_PERIOD;
  document.getElementById('cfg-slope').textContent = cfg.SLOPE_THRESHOLD;
  document.getElementById('cfg-sl').textContent    = cfg.SL_POINTS;
  document.getElementById('cfg-trail').textContent = cfg.TRAILING_BUFFER;
  document.getElementById('cfg-tp1').textContent   = cfg.TP1_RATIO + ':1';
  document.getElementById('cfg-tp1c').textContent  = cfg.TP1_CLOSE_PERC + '%';
  document.getElementById('cfg-risk').textContent  = cfg.RISK_PERC + '%';
  document.getElementById('cfg-daily').textContent = cfg.DAILY_LOSS_PERC + '%';
}

function updatePosition(pos) {
  const card = document.getElementById('position-card');
  if (!pos) {
    card.className = 'position-card flat';
    card.innerHTML = '<span style="font-size:12px">Sem posição aberta</span>';
    clearPriceLines(); return;
  }
  const isLong = pos.side === 'buy';
  card.className = `position-card ${isLong ? 'long' : 'short'}`;
  card.innerHTML = `
    <div class="pos-header">
      <span class="pos-side ${isLong ? 'long' : 'short'}">${isLong ? '▲ LONG' : '▼ SHORT'}</span>
      <span style="color:#8b949e;font-size:11px">${pos.contractType ?? ''}</span>
    </div>
    <div class="pos-grid">
      <div class="pos-item"><span class="label">Entrada</span><span class="val">${pos.entryPrice?.toFixed(3)}</span></div>
      <div class="pos-item"><span class="label">SL</span><span class="val" style="color:#ff1744">${pos.sl?.toFixed(3)}</span></div>
      <div class="pos-item"><span class="label">TP1</span><span class="val" style="color:#00e676">${pos.tp1Price?.toFixed(3)}</span></div>
      <div class="pos-item"><span class="label">Status</span><span class="val" style="color:#ffb300">${pos.tp1Hit ? (pos.isBreakeven ? 'Trailing' : 'TP1 Hit') : 'Ativo'}</span></div>
    </div>
  `;
  drawPriceLines(pos);
}

function updateTrades(trades) {
  const list = document.getElementById('trades-list');
  list.innerHTML = [...trades].reverse().slice(0, 20).map(t => {
    const pnl    = typeof t.pnl === 'number' ? t.pnl : null;
    const pnlStr = pnl !== null
      ? `<span class="trade-pnl ${pnl >= 0 ? 'pos' : 'neg'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</span>`
      : '<span class="trade-pnl" style="color:#8b949e">—</span>';
    const dt = new Date(t.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="trade-item">
        <span class="trade-side ${t.side}">${t.side.toUpperCase()} <span style="color:#8b949e;font-weight:400">${t.type?.replace('_',' ')}</span></span>
        <span style="color:#8b949e">${dt}</span>
        ${pnlStr}
      </div>`;
  }).join('');
}

function updateLogs(lines) {
  const terminal = document.getElementById('log-terminal');
  terminal.innerHTML = lines.map(line => {
    let cls = 'log-line info';
    if (line.includes('[WARNING]')) cls = 'log-line warning';
    else if (line.includes('[ERROR]')) cls = 'log-line error';
    else if (line.includes('==='))    cls = 'log-line system';
    return `<div class="${cls}">${line.replace(/^[\d\-T:.Z]+\s/, '')}</div>`;
  }).join('');
  terminal.scrollTop = terminal.scrollHeight;
}

// ─── Fetch Helpers ────────────────────────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(`${apiUrl}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Initialization ───────────────────────────────────────────────────────────
let candlesLoaded = false;

async function loadCandles() {
  try {
    const candles = await apiFetch('/candles');
    if (candles && candles.length > 0) {
      applyCandles(candles);
      candlesLoaded = true;
      const last = candles[candles.length - 1];
      document.getElementById('stat-last-candle').textContent =
        new Date(last.time * 1000).toLocaleString('pt-BR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    }
  } catch (e) { console.warn('Candles fetch failed:', e.message); }
}

async function pollStatus() {
  try {
    const [status, trades, logs] = await Promise.all([
      apiFetch('/status'), apiFetch('/trades'), apiFetch('/logs'),
    ]);
    latestStatus = status;
    updateStatusDot(true);
    updateStats(status);
    updateConfig(status.config);
    updatePosition(status.position);
    updateTrades(trades);
    updateLogs(logs);
    if (!candlesLoaded || Math.random() < 0.1) await loadCandles();
    if (trades.length > 0) applyTradeMarkers(trades);
  } catch (e) {
    updateStatusDot(false);
    console.warn('Poll error:', e.message);
  }
}

async function init() {
  candlesLoaded = false;
  await loadCandles();
  await pollStatus();
}

// ─── Zoom Controls ───────────────────────────────────────────────────────────
(function () {
  const ts = chart.timeScale(), STEP = 3;
  document.getElementById('zoom-in').addEventListener('click', () => {
    ts.applyOptions({ barSpacing: Math.min((ts.options().barSpacing ?? 6) + STEP, 50) });
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    ts.applyOptions({ barSpacing: Math.max((ts.options().barSpacing ?? 6) - STEP, 1) });
  });
  document.getElementById('zoom-fit').addEventListener('click', () => {
    ts.fitContent(); rsiChart.timeScale().fitContent(); macdChart.timeScale().fitContent();
  });
})();

// ─── Sub-panel Collapse ───────────────────────────────────────────────────────
document.querySelectorAll('.panel-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const chartDiv = document.getElementById(btn.dataset.chart);
    if (!chartDiv) return;
    const collapsed = chartDiv.style.display === 'none';
    chartDiv.style.display = collapsed ? '' : 'none';
    btn.textContent = collapsed ? '▲' : '▼';
  });
});

// Alternar visibilidade completa dos sub-painéis RSI/MACD via toolbar
document.querySelectorAll('.toggle-panel-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const panelId = btn.dataset.panel;
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const isVisible = !panel.classList.contains('hidden');
    if (isVisible) {
      panel.classList.add('hidden');
      btn.classList.remove('active');
    } else {
      panel.classList.remove('hidden');
      btn.classList.add('active');
    }
  });
});

// ─── Config Modal ─────────────────────────────────────────────────────────────
const CFG_FIELDS = [
  'TRADING_ENABLED', 'SYMBOL', 'TIMEFRAME',
  'BUY_STRATEGY_1', 'BUY_STRATEGY_2', 'BUY_LOGIC',
  'SMA_PERIOD', 'SLOPE_THRESHOLD',
  'RSI_PERIOD', 'RSI_OVERSOLD', 'RSI_OVERBOUGHT',
  'BB_PERIOD', 'BB_STD',
  'MACD_FAST', 'MACD_SLOW', 'MACD_SIGNAL',
  'EMA_FAST', 'EMA_SLOW',
  'TP1_RATIO', 'TP1_CLOSE_PERC', 'SL_POINTS', 'TRAILING_BUFFER',
  'STAKE', 'MULTIPLIER', 'CAPITAL_TOTAL', 'RISK_PERC', 'DAILY_LOSS_PERC',
  'WEBHOOK_URL',
];

const modal    = document.getElementById('config-modal');
const feedback = document.getElementById('config-feedback');
const cfgInput = key => document.getElementById(`cfg-in-${key}`);

function showFeedback(msg, ok) {
  feedback.textContent = msg;
  feedback.className = `cfg-feedback ${ok ? 'success' : 'error'}`;
}

// Alternância de Abas no Modal de Configuração
document.querySelectorAll('.modal-tabs .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.modal-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.modal-body .tab-content').forEach(content => content.classList.add('hidden'));
    const target = btn.dataset.tab;
    document.getElementById(target).classList.remove('hidden');
  });
});

window.togglePasswordVisibility = function(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
};

async function openConfigModal() {
  feedback.className = 'cfg-feedback hidden';
  
  // Resetar abas para a primeira
  document.querySelectorAll('.modal-tabs .tab-btn').forEach(b => b.classList.remove('active'));
  const firstTabBtn = document.querySelector('[data-tab="tab-params"]');
  if (firstTabBtn) firstTabBtn.classList.add('active');
  document.querySelectorAll('.modal-body .tab-content').forEach(content => content.classList.add('hidden'));
  const firstTabContent = document.getElementById('tab-params');
  if (firstTabContent) firstTabContent.classList.remove('hidden');

  try {
    const { config } = await apiFetch('/config');
    for (const key of CFG_FIELDS) {
      const el = cfgInput(key);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!config[key];
      else el.value = config[key] ?? '';
    }

    // Carregar chaves de API
    try {
      const keysRes = await apiFetch('/keys');
      if (keysRes && keysRes.ok && keysRes.keys) {
        const keys = keysRes.keys;
        document.getElementById('key-in-deriv-appid').value = keys.deriv.app_id || '';
        document.getElementById('key-in-deriv-account').value = keys.deriv.account_id || '';

        document.getElementById('key-in-binance-key').value = keys.binance.api_key || '';
        document.getElementById('key-in-binance-secret').value = keys.binance.secret_key || '';
      }
    } catch (errKeys) {
      console.warn('Erro ao carregar chaves de API:', errKeys.message);
    }

    modal.classList.remove('hidden');
  } catch (e) { alert('Não foi possível carregar a configuração: ' + e.message); }
}

function closeConfigModal() { modal.classList.add('hidden'); }

async function saveConfig() {
  const btn = document.getElementById('config-save');
  btn.disabled = true;
  try {
    // 1. Salvar Configurações Operacionais
    const updates = {};
    for (const key of CFG_FIELDS) {
      const el = cfgInput(key);
      if (!el) continue;
      if (el.type === 'checkbox')    updates[key] = el.checked;
      else if (el.type === 'number') updates[key] = parseFloat(el.value);
      else                           updates[key] = el.value;
    }
    const res  = await fetch(`${apiUrl}/config`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(updates) });
    const data = await res.json();
    
    // 2. Salvar Chaves de API das Corretoras
    const keysUpdates = {
      deriv: {
        app_id:     document.getElementById('key-in-deriv-appid').value,
        account_id: document.getElementById('key-in-deriv-account').value
      },
      binance: {
        api_key:    document.getElementById('key-in-binance-key').value,
        secret_key: document.getElementById('key-in-binance-secret').value
      }
    };
    
    const keysRes = await fetch(`${apiUrl}/keys`, { 
      method:'POST', 
      headers:{'Content-Type':'application/json'}, 
      body:JSON.stringify(keysUpdates) 
    });
    const keysData = await keysRes.json();

    if (data.ok && keysData.ok) {
      const n = Object.keys(data.applied ?? {}).length;
      let msg = n === 0 ? '✓ Configurações e chaves salvas.' : `✓ ${n} parâmetro(s) e chaves aplicados`;
      if (data.reconnectRequired) msg += ' — reconectando...';
      else msg += ' ao vivo.';
      
      showFeedback(msg, true);
      if (data.config) currentCfg = data.config;
      setTimeout(() => { candlesLoaded = false; init(); }, data.reconnectRequired ? 4000 : 500);
    } else {
      const errs = Object.entries(data.errors ?? {}).map(([k,v]) => `${k}: ${v}`).join(' | ');
      const keyErr = keysData.error ? ` | Chaves: ${keysData.error}` : '';
      showFeedback('✗ ' + (errs || data.error || keyErr || 'Erro ao salvar'), false);
    }
  } catch (e) { showFeedback('✗ Falha de conexão: ' + e.message, false); }
  finally { btn.disabled = false; }
}

document.getElementById('config-open').addEventListener('click', openConfigModal);
document.getElementById('config-close').addEventListener('click', closeConfigModal);
document.getElementById('config-cancel').addEventListener('click', closeConfigModal);
document.getElementById('config-save').addEventListener('click', saveConfig);
modal.addEventListener('click', e => { if (e.target === modal) closeConfigModal(); });

// ─── Backtest Modal ───────────────────────────────────────────────────────────
const btModal    = document.getElementById('backtest-modal');
const btCodeText = document.getElementById('backtest-code');

async function openBacktestModal() {
  try {
    const data = await apiFetch('/backtest/pine');
    if (data && data.ok) {
      btCodeText.value = data.pine;
      btModal.classList.remove('hidden');
    } else {
      alert('Erro ao gerar backtest: ' + (data?.error || 'Erro desconhecido'));
    }
  } catch (e) {
    alert('Não foi possível conectar ao robô: ' + e.message);
  }
}

function closeBacktestModal() {
  btModal.classList.add('hidden');
}

function copyBacktestCode() {
  btCodeText.select();
  document.execCommand('copy');
  const btn = document.getElementById('backtest-copy');
  const oldText = btn.textContent;
  btn.textContent = 'Copiado!';
  setTimeout(() => { btn.textContent = oldText; }, 2000);
}

function downloadBacktestFile() {
  const code = btCodeText.value;
  const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backtest_${currentCfg.SYMBOL || 'strategy'}.pine`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById('btn-backtest-open').addEventListener('click', openBacktestModal);
document.getElementById('backtest-close').addEventListener('click', closeBacktestModal);
document.getElementById('backtest-ok').addEventListener('click', closeBacktestModal);
document.getElementById('backtest-copy').addEventListener('click', copyBacktestCode);
document.getElementById('backtest-download').addEventListener('click', downloadBacktestFile);
btModal.addEventListener('click', e => { if (e.target === btModal) closeBacktestModal(); });

// ─── Chat de IA (Workers AI) ──────────────────────────────────────────────────
const chatPanel    = document.getElementById('chat-panel');
const chatMessages = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input-text');
const chatSendBtn  = document.getElementById('chat-send-btn');
const chatToggle   = document.getElementById('chat-toggle');
const chatCloseBtn = document.getElementById('chat-close-btn');

let chatHistory = [];
const workerUrl = 'https://alexisprofit-ai-worker.dev-teste.workers.dev';

function appendChatMessage(text, role) {
  const msg = document.createElement('div');
  msg.className = `chat-msg ${role}`;
  msg.innerHTML = text.replace(/\n/g, '<br>');
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return msg;
}

chatToggle.addEventListener('click', () => {
  chatPanel.classList.toggle('hidden');
});

chatCloseBtn.addEventListener('click', () => {
  chatPanel.classList.add('hidden');
});

async function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = '';
  appendChatMessage(text, 'user');

  const loadingMsg = appendChatMessage('Analisando mercado...', 'loading');

  try {
    const res = await fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: chatHistory.slice(-10), // manter as últimas 10 mensagens na memória
        state: {
          symbol: latestStatus.symbol,
          timeframe: latestStatus.timeframe,
          currentPrice: latestStatus.currentPrice,
          equity: latestStatus.equity,
          dailyPnL: latestStatus.dailyPnL,
          position: latestStatus.position,
          config: latestStatus.config
        }
      })
    });

    const data = await res.json();
    chatMessages.removeChild(loadingMsg);

    if (data && data.ok) {
      appendChatMessage(data.response, 'system');
      chatHistory.push({ role: 'user', content: text });
      chatHistory.push({ role: 'assistant', content: data.response });
    } else {
      appendChatMessage('Erro: Não foi possível processar a resposta.', 'system');
    }
  } catch (e) {
    if (chatMessages.contains(loadingMsg)) chatMessages.removeChild(loadingMsg);
    appendChatMessage('Erro de conexão com a IA.', 'system');
  }
}

chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

document.querySelectorAll('.chat-shortcut-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    chatInput.value = btn.dataset.msg;
    sendChat();
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
init();
setInterval(pollStatus, 5000);

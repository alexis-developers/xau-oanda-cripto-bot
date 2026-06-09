// ─── Colors — never scatter these through the code ───────────────────────────
const COLORS = {
  bull:        '#00e676',
  bear:        '#ff1744',
  sma:         '#ffb300',
  entry:       '#2196f3',
  sl:          '#ff1744',
  tp1:         '#00e676',
  breakeven:   '#ffb300',
  buyMarker:   '#00e676',
  sellMarker:  '#ff1744',
  bg:          '#0d1117',
  grid:        '#1e2430',
  text:        '#8b949e',
  border:      '#30363d',
};

// ─── API URL (configurable — stored in localStorage) ─────────────────────────
let apiUrl = localStorage.getItem('roland_api_url') || 'https://xau-bot.desenvolvimentodesites.dev.br';

const apiInput = document.getElementById('api-url-input');
apiInput.value = apiUrl;
document.getElementById('api-url-save').addEventListener('click', () => {
  apiUrl = apiInput.value.trim().replace(/\/$/, '');
  localStorage.setItem('roland_api_url', apiUrl);
  init();
});

// ─── Chart Setup ─────────────────────────────────────────────────────────────
const chartEl = document.getElementById('chart-main');

const chart = LightweightCharts.createChart(chartEl, {
  layout: {
    background:  { color: COLORS.bg },
    textColor:   COLORS.text,
    fontFamily:  "'JetBrains Mono', monospace",
    fontSize:    11,
  },
  grid: {
    vertLines:   { color: COLORS.grid },
    horzLines:   { color: COLORS.grid },
  },
  crosshair: {
    mode: LightweightCharts.CrosshairMode.Normal,
  },
  rightPriceScale: {
    borderColor: COLORS.border,
    scaleMargins: { top: 0.08, bottom: 0.08 },
  },
  timeScale: {
    borderColor: COLORS.border,
    timeVisible: true,
    secondsVisible: false,
  },
});

const candleSeries = chart.addCandlestickSeries({
  upColor:          COLORS.bull,
  downColor:        COLORS.bear,
  borderUpColor:    COLORS.bull,
  borderDownColor:  COLORS.bear,
  wickUpColor:      COLORS.bull,
  wickDownColor:    COLORS.bear,
});

const smaSeries = chart.addLineSeries({
  color:       COLORS.sma,
  lineWidth:   2,
  title:       'SMA 20',
  priceLineVisible: false,
  lastValueVisible: true,
});

// Price lines for active position
let entryLine = null;
let slLine    = null;
let tp1Line   = null;

function clearPriceLines() {
  if (entryLine) { candleSeries.removePriceLine(entryLine); entryLine = null; }
  if (slLine)    { candleSeries.removePriceLine(slLine);    slLine    = null; }
  if (tp1Line)   { candleSeries.removePriceLine(tp1Line);   tp1Line   = null; }
}

function drawPriceLines(pos) {
  clearPriceLines();
  if (!pos) return;

  entryLine = candleSeries.createPriceLine({
    price:     pos.entryPrice,
    color:     COLORS.entry,
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dashed,
    title:     `Entry ${pos.side.toUpperCase()}`,
  });

  slLine = candleSeries.createPriceLine({
    price:     pos.sl,
    color:     COLORS.sl,
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dotted,
    title:     pos.isBreakeven ? 'BE / Trailing' : 'SL',
  });

  if (!pos.tp1Hit) {
    tp1Line = candleSeries.createPriceLine({
      price:     pos.tp1Price,
      color:     COLORS.tp1,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dotted,
      title:     'TP1 (80%)',
    });
  }
}

// Resize chart on window resize
new ResizeObserver(() => {
  chart.applyOptions({
    width:  chartEl.clientWidth,
    height: chartEl.clientHeight,
  });
}).observe(chartEl);

// ─── Indicators ───────────────────────────────────────────────────────────────
let smaPeriod = 20;

function calcSMA(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

// ─── Chart Data ───────────────────────────────────────────────────────────────
function applyCandles(candles) {
  const lwCandles = candles.map(c => ({
    time:  c.time,
    open:  c.open,
    high:  c.high,
    low:   c.low,
    close: c.close,
  }));
  candleSeries.setData(lwCandles);

  const closes   = candles.map(c => c.close);
  const smaVals  = calcSMA(closes, smaPeriod);
  const smaData  = smaVals
    .map((v, i) => v !== null ? { time: candles[i].time, value: v } : null)
    .filter(Boolean);
  smaSeries.setData(smaData);
}

function applyTradeMarkers(trades) {
  const markers = trades
    .filter(t => t.type === 'entry' || t.type === 'partial_tp' || t.type === 'stop_loss')
    .map(t => {
      const isBuy  = t.side === 'buy'  || t.type === 'entry' && t.side === 'buy';
      const isExit = t.type === 'partial_tp' || t.type === 'stop_loss';
      return {
        time:     Math.floor(t.timestamp / 1000),
        position: isExit
          ? (t.side === 'sell' ? 'aboveBar' : 'belowBar')
          : (t.side === 'buy' ? 'belowBar' : 'aboveBar'),
        color:    isExit ? COLORS.tp1 : (t.side === 'buy' ? COLORS.buyMarker : COLORS.sellMarker),
        shape:    isExit ? 'circle' : (t.side === 'buy' ? 'arrowUp' : 'arrowDown'),
        text:     isExit
          ? `${t.type === 'stop_loss' ? 'SL' : 'TP1'} ${t.pnl >= 0 ? '+' : ''}${t.pnl?.toFixed(2) ?? ''}$`
          : `${t.side.toUpperCase()} ${t.price?.toFixed(2) ?? ''}`,
      };
    })
    .sort((a, b) => a.time - b.time);

  candleSeries.setMarkers(markers);
}

// ─── Status & UI Updates ─────────────────────────────────────────────────────
function updateStatusDot(ok) {
  const dot = document.getElementById('status-dot');
  dot.className = ok ? 'connected' : 'error';
}

function setStatValue(id, value, cls = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.className = 'stat-value' + (cls ? ' ' + cls : '');
}

function updateStats(status) {
  const price = status.currentPrice;
  setStatValue('stat-price', price ? price.toFixed(2) : '—');

  const eq = parseFloat(status.equity);
  setStatValue('stat-equity', `$${eq.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);

  const pnl = parseFloat(status.dailyPnL);
  setStatValue('stat-daily-pnl', `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, pnl >= 0 ? 'positive' : 'negative');

  setStatValue('stat-sma',  status.config?.SMA_PERIOD  ?? '—');
  setStatValue('stat-risk', `${status.config?.RISK_PERC ?? '—'}%`);

  document.getElementById('env-badge').className  = `badge ${status.usePractice ? 'practice' : 'live'}`;
  document.getElementById('env-badge').textContent = status.usePractice ? 'PRACTICE' : 'LIVE';
  document.getElementById('tf-badge').textContent  = status.timeframe ?? '—';
}

function updateConfig(cfg) {
  if (!cfg) return;
  document.getElementById('cfg-sma').textContent   = cfg.SMA_PERIOD;
  document.getElementById('cfg-slope').textContent = cfg.SLOPE_THRESHOLD;
  document.getElementById('cfg-sl').textContent    = cfg.SL_POINTS;
  document.getElementById('cfg-trail').textContent = cfg.TRAILING_BUFFER;
  document.getElementById('cfg-tp1').textContent   = cfg.TP1_RATIO + ':1';
  document.getElementById('cfg-tp1c').textContent  = cfg.TP1_CLOSE_PERC + '%';
  document.getElementById('cfg-risk').textContent  = cfg.RISK_PERC + '%';
  document.getElementById('cfg-daily').textContent = cfg.DAILY_LOSS_PERC + '%';
  smaPeriod = cfg.SMA_PERIOD ?? 20;
}

function updatePosition(pos) {
  const card = document.getElementById('position-card');
  if (!pos) {
    card.className = 'position-card flat';
    card.innerHTML = '<span style="font-size:12px">Sem posição aberta</span>';
    clearPriceLines();
    return;
  }

  const isLong = pos.side === 'buy';
  card.className = `position-card ${isLong ? 'long' : 'short'}`;
  card.innerHTML = `
    <div class="pos-header">
      <span class="pos-side ${isLong ? 'long' : 'short'}">${isLong ? '▲ LONG' : '▼ SHORT'}</span>
      <span style="color:#8b949e;font-size:11px">${pos.remainingUnits} oz</span>
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
  const recent = [...trades].reverse().slice(0, 20);
  list.innerHTML = recent.map(t => {
    const pnl    = typeof t.pnl === 'number' ? t.pnl : null;
    const pnlStr = pnl !== null
      ? `<span class="trade-pnl ${pnl >= 0 ? 'pos' : 'neg'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</span>`
      : '<span class="trade-pnl" style="color:#8b949e">—</span>';
    const dt = new Date(t.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="trade-item">
        <span class="trade-side ${t.side}">${t.side.toUpperCase()} <span style="color:#8b949e;font-weight:400">${t.type?.replace('_', ' ')}</span></span>
        <span style="color:#8b949e">${dt}</span>
        ${pnlStr}
      </div>
    `;
  }).join('');
}

function updateLogs(lines) {
  const terminal = document.getElementById('log-terminal');
  terminal.innerHTML = lines.map(line => {
    let cls = 'log-line info';
    if (line.includes('[WARNING]')) cls = 'log-line warning';
    else if (line.includes('[ERROR]')) cls = 'log-line error';
    else if (line.includes('==='))    cls = 'log-line system';
    const text = line.replace(/^[\d\-T:.Z]+\s/, '');
    return `<div class="${cls}">${text}</div>`;
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
        new Date(last.time * 1000).toLocaleString('pt-BR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
  } catch (e) {
    console.warn('Candles fetch failed:', e.message);
  }
}

async function pollStatus() {
  try {
    const [status, trades, logs] = await Promise.all([
      apiFetch('/status'),
      apiFetch('/trades'),
      apiFetch('/logs')
    ]);

    updateStatusDot(true);
    updateStats(status);
    updateConfig(status.config);
    updatePosition(status.position);
    updateTrades(trades);
    updateLogs(logs);

    // Reload candles periodically to keep chart fresh
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

// ─── Start ────────────────────────────────────────────────────────────────────
init();
setInterval(pollStatus, 5000); // poll every 5s

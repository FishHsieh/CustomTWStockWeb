// 股市追蹤網站 - 前端邏輯 (純靜態，讀本機 data/ 底下的 JSON)

if (window.ChartDataLabels) {
  Chart.register(ChartDataLabels);
  Chart.defaults.set("plugins.datalabels", { display: false });
}

let TICKERS = null;
let META = null;
let ETF_HOLDINGS = null;
let MACRO = null;
let CURRENT_TAB = "stocks";
const CACHE = {}; // code -> stock json

const MACRO_LABELS = {
  gold: { label: "黃金 (GC=F)", fmt: (v) => "$" + v.toFixed(1) },
  oil_wti: { label: "原油 WTI (CL=F)", fmt: (v) => "$" + v.toFixed(2) },
  us10y_yield: { label: "美債10年殖利率", fmt: (v) => v.toFixed(2) + "%" },
  taiex: { label: "台股加權指數", fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
  usdtwd: { label: "美元/台幣", fmt: (v) => v.toFixed(3) },
};

async function loadJSON(path) {
  const res = await fetch(path + "?v=" + Date.now());
  if (!res.ok) throw new Error(`載入失敗: ${path}`);
  return res.json();
}

async function loadStock(code) {
  if (CACHE[code]) return CACHE[code];
  const data = await loadJSON(`data/stocks/${code}.json`);
  CACHE[code] = data;
  return data;
}

function pctChange(series) {
  if (!series || series.length < 2) return null;
  const first = series[0].c, last = series[series.length - 1].c;
  if (!first) return null;
  return ((last - first) / first) * 100;
}

function renderSparkline(canvas, series) {
  const values = series.map((p) => p.c);
  const min = Math.min(...values), max = Math.max(...values);
  const w = canvas.width = canvas.clientWidth * 2;
  const h = canvas.height = canvas.clientHeight * 2;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const up = values[values.length - 1] >= values[0];
  ctx.strokeStyle = up ? "#ef4444" : "#22c55e";
  ctx.lineWidth = 3;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * (h - 6) - 3;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function renderMacroPanel() {
  const grid = document.getElementById("macro-grid");
  grid.innerHTML = "";
  Object.entries(MACRO_LABELS).forEach(([key, cfg]) => {
    const series = MACRO[key] || [];
    if (!series.length) return;
    const last = series[series.length - 1].c;
    const chg = pctChange(series);
    const card = document.createElement("div");
    card.className = "macro-card";
    card.innerHTML = `
      <div class="label">${cfg.label}</div>
      <div class="value">${cfg.fmt(last)}</div>
      <div class="change ${chg >= 0 ? "up" : "down"}">近一年 ${chg >= 0 ? "▲" : "▼"} ${Math.abs(chg).toFixed(1)}%</div>
      <canvas></canvas>
    `;
    grid.appendChild(card);
    renderSparkline(card.querySelector("canvas"), series);
  });
}

let marketFlowChart = null;
let futuresFlowChart = null;

let indexCharts = {};

function renderIndexCharts() {
  if (!window.LightweightCharts) return;
  const configs = [
    { key: "taiex", host: "taiex-index-chart", label: "大盤" },
    { key: "otc", host: "otc-index-chart", label: "櫃買" },
  ];
  const maLines = [
    { key: "ma10", label: "10日", color: "#f59e0b" },
    { key: "ma20", label: "20日", color: "#a78bfa" },
    { key: "ma60", label: "60日", color: "#38bdf8" },
    { key: "ma240", label: "240日", color: "#f472b6" },
  ];
  configs.forEach(({ key, host: hostId, label }) => {
    const host = document.getElementById(hostId);
    const raw = MACRO[key] || [];
    if (!host || !raw.length) return;
    if (indexCharts[key]) indexCharts[key].remove();
    host.innerHTML = "";
    const readout = document.createElement("div");
    readout.className = "index-readout";
    host.appendChild(readout);
    const legend = document.createElement("div");
    legend.className = "index-legend";
    host.appendChild(legend);
    const chartEl = document.createElement("div");
    chartEl.className = "index-chart-canvas";
    host.appendChild(chartEl);
    const rows = raw.filter((p) => p.c !== null && p.c !== undefined).map((p) => ({
      t: p.t, o: p.o ?? p.c, h: p.h ?? p.c, l: p.l ?? p.c, c: p.c, v: p.v ?? 0,
    }));
    if (!rows.length) return;
    const chart = LightweightCharts.createChart(chartEl, {
      width: chartEl.clientWidth,
      height: 340,
      layout: { background: { color: "#171a21" }, textColor: "#e8eaed" },
      grid: { vertLines: { color: "#2a2f3a" }, horzLines: { color: "#2a2f3a" } },
      timeScale: { timeVisible: false },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: "#8b93a7", width: 1, style: 3, labelBackgroundColor: "#3a4152" },
        horzLine: { visible: false, labelVisible: false },
      },
    });
    const candle = chart.addCandlestickSeries({
      upColor: "#ef4444", downColor: "#22c55e",
      borderUpColor: "#ef4444", borderDownColor: "#22c55e",
      wickUpColor: "#ef4444", wickDownColor: "#22c55e",
    });
    candle.setData(rows.map((p) => ({ time: p.t, open: p.o, high: p.h, low: p.l, close: p.c })));
    const volume = chart.addHistogramSeries({ priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volume.setData(rows.filter((p) => p.v > 0).map((p) => ({ time: p.t, value: p.v, color: p.c >= p.o ? "#ef4444" : "#22c55e" })));
    const closes = rows.map((p) => p.c);
    maLines.forEach((ma) => {
      const data = movingAverage(closes, Number(ma.key.slice(2))).map((value, i) => value === null ? null : ({ time: rows[i].t, value })).filter(Boolean);
      const line = chart.addLineSeries({ color: ma.color, lineWidth: 1, title: ma.label, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      line.setData(data);
      const item = document.createElement("span");
      item.innerHTML = `<i style="background:${ma.color}"></i>${ma.label}`;
      legend.appendChild(item);
    });
    const rowDates = new Map(rows.map((p, i) => [p.t, i]));
    const renderIndexReadout = (idx) => {
      const row = rows[idx] || rows[rows.length - 1];
      const prev = idx > 0 ? rows[idx - 1] : null;
      const diff = prev ? row.c - prev.c : null;
      const cls = diff === null ? "" : diff > 0 ? "up" : diff < 0 ? "down" : "flat";
      const n = (value) => Number(value).toFixed(2);
      readout.innerHTML = `<span class="date">${row.t}</span>` +
        `<span>\u958b <b>${n(row.o)}</b></span>` +
        `<span>\u9ad8 <b>${n(row.h)}</b></span>` +
        `<span>\u4f4e <b>${n(row.l)}</b></span>` +
        `<span>\u6536 <b class="${cls}">${n(row.c)}</b></span>` +
        (row.v ? `<span>\u91cf <b>${Math.round(row.v / 1000).toLocaleString()}</b> \u5343</span>` : "");
    };
    renderIndexReadout(rows.length - 1);
    chart.subscribeCrosshairMove((param) => {
      const bar = param.seriesData && param.seriesData.get(candle);
      if (!bar || param.time === undefined || param.time === null) {
        renderIndexReadout(rows.length - 1);
        return;
      }
      const time = typeof param.time === "object"
        ? `${param.time.year}-${String(param.time.month).padStart(2, "0")}-${String(param.time.day).padStart(2, "0")}`
        : String(param.time);
      const idx = rowDates.get(time);
      renderIndexReadout(idx === undefined ? rows.length - 1 : idx);
    });
    chart.timeScale().fitContent();
    indexCharts[key] = chart;
  });
}
function renderMarketFlowChart() {
  const canvas = document.getElementById("market-flow-chart");
  const foreign = (MACRO.foreign_net || []).slice(-120);
  const trust = (MACRO.trust_net || []).slice(-120);
  const dealer = (MACRO.dealer_net || []).slice(-120);
  const retail = (MACRO.retail_net || []).slice(-120);
  if (!foreign.length) return;
  if (marketFlowChart) { marketFlowChart.destroy(); marketFlowChart = null; }
  marketFlowChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: foreign.map((p) => p.t.slice(5)),
      datasets: [
        { label: "外資買賣超", data: foreign.map((p) => p.c), borderColor: "#38bdf8", backgroundColor: "transparent", tension: 0.15, pointRadius: 0, pointHitRadius: 8, borderWidth: 1.5 },
        { label: "投信買賣超", data: trust.map((p) => p.c), borderColor: "#eab308", backgroundColor: "transparent", tension: 0.15, pointRadius: 0, pointHitRadius: 8, borderWidth: 1.5 },
        { label: "自營商買賣超", data: dealer.map((p) => p.c), borderColor: "#a78bfa", backgroundColor: "transparent", tension: 0.15, pointRadius: 0, pointHitRadius: 8, borderWidth: 1.5 },
        { label: "散戶買賣超(反推)", data: retail.map((p) => p.c), borderColor: "#ef4444", backgroundColor: "transparent", tension: 0.15, pointRadius: 0, pointHitRadius: 8, borderWidth: 1.5 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: true, aspectRatio: 6,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, labels: { color: "#9aa1ac", boxWidth: 14 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} 億元` } } },
      scales: { x: { ticks: { color: "#9aa1ac", maxTicksLimit: 10 } }, y: { ticks: { color: "#9aa1ac" } } } },
  });
}

function renderFuturesFlowChart() {
  const canvas = document.getElementById("futures-flow-chart");
  const foreign = (MACRO.foreign_futures_net || []).slice(-120);
  const trust = (MACRO.trust_futures_net || []).slice(-120);
  if (!foreign.length) return;
  if (futuresFlowChart) { futuresFlowChart.destroy(); futuresFlowChart = null; }
  futuresFlowChart = new Chart(canvas, {
    type: "line",
    data: {
      labels: foreign.map((p) => p.t.slice(5)),
      datasets: [
        { label: "外資台指期淨部位", data: foreign.map((p) => p.c), borderColor: "#ef4444", backgroundColor: "transparent", tension: 0.15, pointRadius: 0, pointHitRadius: 8, borderWidth: 1.5 },
        { label: "投信台指期淨部位", data: trust.map((p) => p.c), borderColor: "#22c55e", backgroundColor: "transparent", tension: 0.15, pointRadius: 0, pointHitRadius: 8, borderWidth: 1.5 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: true, aspectRatio: 6,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: true, labels: { color: "#9aa1ac", boxWidth: 14 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()} 口` } } },
      scales: { x: { ticks: { color: "#9aa1ac", maxTicksLimit: 10 } }, y: { ticks: { color: "#9aa1ac" } } } },
  });
}

function fmtNum(v, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return Number(v).toFixed(digits);
}

async function buildCards(codes, kind) {
  const cards = [];
  for (const code of codes) {
    try {
      const s = await loadStock(code);
      const latestYoy = kind === "stock" && s.revenue && s.revenue.length
        ? s.revenue.filter(r => r.yoy_pct !== null).slice(-1)[0]
        : null;
      const latestPe = kind === "stock" && s.pe && s.pe.length
        ? s.pe.filter(p => p.pe !== null).slice(-1)[0]
        : null;
      const latestPrice = s.price && s.price.length ? s.price[s.price.length - 1] : null;
      const volume = latestPrice && latestPrice.v !== null && latestPrice.v !== undefined ? Number(latestPrice.v) : null;
      const amount = latestPrice && volume !== null && latestPrice.c !== null ? volume * Number(latestPrice.c) : null;
      cards.push({
        code,
        name: (TICKERS.names && TICKERS.names[code]) || code,
        kind,
        close: s.latest_close,
        volume,
        amount,
        yield: s.trailing_yield_pct,
        yoy: latestYoy ? latestYoy.yoy_pct : null,
        pe: latestPe ? latestPe.pe : null,
      });
    } catch (e) {
      console.warn("無法載入", code, e);
    }
  }
  return cards;
}

function renderCards(cards) {
  const grid = document.getElementById("card-grid");
  grid.innerHTML = "";
  if (!cards.length) {
    grid.innerHTML = `<p style="color:var(--text-dim)">沒有符合的資料，可能還沒跑過 fetch_data.py。</p>`;
    return;
  }
  cards.forEach((c) => {
    const el = document.createElement("div");
    el.className = "stock-card";
    el.innerHTML = `
      <div class="code">${c.code} <span class="kind-badge">${c.kind === "stock" ? "個股" : "ETF"}</span></div>
      <div style="font-size:13px;color:var(--text-dim);margin-top:2px">${c.name}</div>
      <div class="price">${c.close !== null && c.close !== undefined ? c.close : "—"}</div>
      <div class="row"><span>殖利率</span><b>${c.yield !== null && c.yield !== undefined ? c.yield.toFixed(2) + "%" : "—"}</b></div>
      ${c.kind === "stock" ? `<div class="row"><span>最新月營收YoY</span><b class="${c.yoy >= 0 ? "up" : "down"}">${c.yoy !== null ? c.yoy.toFixed(1) + "%" : "—"}</b></div>` : ""}
      ${c.kind === "stock" ? `<div class="row"><span>本益比</span><b>${c.pe !== null ? c.pe.toFixed(1) : "—"}</b></div>` : ""}
    `;
    el.addEventListener("click", () => openDetail(c.code, c.kind, c.name));
    grid.appendChild(el);
  });
}

let sortMode = "code";
let searchTerm = "";
let allCardsByTab = { stocks: [], banks: [], etfs: [], bonds: [] };

function applyFilterSort() {
  let cards = [...allCardsByTab[CURRENT_TAB]];
  if (searchTerm) {
    cards = cards.filter((c) => c.code.includes(searchTerm) || c.name.includes(searchTerm));
  }
  if (sortMode === "volume-desc") {
    cards.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
  } else if (sortMode === "amount-desc") {
    cards.sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1));
  } else if (sortMode === "yield-desc") {
    cards.sort((a, b) => (b.yield ?? -999) - (a.yield ?? -999));
  } else if (sortMode === "yoy-desc") {
    cards.sort((a, b) => (b.yoy ?? -999) - (a.yoy ?? -999));
  } else if (sortMode === "pe-asc") {
    const peKey = (c) => (c.pe !== null && c.pe > 0) ? c.pe : Infinity;
    cards.sort((a, b) => peKey(a) - peKey(b));
  } else {
    cards.sort((a, b) => a.code.localeCompare(b.code));
  }
  renderCards(cards);
}

function codesForTab(tab) {
  const bonds = new Set(TICKERS.bonds || []);
  const banks = new Set(TICKERS.banks || []);
  if (tab === "banks") return [...banks];
  if (tab === "bonds") return [...bonds];
  if (tab === "stocks") return TICKERS.stocks.filter((code) => !banks.has(code));
  return TICKERS.etfs.filter((code) => !bonds.has(code));
}

async function switchTab(tab) {
  CURRENT_TAB = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (!allCardsByTab[tab].length) {
    const kind = (tab === "stocks" || tab === "banks") ? "stock" : "etf";
    allCardsByTab[tab] = await buildCards(codesForTab(tab), kind);
  }
  applyFilterSort();
}

let candleChart = null;
let epsChart = null;
let revChart = null;
let peChart = null;
let retailChart = null;
let institutionalChart = null;

// ---- 還原K線 ------------------------------------------------------------
// 除權息和股票分割會讓股價出現「斷層」(例如 0050 在 2025-06-18 從 188 變成 47)，
// 那不是真的跌，只是分割。打開「還原K線」就會把斷層前的歷史價按比例縮放，
// 讓整條線可以直接比較。採前復權：最新一天維持真實市價，只調整歷史。
let ADJUSTED = false;
try { ADJUSTED = localStorage.getItem("kline-adjusted") === "1"; } catch (e) {}
let CURRENT_STOCK = null;

const MA_WINDOWS = { ma10: 10, ma20: 20, ma60: 60, ma240: 240 };

// 每根K棒要乘的比例 = 它「之後」所有調整事件 factor 的連乘積
function cumAdjFactors(price, events) {
  const f = new Array(price.length).fill(1);
  let cum = 1;
  let ei = events.length - 1;
  for (let i = price.length - 1; i >= 0; i--) {
    while (ei >= 0 && events[ei].date > price[i].t) { cum *= events[ei].factor; ei--; }
    f[i] = cum;
  }
  return f;
}

// 移動平均，算法和 scripts/fetch_data.py 一致：不滿一個週期的前幾根留 null
function movingAverage(closes, window) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= window) sum -= closes[i - window];
    if (i + 1 >= window) out[i] = sum / window;
  }
  return out;
}

// 畫圖要用的資料：沒開還原(或這檔本來就沒有除權息/分割)就直接用抓下來的原始資料
function chartRows(s) {
  const price = s.price || [];
  const events = s.adjustments || [];
  if (!ADJUSTED || !events.length || !price.length) return price;
  const f = cumAdjFactors(price, events);
  const scale = (v, i) => (v === null || v === undefined ? null : v * f[i]);
  const rows = price.map((p, i) => ({
    t: p.t, v: p.v,
    o: scale(p.o, i), h: scale(p.h, i), l: scale(p.l, i), c: scale(p.c, i),
  }));
  // 均線要用還原後的收盤價重算，否則均線會和K棒對不起來
  const closes = rows.map((r) => r.c);
  Object.keys(MA_WINDOWS).forEach((key) => {
    const ma = movingAverage(closes, MA_WINDOWS[key]);
    rows.forEach((r, i) => { r[key] = ma[i]; });
  });
  return rows;
}

function setAdjusted(on) {
  ADJUSTED = on;
  try { localStorage.setItem("kline-adjusted", on ? "1" : "0"); } catch (e) {}
  const btn = document.getElementById("adj-toggle");
  if (btn) btn.classList.toggle("active", on);
  if (CURRENT_STOCK) drawCandle(CURRENT_STOCK);
}

function drawCandle(s) {
  if (candleChart) { candleChart.remove(); candleChart = null; }
  const rows = chartRows(s);   // 原始或還原後的K棒，後面的畫法完全一樣

  // 按鈕狀態 + 旁邊的說明：這檔到底有沒有東西可以還原，講清楚比較不會誤會
  const btn = document.getElementById("adj-toggle");
  const note = document.getElementById("adj-note");
  const events = s.adjustments || [];
  if (btn) btn.classList.toggle("active", ADJUSTED);
  if (note) {
    if (!events.length) {
      note.textContent = "（此標的近期無除權息/分割，還原前後相同）";
    } else if (ADJUSTED) {
      const kinds = [...new Set(events.map((e) => e.kind))].join("、");
      note.textContent = `已還原 ${events.length} 次${kinds}（最新價維持實際市價）`;
    } else {
      note.textContent = "顯示原始股價（未還原除權息/分割）";
    }
  }
  const candleEl = document.getElementById("candle-chart");
  candleEl.innerHTML = "";
  const legendEl = document.getElementById("ma-legend");
  legendEl.innerHTML = "";
  const readoutEl = document.getElementById("ohlc-readout");
  readoutEl.innerHTML = "";
  if (window.LightweightCharts && rows.length) {
    candleChart = LightweightCharts.createChart(candleEl, {
      width: candleEl.clientWidth,
      height: 320,
      layout: { background: { color: "#171a21" }, textColor: "#e8eaed" },
      grid: { vertLines: { color: "#2a2f3a" }, horzLines: { color: "#2a2f3a" } },
      timeScale: { timeVisible: false },
      crosshair: {
        // 垂直線跟著滑鼠走；水平線關掉、改用下面的 priceLine 自己畫，
        // 這樣橫向移動時縱軸一定「對到那天的收盤價」，而不是飄在滑鼠的高度。
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: "#8b93a7", width: 1, style: 3, labelBackgroundColor: "#3a4152" },
        horzLine: { visible: false, labelVisible: false },
      },
    });
    const series = candleChart.addCandlestickSeries({
      upColor: "#ef4444", downColor: "#22c55e",
      borderUpColor: "#ef4444", borderDownColor: "#22c55e",
      wickUpColor: "#ef4444", wickDownColor: "#22c55e",
    });
    series.setData(rows.map((p) => ({ time: p.t, open: p.o, high: p.h, low: p.l, close: p.c })));

    // 在 K 線下方顯示成交量，紅綠色跟隨當日漲跌。
    const volumeSeries = candleChart.addHistogramSeries({
      priceScaleId: "",
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    candleChart.priceScale("").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volumeSeries.setData(rows
      .filter((p) => p.v !== null && p.v !== undefined)
      .map((p) => ({
        time: p.t,
        value: p.v,
        color: p.c >= p.o ? "#ef4444" : "#22c55e",
      })));

    // 在除息交易日的 K 棒下方標註「息」，並顯示股利金額。
    const rowDates = new Set(rows.map((p) => p.t));
    const dividendMarkers = (s.dividends || [])
      .filter((d) => d.ex_date && rowDates.has(d.ex_date))
      .map((d) => {
        const parts = [];
        if (d.cash_per_share) parts.push(`現金${d.cash_per_share}`);
        if (d.stock_per_share) parts.push(`股票${d.stock_per_share}`);
        return {
          time: d.ex_date,
          position: "belowBar",
          color: "#f59e0b",
          shape: "circle",
          text: `息 ${parts.join(" ")}`,
        };
      });
    if (dividendMarkers.length && typeof series.setMarkers === "function") {
      series.setMarkers(dividendMarkers);
    }

    const MA_LINES = [
      { key: "ma10", label: "10日", color: "#f59e0b" },
      { key: "ma20", label: "月線", color: "#a78bfa" },
      { key: "ma60", label: "季線", color: "#38bdf8" },
      { key: "ma240", label: "年線", color: "#f472b6" },
    ];
    const maLegends = [];  // 記住每條均線的 series 和它的 <b>，滑到哪天就換成那天的值
    MA_LINES.forEach((ma) => {
      const data = rows
        .filter((p) => p[ma.key] !== null && p[ma.key] !== undefined)
        .map((p) => ({ time: p.t, value: p[ma.key] }));
      if (!data.length) return;
      const lineSeries = candleChart.addLineSeries({
        color: ma.color, lineWidth: 1, title: ma.label,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      lineSeries.setData(data);
      const lastVal = data[data.length - 1].value;
      const span = document.createElement("span");
      span.innerHTML = `<i style="background:${ma.color}"></i>${ma.label} <b>${lastVal.toFixed(2)}</b>`;
      legendEl.appendChild(span);
      maLegends.push({ series: lineSeries, valueEl: span.querySelector("b"), lastVal });
    });

    // 水平線：預設停在最新收盤價，滑鼠橫向移動時跟著換成「當天的收盤價」，
    // 右邊價格軸上也會同時出現那個價格的標籤。
    const lastBar = rows[rows.length - 1];
    const closeLine = series.createPriceLine({
      price: lastBar.c,
      color: "#e8b341",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: "",
    });

    // lightweight-charts 回傳的 time 有可能是 "2026-09-21" 字串，也可能是
    // { year, month, day } 物件，兩種都轉成 YYYY-MM-DD 再查，比較保險。
    const timeKey = (t) =>
      t && typeof t === "object"
        ? `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`
        : String(t);
    const idxByTime = new Map(rows.map((p, i) => [p.t, i]));

    const renderReadout = (idx) => {
      const row = idx === null || idx === undefined ? null : rows[idx];
      if (!row) { readoutEl.innerHTML = ""; return; }
      const prev = idx > 0 ? rows[idx - 1] : null;
      const diff = prev ? row.c - prev.c : null;
      const pct = prev && prev.c ? (diff / prev.c) * 100 : null;
      const cls = diff === null ? "" : diff > 0 ? "up" : diff < 0 ? "down" : "";
      const n = (v) => (v === null || v === undefined ? "—" : v.toFixed(2));
      let html =
        `<span class="date">${row.t}</span>` +
        `<span>開 <b>${n(row.o)}</b></span>` +
        `<span>高 <b>${n(row.h)}</b></span>` +
        `<span>低 <b>${n(row.l)}</b></span>` +
        `<span>收 <b class="${cls}">${n(row.c)}</b></span>`;
      if (diff !== null) {
        const sign = diff > 0 ? "+" : "";
        html += `<span>漲跌 <b class="${cls}">${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)</b></span>`;
      }
      // 成交量維持「當天實際成交張數」，不隨還原縮放：那是真的成交了幾張，
      // 不像價格那樣需要換算成同一個基準。還原模式下標註一下避免誤會。
      if (row.v) {
        const volTip = ADJUSTED ? ' title="成交量是當天實際張數，不隨還原調整"' : "";
        html += `<span${volTip}>量 <b>${Math.round(row.v / 1000).toLocaleString()}</b> 張${ADJUSTED ? "*" : ""}</span>`;
      }
      readoutEl.innerHTML = html;
    };

    renderReadout(rows.length - 1);

    candleChart.subscribeCrosshairMove((param) => {
      const bar = param.seriesData && param.seriesData.get(series);
      if (!bar) {
        // 滑出圖表 -> 回到最新一天
        closeLine.applyOptions({ price: lastBar.c });
        renderReadout(rows.length - 1);
        maLegends.forEach((m) => { m.valueEl.textContent = m.lastVal.toFixed(2); });
        return;
      }
      closeLine.applyOptions({ price: bar.close });
      const idx = idxByTime.get(timeKey(param.time));
      // 萬一日期對不起來就先不顯示讀數；價格線已經用十字線的收盤價設好了，價格軸仍然是對的
      renderReadout(idx === undefined ? null : idx);
      maLegends.forEach((m) => {
        const pt = param.seriesData.get(m.series);
        m.valueEl.textContent = pt && pt.value !== undefined ? pt.value.toFixed(2) : "—";
      });
    });

    candleChart.timeScale().fitContent();
  }
}

async function openDetail(code, kind, name) {
  const modal = document.getElementById("detail-modal");
  modal.classList.remove("hidden");
  document.getElementById("modal-title").textContent = `${code}　${name}`;

  const s = await loadStock(code);

  // K線（含「還原K線」開關；開關切換時就重畫一次）
  CURRENT_STOCK = s;
  drawCandle(s);

  // 三大法人(外資/投信/自營商)買賣超 (K線下方)
  const instCanvas = document.getElementById("institutional-chart");
  const instEmpty = document.getElementById("institutional-empty");
  if (institutionalChart) { institutionalChart.destroy(); institutionalChart = null; }
  const instSeries = (s.retail_flow || []).slice(-60);
  if (instSeries.length) {
    instEmpty.classList.add("hidden");
    instCanvas.classList.remove("hidden");
    institutionalChart = new Chart(instCanvas, {
      type: "line",
      data: {
        labels: instSeries.map((p) => p.date.slice(5)),
        datasets: [
          { label: "外資", data: instSeries.map((p) => p.foreign_lots), borderColor: "#38bdf8", backgroundColor: "transparent", tension: 0.15, pointRadius: 0, pointHitRadius: 8, borderWidth: 1.5 },
          { label: "投信", data: instSeries.map((p) => p.trust_lots), borderColor: "#eab308", backgroundColor: "transparent", tension: 0.15, pointRadius: 0, pointHitRadius: 8, borderWidth: 1.5 },
          { label: "自營商", data: instSeries.map((p) => p.dealer_lots), borderColor: "#a78bfa", backgroundColor: "transparent", tension: 0.15, pointRadius: 0, pointHitRadius: 8, borderWidth: 1.5 },
        ],
      },
      options: { responsive: true, maintainAspectRatio: true, aspectRatio: 6,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: true, labels: { color: "#9aa1ac", boxWidth: 14 } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()} 張` } } },
        scales: { x: { ticks: { color: "#9aa1ac", maxTicksLimit: 10 } }, y: { ticks: { color: "#9aa1ac" } } } },
    });
  } else {
    instCanvas.classList.add("hidden");
    instEmpty.classList.remove("hidden");
  }

  // EPS
  const epsCanvas = document.getElementById("eps-chart");
  const epsEmpty = document.getElementById("eps-empty");
  if (epsChart) { epsChart.destroy(); epsChart = null; }
  if (s.eps && s.eps.length) {
    epsEmpty.classList.add("hidden");
    epsCanvas.classList.remove("hidden");
    epsChart = new Chart(epsCanvas, {
      type: "bar",
      data: {
        labels: s.eps.map((e) => e.date.slice(0, 7)),
        datasets: [{ label: "EPS (元)", data: s.eps.map((e) => e.eps), backgroundColor: "#3b82f6" }],
      },
      options: { responsive: true, layout: { padding: { top: 16 } },
        plugins: { legend: { display: false },
          datalabels: { display: true, anchor: "end", align: "top", clamp: true, color: "#e8eaed", font: { size: 10 },
            formatter: (v) => v.toFixed(2) } },
        scales: { x: { ticks: { color: "#9aa1ac" } }, y: { ticks: { color: "#9aa1ac" } } } },
    });
  } else {
    epsCanvas.classList.add("hidden");
    epsEmpty.classList.remove("hidden");
  }

  // 月營收YoY
  const revCanvas = document.getElementById("rev-chart");
  const revEmpty = document.getElementById("rev-empty");
  if (revChart) { revChart.destroy(); revChart = null; }
  if (s.revenue && s.revenue.length) {
    revEmpty.classList.add("hidden");
    revCanvas.classList.remove("hidden");
    const recent = s.revenue.slice(-18);
    revChart = new Chart(revCanvas, {
      type: "bar",
      data: {
        labels: recent.map((r) => `${r.year}/${String(r.month).padStart(2, "0")}`),
        datasets: [
          { label: "YoY %", data: recent.map((r) => r.yoy_pct), backgroundColor: "#f59e0b" },
          { label: "MoM %", data: recent.map((r) => r.mom_pct), backgroundColor: "#38bdf8" },
        ],
      },
      options: { responsive: true, plugins: { legend: { display: true, labels: { color: "#9aa1ac" } } },
        scales: { x: { ticks: { color: "#9aa1ac" } }, y: { ticks: { color: "#9aa1ac" } } } },
    });
  } else {
    revCanvas.classList.add("hidden");
    revEmpty.classList.remove("hidden");
  }

  // 本益比(PE)
  const peCanvas = document.getElementById("pe-chart");
  const peEmpty = document.getElementById("pe-empty");
  if (peChart) { peChart.destroy(); peChart = null; }
  const peSeries = (s.pe || []).filter((p) => p.pe !== null);
  if (peSeries.length) {
    peEmpty.classList.add("hidden");
    peCanvas.classList.remove("hidden");
    peChart = new Chart(peCanvas, {
      type: "line",
      data: {
        labels: peSeries.map((p) => p.date.slice(0, 7)),
        datasets: [{
          label: "本益比 (TTM)", data: peSeries.map((p) => p.pe),
          borderColor: "#a78bfa", backgroundColor: "rgba(167,139,250,.15)",
          tension: 0.2, fill: true, pointRadius: 3,
        }],
      },
      options: { responsive: true, maintainAspectRatio: true, aspectRatio: 5,
        layout: { padding: { top: 16 } },
        plugins: { legend: { display: false },
          datalabels: { display: true, align: "top", offset: 4, clamp: true, color: "#e8eaed", font: { size: 10 },
            formatter: (v) => v.toFixed(1) } },
        scales: { x: { ticks: { color: "#9aa1ac" } }, y: { ticks: { color: "#9aa1ac" } } } },
    });
  } else {
    peCanvas.classList.add("hidden");
    peEmpty.classList.remove("hidden");
  }

  // 散戶買賣超(反推)
  const retailCanvas = document.getElementById("retail-chart");
  const retailEmpty = document.getElementById("retail-empty");
  if (retailChart) { retailChart.destroy(); retailChart = null; }
  const retailSeries = (s.retail_flow || []).slice(-60);
  if (retailSeries.length) {
    retailEmpty.classList.add("hidden");
    retailCanvas.classList.remove("hidden");
    retailChart = new Chart(retailCanvas, {
      type: "bar",
      data: {
        labels: retailSeries.map((p) => p.date.slice(5)),
        datasets: [{
          label: "散戶買賣超(張)", data: retailSeries.map((p) => p.retail_lots),
          backgroundColor: retailSeries.map((p) => p.retail_lots >= 0 ? "#ef4444" : "#22c55e"),
        }],
      },
      options: { responsive: true, maintainAspectRatio: true, aspectRatio: 5,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}` } } },
        scales: { x: { ticks: { color: "#9aa1ac", maxTicksLimit: 10 } }, y: { ticks: { color: "#9aa1ac" } } } },
    });
  } else {
    retailCanvas.classList.add("hidden");
    retailEmpty.classList.remove("hidden");
  }

  // 配息
  const tbody = document.querySelector("#div-table tbody");
  const divEmpty = document.getElementById("div-empty");
  tbody.innerHTML = "";
  const recentDiv = (s.dividends || []).slice(-10).reverse();
  if (recentDiv.length) {
    divEmpty.classList.add("hidden");
    document.getElementById("div-table").classList.remove("hidden");
    recentDiv.forEach((d) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${d.ex_date}</td><td>${fmtNum(d.prev_close)}</td><td>${fmtNum(d.cash_per_share)}</td><td>${fmtNum(d.stock_per_share)}</td><td>${fmtNum(d.ex_dividend_price)}</td><td>${d.pay_date || "—"}</td>`;
      tbody.appendChild(tr);
    });
  } else {
    document.getElementById("div-table").classList.add("hidden");
    divEmpty.classList.remove("hidden");
  }
  renderETFHoldings(s);
}

function renderETFHoldings(stock) {
  const block = document.getElementById("etf-holdings-block");
  const tbody = document.querySelector("#etf-holdings-table tbody");
  const empty = document.getElementById("etf-holdings-empty");
  if (!block || !tbody || !empty) return;
  const item = ETF_HOLDINGS && ETF_HOLDINGS.items && ETF_HOLDINGS.items[stock.code];
  const rows = item && Array.isArray(item.holdings) ? item.holdings : [];
  tbody.innerHTML = "";
  if (stock.kind !== "etf" || !rows.length) {
    block.classList.add("hidden");
    return;
  }
  block.classList.remove("hidden");
  empty.classList.add("hidden");
  rows.forEach((holding) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${holding.rank}</td><td>${holding.code}</td><td>${holding.name}</td><td>${Number(holding.weight).toFixed(2)}%</td>`;
    tbody.appendChild(tr);
  });
  const date = item.source_date ? String(item.source_date).slice(0, 10) : "";
  document.getElementById("etf-holdings-updated").textContent = date ? "\u8cc7\u6599\u65e5\u671f\uff1a" + date : "";
}
function closeDetail() {
  document.getElementById("detail-modal").classList.add("hidden");
  if (candleChart) { candleChart.remove(); candleChart = null; }
}

async function init() {
  TICKERS = await loadJSON("data/tickers.json");
  try { META = await loadJSON("data/meta.json"); } catch (e) { META = null; }
  try { ETF_HOLDINGS = await loadJSON("data/etf_holdings.json"); } catch (e) { ETF_HOLDINGS = null; }
  MACRO = await loadJSON("data/macro.json");

  document.getElementById("stock-count").textContent = codesForTab("stocks").length;
  document.getElementById("bank-count").textContent = codesForTab("banks").length;
  document.getElementById("etf-count").textContent = codesForTab("etfs").length;
  document.getElementById("bond-count").textContent = codesForTab("bonds").length;
  if (!META) {
    document.getElementById("updated-at").textContent = "尚未執行「更新資料.bat」，目前沒有資料";
  } else {
    // 「什麼時候跑的」和「資料到哪一天」是兩回事：三大法人要當天下午4點後才公布，
    // 太早跑就只會抓到前一個交易日。兩個都顯示出來，才不會以為看到的是最新的。
    let txt = `資料更新時間：${META.updated_at}`;
    const dates = [];
    // 上櫃(櫃買個股、債券ETF)收盤價比上市晚公布，兩邊不同天時要分開講，
    // 不然標一個「今天」會讓一堆其實還停在昨天的上櫃卡片看起來像最新的。
    const twse = META.price_date_twse, tpex = META.price_date_tpex;
    if (twse && tpex && twse !== tpex) {
      dates.push(`收盤價 上市 ${twse}／上櫃 ${tpex}`);
    } else if (META.price_date) {
      dates.push(`收盤價 ${META.price_date}`);
    }
    if (META.institutional_date) dates.push(`三大法人 ${META.institutional_date}`);
    if (dates.length) txt += `（資料日期：${dates.join("、")}）`;
    if (META.status === "partial_quota_exceeded") {
      txt += `（免費資料額度用完，只抓到 ${META.stock_count}/${META.stock_total} 個股、${META.etf_count}/${META.etf_total} ETF，約1小時後重跑「更新資料.bat」補齊）`;
    }
    document.getElementById("updated-at").textContent = txt;
  }

  const adjBtn = document.getElementById("adj-toggle");
  adjBtn.classList.toggle("active", ADJUSTED);
  adjBtn.addEventListener("click", () => setAdjusted(!ADJUSTED));

  renderMacroPanel();
  renderIndexCharts();
  renderMarketFlowChart();
  renderFuturesFlowChart();
  await switchTab("stocks");

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  document.getElementById("search-box").addEventListener("input", (e) => {
    searchTerm = e.target.value.trim();
    applyFilterSort();
  });
  document.getElementById("sort-select").addEventListener("change", (e) => {
    sortMode = e.target.value;
    applyFilterSort();
  });
  document.getElementById("modal-close").addEventListener("click", closeDetail);
  document.getElementById("detail-modal").addEventListener("click", (e) => {
    if (e.target.id === "detail-modal") closeDetail();
  });
}

init().catch((e) => {
  console.error(e);
  document.getElementById("card-grid").innerHTML =
    `<p style="color:#ef4444">載入失敗：${e.message}。請先在 scripts 資料夾執行 fetch_data.py 產生資料。</p>`;
});

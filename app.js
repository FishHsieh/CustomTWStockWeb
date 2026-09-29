// 股市追蹤網站 - 前端邏輯 (純靜態，讀本機 data/ 底下的 JSON)

if (window.ChartDataLabels) {
  Chart.register(ChartDataLabels);
  Chart.defaults.set("plugins.datalabels", { display: false });
}

let TICKERS = null;
let META = null;
let ETF_HOLDINGS = null;
let MANAGER_CHANGES = null;
let FOREIGN_FLOW = null;
let DIVIDEND_ETF_FLOW = null;
let MACRO = null;
let CURRENT_TAB = "stocks";
let CURRENT_DETAIL = null;
const CACHE = {}; // code -> stock json

const MACRO_LABELS = {
  gold: { label: "黃金 (GC=F)", fmt: (v) => "$" + v.toFixed(1) },
  oil_wti: { label: "原油 WTI (CL=F)", fmt: (v) => "$" + v.toFixed(2) },
  us10y_yield: { label: "美債10年殖利率", fmt: (v) => v.toFixed(2) + "%" },
  taiex: { label: "台股加權指數", fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
  nikkei225: { label: "日本大盤（日經225）", fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
  kospi: { label: "韓國大盤（KOSPI）", fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
  philadelphia_semiconductor: { label: "費城半導體", fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
  nasdaq: { label: "那斯達克", fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
  vietnam: { label: "越南大盤", fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
  sp500: { label: "S&P 500", fmt: (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
  btc_usd: { label: "比特幣（BTC/USD）", fmt: (v) => "$" + v.toLocaleString(undefined, { maximumFractionDigits: 0 }) },
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

function isTrackedCode(code) {
  return (TICKERS?.stocks || []).includes(code) || (TICKERS?.etfs || []).includes(code);
}

function emptyStockRecord(code, kind) {
  return { code, kind, price: [], dividends: [], adjustments: [], retail_flow: [], eps: [], revenue: [], pe: [] };
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
  if (values.length === 1) {
    // 部分海外指數來源暫時只回傳最新一筆，仍顯示目前值，不讓折線因 0/0 變成 NaN 而消失。
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 4, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    return;
  }
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

function renderSmartPicks() {
  const tbody = document.querySelector("#smart-picks-table tbody");
  const empty = document.getElementById("smart-picks-empty");
  const summary = document.getElementById("smart-picks-summary");
  if (!tbody || !TICKERS) return;
  const smartHeader = document.querySelector("#smart-picks-table thead tr");
  if (smartHeader && smartHeader.children.length < 13) {
    ["融資餘額", "融券餘額", "券資比"].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      smartHeader.appendChild(th);
    });
  }

  const stocks = (TICKERS.stocks || []).filter((code) => !(TICKERS.banks || []).includes(code));
  const etfBuyMap = new Map();
  const etfNames = new Map();
  Object.values(MANAGER_CHANGES?.items || {}).forEach((etf) => {
    (etf.events || []).forEach((event) => {
      const delta = Number(event.delta_lots || 0);
      if (delta > 0 && /^\d{4}$/.test(String(event.code))) {
        const item = etfBuyMap.get(event.code) || { lots: 0, etfs: [] };
        item.lots += delta;
        if (!item.etfs.includes(etf.code)) item.etfs.push(etf.code);
        etfBuyMap.set(event.code, item);
        etfNames.set(etf.code, etf.name || etf.code);
      }
    });
  });

  const picks = [];
  stocks.forEach((code) => {
    const s = CACHE[code];
    if (!s || !s.price || s.price.length < 62 || !s.retail_flow?.length) return;
    const rows = adjustedTechnicalRows(s).filter((p) => p.c !== null && p.v !== null && p.ma60 !== null);
    if (rows.length < 22) return;
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const flow = s.retail_flow;
    const lastFlow = flow[flow.length - 1];
    let streak = 0;
    for (let i = flow.length - 1; i >= 0; i--) {
      if (Number(flow[i].institutional_lots || 0) > 0) streak++;
      else break;
    }
    const priorVolumes = rows.slice(-21, -1).map((p) => Number(p.v || 0)).filter(Boolean);
    const avgVolume = priorVolumes.reduce((sum, v) => sum + v, 0) / priorVolumes.length;
    const volumeRatio = avgVolume ? Number(last.v) / avgVolume : 0;
    const breakout = Number(last.c) > Number(last.ma60) && Number(prev.c) <= Number(prev.ma60);
    if (Number(last.c) <= Number(last.ma60)) return;
    const streakOk = streak >= 3;
    const breakoutOk = breakout;
    const volumeOk = volumeRatio >= 1.2;
    const score = (streakOk ? 4 : streak > 0 ? 2 : 0) + (breakoutOk ? 3 : 0) + (volumeOk ? 3 : volumeRatio >= 1 ? 1 : 0);
    const etf = etfBuyMap.get(code);
    const credit = s.margin || s.margin_credit || s.credit || {};
    const financing = credit.financing_balance ?? s.financing_balance ?? null;
    const shortBalance = credit.short_balance ?? s.short_balance ?? null;
    const shortMarginRatio = financing ? (Number(shortBalance || 0) / Number(financing)) * 100 : null;
    picks.push({
      code,
      name: TICKERS.names?.[code] || code,
      close: Number(last.c),
      streak,
      foreign: Number(lastFlow.foreign_lots || 0),
      trust: Number(lastFlow.trust_lots || 0),
      dealer: Number(lastFlow.dealer_lots || 0),
      institutional: Number(lastFlow.institutional_lots || 0),
      ma60: Number(last.ma60),
      volumeRatio,
      etfLots: etf?.lots || 0,
      etfs: etf?.etfs || [],
      streakOk,
      breakoutOk,
      volumeOk,
      score,
      financing,
      shortBalance,
      shortMarginRatio,
    });
  });

  const strictCount = picks.filter((row) => row.streakOk && row.breakoutOk && row.volumeOk).length;
  picks.sort((a, b) => (b.score - a.score) || (b.streak - a.streak) || (b.institutional - a.institutional) || (b.volumeRatio - a.volumeRatio));
  const selected = picks.slice(0, 30);
  tbody.innerHTML = "";
  selected.forEach((row, index) => {
    const fmtLots = (v) => `<span class="${v >= 0 ? "up" : "down"}">${v >= 0 ? "+" : ""}${Math.round(v).toLocaleString("zh-TW")}</span>`;
    const etfLabel = row.etfs.length ? `${row.etfs.join(", ")} +${Math.round(row.etfLots).toLocaleString("zh-TW")} 張` : "未見近期增持";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${index + 1}</td><td><b>${row.code}</b> ${row.name}</td><td>${row.close.toLocaleString("zh-TW")}</td>` +
      `<td><span class="signal-badge ${row.streakOk ? "yes" : "no"}">${row.streak} 日${row.streakOk ? " ✓" : ""}</span></td><td>${fmtLots(row.foreign)}</td><td>${fmtLots(row.trust)}</td><td>${fmtLots(row.dealer)}</td>` +
      `<td>${row.ma60.toFixed(2)} <span class="signal-badge ${row.breakoutOk ? "yes" : "no"}">${row.breakoutOk ? "突破" : "站上"}</span></td><td class="${row.volumeOk ? "up" : "neutral"}">${row.volumeRatio.toFixed(1)} 倍${row.volumeOk ? " ✓" : ""}</td>` +
      `<td>${row.etfs.length ? `<span class="signal-badge yes">有</span> <small>${etfLabel}</small>` : `<span class="signal-badge no">無</span>`}</td>`;
    tr.insertAdjacentHTML("beforeend", `<td>${row.financing == null ? "—" : Number(row.financing).toLocaleString("zh-TW") + " 張"}</td>` +
      `<td>${row.shortBalance == null ? "—" : Number(row.shortBalance).toLocaleString("zh-TW") + " 張"}</td>` +
      `<td>${row.shortMarginRatio == null ? "—" : row.shortMarginRatio.toFixed(1) + "%"}</td>`);
    tr.addEventListener("click", () => openDetail(row.code, "stock", row.name));
    tr.style.cursor = "pointer";
    tbody.appendChild(tr);
  });
  empty.classList.toggle("hidden", selected.length > 0);
  summary.textContent = `完全符合 ${strictCount} 檔｜顯示 ${selected.length} 檔`;
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
      t: p.t, o: p.o ?? p.c, h: p.h ?? p.c, l: p.l ?? p.c, c: p.c, v: p.v ?? 0, a: p.a ?? 0,
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
    // 大盤成交金額資料是元，圖表統一以「億元」呈現。
    volume.setData(rows.filter((p) => p.a > 0).map((p) => ({ time: p.t, value: p.a / 1e8, color: p.c >= p.o ? "#ef4444" : "#22c55e" })));
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
        (row.a ? `<span>\u91cf <b>${(row.a / 1e8).toFixed(2)}</b> \u5104</span>` : "");
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
    const lastDate = new Date(`${rows[rows.length - 1].t}T00:00:00Z`);
    const firstVisibleDate = new Date(lastDate);
    firstVisibleDate.setUTCMonth(firstVisibleDate.getUTCMonth() - 6);
    const firstVisibleRow = rows.find((row) => new Date(`${row.t}T00:00:00Z`) >= firstVisibleDate) || rows[0];
    chart.timeScale().setVisibleRange({ from: firstVisibleRow.t, to: rows[rows.length - 1].t });
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

const MA_WINDOWS = { ma5: 5, ma10: 10, ma20: 20, ma60: 60, ma240: 240 };

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

function adjustedTechnicalRows(stock) {
  const price = stock.price || [];
  if (!price.length) return [];
  const events = stock.adjustments || [];
  const factors = events.length ? cumAdjFactors(price, events) : new Array(price.length).fill(1);
  const rows = price.map((point, index) => {
    const scale = (value) => value === null || value === undefined ? null : Number(value) * factors[index];
    return { ...point, o: scale(point.o), h: scale(point.h), l: scale(point.l), c: scale(point.c) };
  });
  const closes = rows.map((point) => point.c);
  [5, 10, 20, 60].forEach((window) => {
    const values = movingAverage(closes, window);
    rows.forEach((point, index) => { point[`ma${window}`] = values[index]; });
  });
  return rows;
}

// 畫圖要用的資料：沒開還原(或這檔本來就沒有除權息/分割)就直接用抓下來的原始資料
function chartRows(s) {
  const price = s.price || [];
  const events = s.adjustments || [];
  if (!ADJUSTED || !events.length || !price.length) {
    const rows = price.map((point) => ({ ...point }));
    const closes = rows.map((point) => point.c);
    const ma5 = movingAverage(closes, 5);
    rows.forEach((point, index) => { point.ma5 = ma5[index]; });
    return rows;
  }
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
      { key: "ma5", label: "5日", color: "#fb7185" },
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
    // 個股 K 線預設聚焦最近六個月，完整歷史資料仍保留供左右拖曳查看。
    const lastDate = new Date(`${rows[rows.length - 1].t}T00:00:00Z`);
    const firstVisibleDate = new Date(lastDate);
    firstVisibleDate.setUTCMonth(firstVisibleDate.getUTCMonth() - 6);
    const firstVisibleRow = rows.find((row) => new Date(`${row.t}T00:00:00Z`) >= firstVisibleDate) || rows[0];
    candleChart.timeScale().setVisibleRange({ from: firstVisibleRow.t, to: rows[rows.length - 1].t });
  }
}

async function openDetail(code, kind, name) {
  const modal = document.getElementById("detail-modal");
  modal.classList.remove("hidden");
  document.getElementById("modal-title").textContent = `${code}　${name}`;
  CURRENT_DETAIL = { code, kind, name };
  const trackButton = document.getElementById("detail-track-update");
  const trackStatus = document.getElementById("detail-track-status");
  const tracked = isTrackedCode(code);
  let s = emptyStockRecord(code, kind);
  let loadError = null;
  if (tracked) {
    try {
      s = await loadStock(code);
    } catch (error) {
      loadError = error;
    }
  }
  if (trackButton) {
    trackButton.classList.toggle("hidden", tracked && !loadError);
    trackButton.disabled = false;
    trackButton.textContent = tracked ? "重新抓取完整資料" : "加入追蹤並抓取完整資料";
  }
  if (trackStatus) {
    trackStatus.classList.toggle("hidden", tracked && !loadError);
    trackStatus.textContent = !tracked
      ? "此標的尚未追蹤；不讀取本機舊快取。加入後會抓取最新 K 線、法人、營收、EPS、配息與還原資料。"
      : loadError ? `讀取最新資料失敗：${loadError.message}。不顯示舊快取，請重新抓取。` : "";
  }

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
  const divTitle = document.querySelector("#div-table")?.previousElementSibling;
  let yieldReadout = document.getElementById("dividend-yield-readout");
  if (!yieldReadout && divTitle) {
    yieldReadout = document.createElement("span");
    yieldReadout.id = "dividend-yield-readout";
    yieldReadout.className = "dividend-yield-readout";
    divTitle.appendChild(yieldReadout);
  }
  const latestPrice = Number(s.latest_close ?? s.price?.at(-1)?.c ?? 0);
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 365);
  const trailingDividends = (s.dividends || []).filter((dividend) => dividend.ex_date && new Date(`${dividend.ex_date}T00:00:00Z`) >= cutoffDate);
  const trailingCash = trailingDividends.reduce((sum, dividend) => sum + Number(dividend.cash_per_share || 0), 0);
  const liveYield = latestPrice > 0 ? (trailingCash / latestPrice) * 100 : null;
  if (yieldReadout) {
    yieldReadout.textContent = liveYield == null
      ? "即時年殖利率：—"
      : `即時年殖利率：${liveYield.toFixed(2)}%（近一年配息 ${trailingCash.toFixed(2)}／最新價 ${latestPrice.toFixed(2)}）`;
  }
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

function renderManagerChanges() {
  const table = document.getElementById("manager-changes-table");
  const tbody = table && table.querySelector("tbody");
  const empty = document.getElementById("manager-changes-empty");
  const period = document.getElementById("manager-changes-period");
  if (!tbody || !MANAGER_CHANGES || !MANAGER_CHANGES.items) {
    if (table) table.classList.add("hidden");
    if (empty) empty.classList.remove("hidden");
    return;
  }
  const etfSelect = document.getElementById("manager-etf-select");
  if (etfSelect) {
    const configuredItems = [...Object.values(MANAGER_CHANGES.items),
      { code: "00982A", name: "00982A" },
      { code: "00992A", name: "00992A" },
      { code: "00403A", name: "00403A" }];
    configuredItems.forEach((item) => {
      if (!item?.code || etfSelect.querySelector(`option[value="${item.code}"]`)) return;
      const option = document.createElement("option");
      option.value = item.code;
      option.textContent = `${item.code} ${item.name || ""}`.trim();
      etfSelect.appendChild(option);
    });
  }
  const detailHeader = document.querySelector("#manager-changes-table thead tr");
  if (detailHeader && detailHeader.children.length < 9) {
    const th = document.createElement("th");
    th.textContent = "目前淨持有張數";
    detailHeader.insertBefore(th, detailHeader.children[6]);
  }
  const etf = document.getElementById("manager-etf-select")?.value || "all";
  const actionFilter = document.getElementById("manager-action-select")?.value || "all";
  const rows = Object.values(MANAGER_CHANGES.items)
    .filter((item) => etf === "all" || item.code === etf)
    .flatMap((item) => (item.events || []).map((row) => ({ ...row, etf: item.code })))
    .filter((row) => actionFilter === "all" ||
      (actionFilter === "買進" && ["新進", "加碼"].includes(row.action)) ||
      (actionFilter === "賣出" && ["剔除", "減碼"].includes(row.action)))
    .sort((a, b) => `${b.date}${b.etf}${b.code}`.localeCompare(`${a.date}${a.etf}${a.code}`));
  const selected = etf === "all" ? Object.values(MANAGER_CHANGES.items) : [MANAGER_CHANGES.items[etf]];
  const from = selected.map((item) => item && item.from).filter(Boolean).sort()[0];
  const to = selected.map((item) => item && item.to).filter(Boolean).sort().pop();
  period.textContent = from && to ? `資料期間：${from}～${to}｜共 ${rows.length} 筆` : "";
  tbody.innerHTML = "";
  table.classList.toggle("hidden", !rows.length);
  empty.classList.toggle("hidden", Boolean(rows.length));
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const delta = Number(row.delta_lots || 0);
    const tone = delta > 0 ? "up" : "down";
    const price = row.price == null ? "—" : Number(row.price).toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const estimated = row.estimated_amount == null ? "—" : `${(Math.abs(row.estimated_amount) / 10000).toLocaleString("zh-TW", { maximumFractionDigits: 1 })} 萬`;
    tr.innerHTML = `<td>${row.date}</td><td>${row.etf}</td><td>${row.code} ${row.name}</td>` +
      `<td class="${tone}">${row.action}</td><td class="${tone}">${delta > 0 ? "+" : ""}${delta.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td>${(Number(row.shares_prev || 0) / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} → ${(Number(row.shares || 0) / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td title="${row.price_label || ""}">${price}</td><td>${estimated}</td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll("tr").forEach((tr, index) => {
    const row = rows[index];
    tr.children[1].classList.add("link-cell");
    tr.children[1].addEventListener("click", () => openDetail(row.etf, "etf", row.etf));
    tr.children[2].classList.add("link-cell");
    tr.children[2].addEventListener("click", () => openDetail(row.code, "stock", row.name));
    const td = document.createElement("td");
    td.innerHTML = row.shares == null ? "—" : `<b>${(Number(row.shares) / 1000).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</b>`;
    tr.insertBefore(td, tr.children[6]);
  });
  renderManagerTopMoversByPeriod();
}

function renderManagerTopMovers() {
  const tbody = document.querySelector("#manager-top-movers-table tbody");
  if (!tbody) return;
  const names = {
    "00981A": "00981A",
    "00991A": "00991A",
    "00990A": "00990A",
    "00992A": "00992A",
    "00982A": "00982A",
    "00403A": "00403A",
  };
  tbody.innerHTML = "";
  (MANAGER_CHANGES.top_movers || []).forEach((row, index) => {
    const net = Number(row.net_lots || 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${index + 1}</td><td>${row.code} ${row.name}</td><td>${(row.etfs || []).map((code) => names[code] || code).join("、")}</td>` +
      `<td class="up">+${Number(row.buy_lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td class="down">-${Number(row.sell_lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td>${Number(row.turnover_lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td class="${net >= 0 ? "up" : "down"}">${net >= 0 ? "+" : ""}${net.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td>${row.event_count || 0}</td>`;
    tbody.appendChild(tr);
  });
}

function renderManagerTopMoversByPeriod() {
  const tbody = document.querySelector("#manager-top-movers-table tbody");
  if (!tbody || !MANAGER_CHANGES?.items) return;
  const title = document.querySelector(".manager-top-movers-header h3");
  if (title) title.textContent = "主動式 ETF 合計進出最多 60 檔";
  const header = document.querySelector("#manager-top-movers-table thead tr");
  if (header && header.children.length < 15) {
    ["00981A 淨張數", "00991A 淨張數", "00990A 淨張數", "00992A 淨張數", "00982A 淨張數", "00403A 淨張數", "六檔合計"].forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      header.appendChild(th);
    });
  }
  const periodDays = Number(document.getElementById("manager-top-period-select")?.value || 93);
  const items = Object.values(MANAGER_CHANGES.items).filter(Boolean);
  const allDates = items.flatMap((item) => (item.events || []).map((row) => row.date)).sort();
  const latestDate = allDates[allDates.length - 1];
  if (!latestDate) return;
  const cutoff = new Date(`${latestDate}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - periodDays + 1);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const aggregate = new Map();
  items.forEach((item) => {
    (item.events || []).filter((event) => event.date >= cutoffDate && event.date <= latestDate).forEach((event) => {
      const row = aggregate.get(event.code) || { code: event.code, name: event.name || event.code, buy_lots: 0, sell_lots: 0, event_count: 0, etfs: new Set(), holdings: {} };
      const delta = Number(event.delta_lots || 0);
      if (delta >= 0) row.buy_lots += delta;
      else row.sell_lots += Math.abs(delta);
      row.event_count += 1;
      row.etfs.add(item.code);
      if (event.shares !== null && event.shares !== undefined) {
        const previous = row.holdings[item.code];
        if (!previous || event.date > previous.date) row.holdings[item.code] = { date: event.date, lots: Number(event.shares) / 1000 };
      }
      aggregate.set(event.code, row);
    });
  });
  aggregate.forEach((row) => {
    items.forEach((item) => {
      const latest = (item.events || []).filter((event) => event.code === row.code && event.shares !== null && event.shares !== undefined).sort((a, b) => a.date.localeCompare(b.date)).pop();
      if (latest) row.holdings[item.code] = { date: latest.date, lots: Number(latest.shares) / 1000 };
    });
  });
  const rows = [...aggregate.values()]
    .map((row) => ({ ...row, etfs: [...row.etfs], turnover_lots: row.buy_lots + row.sell_lots, net_lots: row.buy_lots - row.sell_lots, holdings_total: ["00981A", "00991A", "00990A", "00992A", "00982A", "00403A"].reduce((sum, code) => sum + Number(row.holdings[code]?.lots || 0), 0) }))
    .sort((a, b) => b.turnover_lots - a.turnover_lots)
    .slice(0, 60);
  const periodNote = document.getElementById("manager-top-movers-period");
  if (periodNote) periodNote.textContent = `${cutoffDate} ～ ${latestDate}｜三檔 ETF 合計｜共 ${rows.length} 檔`;
  tbody.innerHTML = "";
  rows.forEach((row, index) => {
    const net = Number(row.net_lots || 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${index + 1}</td><td>${row.code} ${row.name}</td><td>${row.etfs.join(", ")}</td>` +
      `<td class="up">+${Number(row.buy_lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td class="down">-${Number(row.sell_lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td>${Number(row.turnover_lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td class="${net >= 0 ? "up" : "down"}">${net >= 0 ? "+" : ""}${net.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td>${row.event_count || 0}</td>` +
      `<td>${Number(row.holdings["00981A"]?.lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td>${Number(row.holdings["00991A"]?.lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td>${Number(row.holdings["00990A"]?.lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td>${Number(row.holdings["00992A"]?.lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td>${Number(row.holdings["00982A"]?.lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td>${Number(row.holdings["00403A"]?.lots || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</td>` +
      `<td><b>${Number(row.holdings_total || 0).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 張</b></td>`;
    tr.children[1].classList.add("link-cell");
    tr.children[1].addEventListener("click", () => openDetail(row.code, "stock", row.name));
    tbody.appendChild(tr);
  });
}

function renderForeignFlow() {
  const empty = document.getElementById("foreign-flow-empty");
  if (!FOREIGN_FLOW) {
    empty.classList.remove("hidden");
    return;
  }
  const selector = document.getElementById("foreign-flow-period-select");
  const period = selector?.value || "93";
  const selected = FOREIGN_FLOW.periods?.[period] || FOREIGN_FLOW;
  document.getElementById("foreign-flow-period").textContent =
    `資料期間：${selected.from}～${selected.to}｜涵蓋網站已抓取個股 ${selected.universe} 檔`;
  const formatLots = (value) => `${Number(value || 0).toLocaleString("zh-TW", { maximumFractionDigits: 0 })} 張`;
  const fill = (id, rows) => {
    const tbody = document.querySelector(`#${id} tbody`);
    tbody.innerHTML = "";
    (rows || []).forEach((row, index) => {
      const net = Number(row.net_lots || 0);
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${index + 1}</td><td>${row.code} ${row.name}</td><td class="up">${formatLots(row.buy_lots)}</td>` +
        `<td class="down">${formatLots(row.sell_lots)}</td><td class="${net >= 0 ? "up" : "down"}">${net >= 0 ? "+" : "-"}${Math.abs(net).toLocaleString("zh-TW", { maximumFractionDigits: 0 })} 張</td><td>${row.days}</td>`;
      tr.children[1].classList.add("link-cell");
      tr.children[1].addEventListener("click", () => openDetail(row.code, "stock", row.name));
      tbody.appendChild(tr);
    });
  };
  fill("foreign-buy-table", selected.top_buy);
  fill("foreign-sell-table", selected.top_sell);
  empty.classList.toggle("hidden", Boolean((selected.top_buy || []).length || (selected.top_sell || []).length));
}

async function renderDividendEtfFlow() {
  const empty = document.getElementById("dividend-etf-flow-empty");
  const tbody = document.querySelector("#dividend-etf-flow-table tbody");
  if (!empty || !tbody) return;
  const periodSelect = document.getElementById("dividend-etf-flow-period-select");
  if (periodSelect && !document.getElementById("dividend-etf-flow-sort-select")) {
    const label = document.createElement("label");
    label.textContent = "排序";
    const sortSelect = document.createElement("select");
    sortSelect.id = "dividend-etf-flow-sort-select";
    sortSelect.innerHTML = `<option value="retail">散戶淨買賣</option><option value="foreign">外資淨買賣</option><option value="trust">投信淨買賣</option>`;
    label.appendChild(sortSelect);
    periodSelect.parentElement.appendChild(label);
    sortSelect.addEventListener("change", renderDividendEtfFlow);
  }
  if (!DIVIDEND_ETF_FLOW) {
    empty.classList.remove("hidden");
    return;
  }
  const period = document.getElementById("dividend-etf-flow-period-select")?.value || "93";
  const selected = DIVIDEND_ETF_FLOW.periods?.[period];
  if (!selected) {
    empty.classList.remove("hidden");
    return;
  }
  const expandedCodes = [...new Set([
    ...(DIVIDEND_ETF_FLOW.codes || []),
    "00900", "00922", "00631L", "00685L", "009816", "00991A", "00981A", "00982A", "00876", "00646", "00924",
    "00909", "00901", "00990A", "00988A", "00911", "009805", "00917", "00885", "00757", "00910",
    "00895", "00635U", "00738U", "00403A"
  ])];
  const knownCodes = new Set((selected.rows || []).map((row) => row.code));
  const extraRows = await Promise.all(expandedCodes.filter((code) => !knownCodes.has(code)).map(async (code) => {
    try {
      const stock = await loadStock(code);
      const flows = (stock.retail_flow || []).filter((row) => row.date >= selected.from && row.date <= selected.to);
      if (!flows.length) return null;
      const metric = (key) => flows.reduce((sum, row) => sum + Number(row[key] || 0), 0);
      const netMetric = (key) => metric(key);
      const split = (value) => ({ buy_lots: Math.max(value, 0), sell_lots: Math.max(-value, 0), net_lots: value });
      return {
        code,
        name: TICKERS.names?.[code] || code,
        days: flows.length,
        foreign: split(netMetric("foreign_lots")),
        trust: split(netMetric("trust_lots")),
        retail: split(netMetric("retail_lots")),
        derived: true,
      };
    } catch (error) {
      return null;
    }
  }));
  const rows = [...(selected.rows || []), ...extraRows.filter(Boolean)];
  const sortKey = document.getElementById("dividend-etf-flow-sort-select")?.value || "retail";
  rows.sort((a, b) => Number(b[sortKey]?.net_lots || 0) - Number(a[sortKey]?.net_lots || 0));
  const technicalByCode = new Map();
  await Promise.all(rows.map(async (row) => {
    try {
      const stock = await loadStock(row.code);
      const prices = adjustedTechnicalRows(stock).filter((point) => point.c !== null && point.c !== undefined);
      if (prices.length < 61) return;
      const last = prices.at(-1);
      const prev = prices.at(-2);
      const signal = (ma, previousMa) => {
        if (ma === null || ma === undefined || previousMa === null || previousMa === undefined) return ["—", "below"];
        if (last.c > ma && prev.c <= previousMa) return ["突破", "breakout"];
        if (last.c < ma && prev.c >= previousMa) return ["跌破", "breakdown"];
        return last.c >= ma ? ["站上", "above"] : ["跌下", "below"];
      };
      technicalByCode.set(row.code, [
        signal(last.ma60, prev.ma60),
        signal(last.ma20, prev.ma20),
        signal(last.ma10, prev.ma10),
        signal(last.ma5, prev.ma5),
      ]);
    } catch (error) {
      technicalByCode.set(row.code, [["—", "below"], ["—", "below"], ["—", "below"], ["—", "below"]]);
    }
  }));
  const headerRow = document.querySelector("#dividend-etf-flow-table thead tr");
  if (headerRow && headerRow.children.length >= 10 && headerRow.dataset.flowOrder !== "retail-first") {
    const headers = [...headerRow.children];
    [0, 7, 8, 9, 1, 2, 3, 4, 5, 6].forEach((index) => headerRow.appendChild(headers[index]));
    headerRow.dataset.flowOrder = "retail-first";
  }
  if (headerRow && headerRow.dataset.techOrder !== "yes") {
    ["季線 60", "月線 20", "10 日線", "5 日線"].reverse().forEach((label) => {
      const th = document.createElement("th");
      th.textContent = label;
      headerRow.insertBefore(th, headerRow.children[1]);
    });
    headerRow.dataset.techOrder = "yes";
  }
  document.getElementById("dividend-etf-flow-period").textContent =
    `資料期間：${selected.from}～${selected.to}`;
  const fmt = (value) => Number(value || 0).toLocaleString("zh-TW", { maximumFractionDigits: 0 });
  const cell = (metric, key) => `<td class="${metric[key + "_lots"] >= 0 ? "up" : "down"}">${fmt(metric[key + "_lots"])}</td>`;
  tbody.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const technicalCells = (technicalByCode.get(row.code) || [["—", "below"], ["—", "below"], ["—", "below"], ["—", "below"]])
      .map(([label, tone]) => `<td><span class="technical-signal ${tone}">${label}</span></td>`).join("");
    tr.innerHTML = `<td>${row.code} ${row.name}</td>` +
      technicalCells +
      cell(row.retail, "buy") + cell(row.retail, "sell") + cell(row.retail, "net") +
      cell(row.foreign, "buy") + cell(row.foreign, "sell") + cell(row.foreign, "net") +
      cell(row.trust, "buy") + cell(row.trust, "sell") + cell(row.trust, "net");
    tr.children[0].classList.add("link-cell");
    tr.children[0].addEventListener("click", () => openDetail(row.code, "etf", row.name));
    tbody.appendChild(tr);
  });
  empty.classList.toggle("hidden", Boolean(rows.length));
}

function renderHighDividendInstitutional() {
  const tbody = document.querySelector("#high-dividend-institutional-table tbody");
  const empty = document.getElementById("high-dividend-institutional-empty");
  if (!tbody || !ETF_HOLDINGS || !TICKERS) return;
  const etfCodes = [...new Set([
    "0050", "0056", "00713", "00878", "00915", "00918", "00919", "00929", "00940", "00944",
    "00922", "00631L", "00685L", "009816", "00991A", "00981A", "00982A", "00876", "00646", "00924",
    "00909", "00901", "00990A", "00988A", "00911", "009805", "00917", "00885", "00757", "00910",
    "00895", "00635U", "00738U", "00403A"
  ])];
  const pool = new Map();
  etfCodes.forEach((etfCode) => {
    const holdings = ETF_HOLDINGS.items?.[etfCode]?.holdings || [];
    holdings.forEach((holding) => {
      if (!/^\d{4}$/.test(String(holding.code))) return;
      const row = pool.get(holding.code) || { etfs: new Set() };
      row.etfs.add(etfCode);
      pool.set(holding.code, row);
    });
  });
  const rows = [];
  pool.forEach((meta, code) => {
    const s = CACHE[code];
    if (!s?.price?.length || !s?.retail_flow?.length) return;
    const prices = adjustedTechnicalRows(s).filter((p) => p.c !== null && p.c !== undefined);
    if (prices.length < 61) return;
    const last = prices[prices.length - 1];
    const prev = prices[prices.length - 2];
    const flows = s.retail_flow.slice(-20);
    const sum = (key) => flows.reduce((total, row) => total + Number(row[key] || 0), 0);
    const foreign = sum("foreign_lots");
    const trust = sum("trust_lots");
    const dealer = sum("dealer_lots");
    const institutional = foreign + trust + dealer;
    const signal = (ma, previousMa) => {
      if (ma === null || ma === undefined || previousMa === null || previousMa === undefined) return ["—", "below"];
      if (last.c > ma && prev.c <= previousMa) return ["突破", "breakout"];
      if (last.c < ma && prev.c >= previousMa) return ["跌破", "breakdown"];
      return last.c >= ma ? ["站上", "above"] : ["跌下", "below"];
    };
    rows.push({ code, name: TICKERS.names?.[code] || code, foreign, trust, dealer, institutional, etfs: [...meta.etfs], signals: [signal(last.ma60, prev.ma60), signal(last.ma20, prev.ma20), signal(last.ma10, prev.ma10), signal(last.ma5, prev.ma5)] });
  });
  rows.sort((a, b) => Math.abs(b.institutional) - Math.abs(a.institutional));
  const selected = rows.slice(0, 30);
  tbody.innerHTML = "";
  const fmt = (value) => `<span class="${value >= 0 ? "up" : "down"}">${value >= 0 ? "+" : ""}${Math.round(value).toLocaleString("zh-TW")}</span>`;
  selected.forEach((row, index) => {
    const tr = document.createElement("tr");
    const signals = row.signals.map(([label, tone]) => `<span class="technical-signal ${tone}">${label}</span>`);
    tr.innerHTML = `<td>${index + 1}</td><td><b>${row.code}</b> ${row.name}</td><td>${fmt(row.foreign)}</td><td>${fmt(row.trust)}</td><td>${fmt(row.dealer)}</td><td>${fmt(row.institutional)}</td>` +
      signals.map((cell) => `<td>${cell}</td>`).join("") + `<td>${row.etfs.join(", ")}</td>`;
    tr.addEventListener("click", () => openDetail(row.code, "stock", row.name));
    tr.style.cursor = "pointer";
    tbody.appendChild(tr);
  });
  empty.classList.toggle("hidden", selected.length > 0);
  const period = document.getElementById("high-dividend-institutional-period");
  if (period && rows.length) {
    const flowDates = Object.values(CACHE).flatMap((stock) => stock.retail_flow || []).map((row) => row.date).sort();
    period.textContent = `法人資料：${flowDates[flowDates.length - 20] || ""} ～ ${flowDates[flowDates.length - 1] || ""}｜顯示 ${selected.length} 檔`;
  }
}

async function addAndUpdateDetail() {
  const current = CURRENT_DETAIL;
  if (!current) return;
  const button = document.getElementById("detail-track-update");
  const status = document.getElementById("detail-track-status");
  if (!button || !status) return;
  button.disabled = true;
  status.classList.remove("hidden");
  status.textContent = `${current.code} 正在寫入追蹤清單並抓取完整新資料…`;
  try {
    const response = await fetch("api/watchlist/add-and-update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(current),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "加入追蹤或更新失敗");
    status.textContent = `${current.code} 已加入追蹤，完整資料更新成功；正在重新整理清單…`;
    // Keep the stock detail available after reloading the watchlist/data files.
    sessionStorage.setItem("detail-after-watchlist-update", JSON.stringify(current));
    setTimeout(() => location.reload(), 900);
  } catch (error) {
    status.textContent = `更新失敗，未顯示舊快取：${error.message}`;
    button.disabled = false;
  }
}

function setupWatchlistManager() {
  document.getElementById("detail-track-update")?.addEventListener("click", addAndUpdateDetail);
  const form = document.getElementById("watchlist-form");
  const status = document.getElementById("watchlist-status");
  if (!form || !status) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = document.getElementById("watchlist-code").value.trim().toUpperCase();
    const kind = document.getElementById("watchlist-kind").value;
    const name = document.getElementById("watchlist-name").value.trim();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    status.textContent = `${code} 已送出，正在加入追蹤清單並抓取資料，請稍候…`;
    try {
      const response = await fetch("api/watchlist/add-and-update", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, kind, name }),
      });
      const update = await response.json();
      if (!response.ok || !update.ok) throw new Error(update.error || "加入追蹤或資料更新失敗");
      status.textContent = `${code} 更新完成，頁面即將重新整理。`;
      setTimeout(() => location.reload(), 700);
    } catch (error) {
      status.textContent = `更新失敗：${error.message}`;
      button.disabled = false;
    }
  });
}
function closeDetail() {
  document.getElementById("detail-modal").classList.add("hidden");
  if (candleChart) { candleChart.remove(); candleChart = null; }
}

async function init() {
  TICKERS = await loadJSON("data/tickers.json");
  try { META = await loadJSON("data/meta.json"); } catch (e) { META = null; }
  try { ETF_HOLDINGS = await loadJSON("data/etf_holdings.json"); } catch (e) { ETF_HOLDINGS = null; }
  try { MANAGER_CHANGES = await loadJSON("data/active_etf_changes.json"); } catch (e) { MANAGER_CHANGES = null; }
  try { FOREIGN_FLOW = await loadJSON("data/foreign_flow.json"); } catch (e) { FOREIGN_FLOW = null; }
  try { DIVIDEND_ETF_FLOW = await loadJSON("data/dividend_etf_flow.json"); } catch (e) { DIVIDEND_ETF_FLOW = null; }
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
  renderManagerChanges();
  document.getElementById("foreign-flow-period-select")?.addEventListener("change", renderForeignFlow);
  document.getElementById("dividend-etf-flow-period-select")?.addEventListener("change", renderDividendEtfFlow);
  renderForeignFlow();
  renderDividendEtfFlow();
  setupWatchlistManager();
  renderIndexCharts();
  renderMarketFlowChart();
  renderFuturesFlowChart();
  await switchTab("stocks");
  renderSmartPicks();
  renderHighDividendInstitutional();

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
  document.getElementById("manager-etf-select").addEventListener("change", renderManagerChanges);
  document.getElementById("manager-action-select").addEventListener("change", renderManagerChanges);
  document.getElementById("manager-top-period-select")?.addEventListener("change", renderManagerTopMoversByPeriod);
  renderManagerTopMoversByPeriod();
  document.getElementById("modal-close").addEventListener("click", closeDetail);
  document.getElementById("detail-modal").addEventListener("click", (e) => {
    if (e.target.id === "detail-modal") closeDetail();
  });

  const reopenDetail = sessionStorage.getItem("detail-after-watchlist-update");
  if (reopenDetail) {
    sessionStorage.removeItem("detail-after-watchlist-update");
    try {
      const detail = JSON.parse(reopenDetail);
      if (detail?.code) await openDetail(detail.code, detail.kind || "stock", detail.name || detail.code);
    } catch (error) {
      console.warn("無法在資料更新後重新開啟個股視窗：", error);
    }
  }
}

init().catch((e) => {
  console.error(e);
  document.getElementById("card-grid").innerHTML =
    `<p style="color:#ef4444">載入失敗：${e.message}。請先在 scripts 資料夾執行 fetch_data.py 產生資料。</p>`;
});

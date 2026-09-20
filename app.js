// 股市追蹤網站 - 前端邏輯 (純靜態，讀本機 data/ 底下的 JSON)

if (window.ChartDataLabels) {
  Chart.register(ChartDataLabels);
  Chart.defaults.set("plugins.datalabels", { display: false });
}

let TICKERS = null;
let META = null;
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
      cards.push({
        code,
        name: (TICKERS.names && TICKERS.names[code]) || code,
        kind,
        close: s.latest_close,
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
let allCardsByTab = { stocks: [], etfs: [] };

function applyFilterSort() {
  let cards = [...allCardsByTab[CURRENT_TAB]];
  if (searchTerm) {
    cards = cards.filter((c) => c.code.includes(searchTerm) || c.name.includes(searchTerm));
  }
  if (sortMode === "yield-desc") {
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

async function switchTab(tab) {
  CURRENT_TAB = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (!allCardsByTab[tab].length) {
    const codes = tab === "stocks" ? TICKERS.stocks : TICKERS.etfs;
    allCardsByTab[tab] = await buildCards(codes, tab === "stocks" ? "stock" : "etf");
  }
  applyFilterSort();
}

let candleChart = null;
let epsChart = null;
let revChart = null;
let peChart = null;
let retailChart = null;
let institutionalChart = null;

async function openDetail(code, kind, name) {
  const modal = document.getElementById("detail-modal");
  modal.classList.remove("hidden");
  document.getElementById("modal-title").textContent = `${code}　${name}`;

  const s = await loadStock(code);

  // K線
  const candleEl = document.getElementById("candle-chart");
  candleEl.innerHTML = "";
  const legendEl = document.getElementById("ma-legend");
  legendEl.innerHTML = "";
  if (window.LightweightCharts && s.price && s.price.length) {
    candleChart = LightweightCharts.createChart(candleEl, {
      width: candleEl.clientWidth,
      height: 320,
      layout: { background: { color: "#171a21" }, textColor: "#e8eaed" },
      grid: { vertLines: { color: "#2a2f3a" }, horzLines: { color: "#2a2f3a" } },
      timeScale: { timeVisible: false },
    });
    const series = candleChart.addCandlestickSeries({
      upColor: "#ef4444", downColor: "#22c55e",
      borderUpColor: "#ef4444", borderDownColor: "#22c55e",
      wickUpColor: "#ef4444", wickDownColor: "#22c55e",
    });
    series.setData(s.price.map((p) => ({ time: p.t, open: p.o, high: p.h, low: p.l, close: p.c })));

    const MA_LINES = [
      { key: "ma10", label: "10日", color: "#f59e0b" },
      { key: "ma20", label: "月線", color: "#a78bfa" },
      { key: "ma60", label: "季線", color: "#38bdf8" },
      { key: "ma240", label: "年線", color: "#f472b6" },
    ];
    MA_LINES.forEach((ma) => {
      const data = s.price
        .filter((p) => p[ma.key] !== null && p[ma.key] !== undefined)
        .map((p) => ({ time: p.t, value: p[ma.key] }));
      if (!data.length) return;
      const lineSeries = candleChart.addLineSeries({
        color: ma.color, lineWidth: 1, title: ma.label,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      lineSeries.setData(data);
      const lastVal = data[data.length - 1].value;
      legendEl.innerHTML += `<span><i style="background:${ma.color}"></i>${ma.label} <b>${lastVal.toFixed(2)}</b></span>`;
    });

    candleChart.timeScale().fitContent();
  }

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
      tr.innerHTML = `<td>${d.ex_date}</td><td>${fmtNum(d.prev_close)}</td><td>${fmtNum(d.cash_per_share)}</td><td>${fmtNum(d.ex_dividend_price)}</td><td>${d.pay_date || "—"}</td>`;
      tbody.appendChild(tr);
    });
  } else {
    document.getElementById("div-table").classList.add("hidden");
    divEmpty.classList.remove("hidden");
  }
}

function closeDetail() {
  document.getElementById("detail-modal").classList.add("hidden");
  if (candleChart) { candleChart.remove(); candleChart = null; }
}

async function init() {
  TICKERS = await loadJSON("data/tickers.json");
  try { META = await loadJSON("data/meta.json"); } catch (e) { META = null; }
  MACRO = await loadJSON("data/macro.json");

  document.getElementById("stock-count").textContent = TICKERS.stocks.length;
  document.getElementById("etf-count").textContent = TICKERS.etfs.length;
  if (!META) {
    document.getElementById("updated-at").textContent = "尚未執行「更新資料.bat」，目前沒有資料";
  } else if (META.status === "partial_quota_exceeded") {
    document.getElementById("updated-at").textContent =
      `資料更新時間：${META.updated_at}（免費資料額度用完，只抓到 ${META.stock_count}/${META.stock_total} 個股、${META.etf_count}/${META.etf_total} ETF，約1小時後重跑「更新資料.bat」補齊）`;
  } else {
    document.getElementById("updated-at").textContent = `資料更新時間：${META.updated_at}`;
  }

  renderMacroPanel();
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

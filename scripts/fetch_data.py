# -*- coding: utf-8 -*-
"""
抓取股票網站需要的所有資料，寫到 ../data/ 下的 JSON 檔案，給 index.html 讀取。

資料來源：
  - FinMind API (https://finmindtrade.com)：個股/ETF 的歷史股價(K線)、股利發放紀錄、
    月營收 (個股)、季EPS (個股)。免費、免金鑰，同時涵蓋上市/上櫃。
  - Yahoo Finance chart API：黃金/原油/美國10年期公債殖利率/台股加權指數 的總經趨勢資料。

執行方式：
  python fetch_data.py            # 抓全部 (第一次跑，約需十幾分鐘，會顯示進度)
  python fetch_data.py --only 2330,0050   # 只抓特定代碼 (除錯用)

會把每檔股票抓到的原始資料快取到 data/cache/，重跑時如果快取還新鮮 (預設 20 小時內)
就不會重打 API，可以放心中斷重跑。

FinMind 免費/匿名額度是 300 次/小時，這個網站一次要跑約 500 次 API，很容易卡住。
在 scripts/finmind_token.txt 貼上你的 FinMind API Token（免費註冊會員就有 600 次/小時），
就會自動帶上，額度會提高。怎麼申請看 README.md。
"""
import bisect
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
CACHE_DIR = os.path.join(DATA_DIR, "cache")
STOCKS_DIR = os.path.join(DATA_DIR, "stocks")
TOKEN_FILE = os.path.join(HERE, "finmind_token.txt")


def load_finmind_token():
    """如果 scripts/finmind_token.txt 裡有貼 FinMind 的 API Token 就用，
    註冊免費帳號可以把額度從匿名的量拉高很多。沒有這個檔案也完全能跑，只是額度比較少。"""
    if os.path.exists(TOKEN_FILE):
        for line in open(TOKEN_FILE, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#"):
                return line
    return None


FINMIND_TOKEN = load_finmind_token()
FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
CACHE_FRESH_HOURS = 20
REQUEST_DELAY = 0.4  # 秒，避免打太快被 FinMind 擋
MAX_RETRIES = 4

MA_WINDOWS = {"ma10": 10, "ma20": 20, "ma60": 60, "ma240": 240}  # 10日/月線/季線/年線
# 年線(240個交易日)需要額外的歷史資料才能從圖表一開始就有值，所以往前抓夠長：
# 240個交易日 + 想顯示的1年 K線，抓寬鬆一點約 2.2 年份的日曆天
PRICE_START = (datetime.today() - timedelta(days=800)).strftime("%Y-%m-%d")
FIN_START = (datetime.today() - timedelta(days=365 * 3)).strftime("%Y-%m-%d")
DIV_START = (datetime.today() - timedelta(days=365 * 5)).strftime("%Y-%m-%d")


class QuotaExceeded(Exception):
    """FinMind 免費額度用完 (HTTP 402)，重試沒有用，要整批停下來。"""


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def http_get_json(url, params, cache_key=None, auth_token=None):
    """打 API，帶重試/退避；如果有 cache_key 且快取夠新就直接讀快取。"""
    if cache_key:
        cache_path = os.path.join(CACHE_DIR, cache_key + ".json")
        if os.path.exists(cache_path):
            age_h = (time.time() - os.path.getmtime(cache_path)) / 3600
            if age_h < CACHE_FRESH_HOURS:
                with open(cache_path, encoding="utf-8") as f:
                    return json.load(f)

    qs = urllib.parse.urlencode(params)
    full_url = f"{url}?{qs}"
    last_err = None
    headers = {"User-Agent": "Mozilla/5.0"}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(full_url, headers=headers)
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if cache_key:
                os.makedirs(CACHE_DIR, exist_ok=True)
                with open(os.path.join(CACHE_DIR, cache_key + ".json"), "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False)
            time.sleep(REQUEST_DELAY)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 402:
                # 免費額度用完，重試也沒用，直接整批停下來（已抓到的都留著）
                raise QuotaExceeded(cache_key or url)
            last_err = e
            wait = min(30, 2 ** attempt)
            log(f"  ! {cache_key or url} 失敗 ({e})，{wait}s 後重試 ({attempt}/{MAX_RETRIES})")
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            wait = min(30, 2 ** attempt)
            log(f"  ! {cache_key or url} 失敗 ({e})，{wait}s 後重試 ({attempt}/{MAX_RETRIES})")
            time.sleep(wait)
    log(f"  !! {cache_key or url} 放棄，最後錯誤: {last_err}")
    return None


def finmind(dataset, data_id, start_date, cache_key):
    params = {"dataset": dataset, "start_date": start_date}
    if data_id:
        params["data_id"] = data_id
    data = http_get_json(FINMIND_URL, params, cache_key=cache_key, auth_token=FINMIND_TOKEN)
    if not data or data.get("status") != 200:
        return []
    return data.get("data", [])


def fetch_price(code):
    rows = finmind("TaiwanStockPrice", code, PRICE_START, f"price_{code}")
    points = [
        {
            "t": r["date"],
            "o": r.get("open"),
            "h": r.get("max"),
            "l": r.get("min"),
            "c": r.get("close"),
            "v": r.get("Trading_Volume"),
        }
        for r in rows
        if r.get("close") is not None
    ]
    closes = [p["c"] for p in points]
    for key, window in MA_WINDOWS.items():
        for i, p in enumerate(points):
            if i + 1 < window:
                p[key] = None
            else:
                p[key] = round(sum(closes[i + 1 - window:i + 1]) / window, 4)
    return points


def fetch_dividend(code):
    rows = finmind("TaiwanStockDividend", code, DIV_START, f"div_{code}")
    out = []
    for r in rows:
        cash = r.get("CashEarningsDistribution") or 0
        stock_div = r.get("StockEarningsDistribution") or 0
        ex_date = r.get("CashExDividendTradingDate") or r.get("StockExDividendTradingDate")
        if not ex_date:
            continue
        if not cash and not stock_div:
            continue
        out.append({
            "ex_date": ex_date,
            "cash_per_share": cash,
            "stock_per_share": stock_div,
            "pay_date": r.get("CashDividendPaymentDate") or None,
            "year": r.get("year"),
        })
    out.sort(key=lambda x: x["ex_date"])
    return out


def compute_ex_dividend_price(dividends, price):
    """幫每筆配息紀錄算「除息參考價」：
    除息參考價 = (除息前一交易日收盤價 - 現金股利) / (1 + 股票股利/10)
    （多數台股只有配現金股利，股票股利=0時公式就簡化成「前收盤價 - 現金股利」）
    """
    if not dividends or not price:
        for d in dividends:
            d["prev_close"] = None
            d["ex_dividend_price"] = None
        return dividends

    dates_sorted = [p["t"] for p in price]  # price 已經照日期由舊到新排序
    close_by_date = {p["t"]: p["c"] for p in price}

    for d in dividends:
        idx = bisect.bisect_left(dates_sorted, d["ex_date"])
        prev_date = dates_sorted[idx - 1] if idx > 0 else None
        prev_close = close_by_date.get(prev_date) if prev_date else None
        if prev_close is None:
            d["prev_close"] = None
            d["ex_dividend_price"] = None
            continue
        cash = d["cash_per_share"] or 0
        stock_ratio = (d["stock_per_share"] or 0) / 10
        rights_value = cash + stock_ratio * prev_close
        denom = 1 + stock_ratio
        ref_price = (prev_close - rights_value) / denom if denom else None
        d["prev_close"] = round(prev_close, 2)
        d["ex_dividend_price"] = round(ref_price, 2) if ref_price is not None else None
    return dividends


def fetch_revenue(code):
    rows = finmind("TaiwanStockMonthRevenue", code, FIN_START, f"rev_{code}")
    by_month = {}
    for r in rows:
        y, m = r.get("revenue_year"), r.get("revenue_month")
        if y is None or m is None:
            continue
        by_month[(y, m)] = r.get("revenue")
    sorted_items = sorted(by_month.items())
    out = []
    for i, ((y, m), rev) in enumerate(sorted_items):
        prev_year = by_month.get((y - 1, m))
        yoy = ((rev - prev_year) / prev_year * 100) if (rev is not None and prev_year) else None
        prev_month = sorted_items[i - 1][1] if i > 0 else None
        mom = ((rev - prev_month) / prev_month * 100) if (rev is not None and prev_month) else None
        out.append({"year": y, "month": m, "revenue": rev, "yoy_pct": yoy, "mom_pct": mom})
    return out


def fetch_eps(code):
    rows = finmind("TaiwanStockFinancialStatements", code, FIN_START, f"eps_{code}")
    out = [
        {"date": r["date"], "eps": r["value"]}
        for r in rows
        if r.get("type") == "EPS"
    ]
    out.sort(key=lambda x: x["date"])
    return out


def compute_pe(eps_list, price):
    """幫每一季算「本益比」：本益比 = 當季季底(最近交易日)收盤價 / 近四季EPS總和(TTM EPS)。
    前三季因為湊不滿四季資料，本益比留 None。
    """
    if not eps_list or not price:
        return []
    dates_sorted = [p["t"] for p in price]  # price 已經照日期由舊到新排序
    close_by_date = {p["t"]: p["c"] for p in price}

    out = []
    for i, e in enumerate(eps_list):
        if i < 3:
            out.append({"date": e["date"], "pe": None})
            continue
        ttm_eps = sum(x["eps"] for x in eps_list[i - 3:i + 1])
        idx = bisect.bisect_right(dates_sorted, e["date"]) - 1
        close = close_by_date.get(dates_sorted[idx]) if idx >= 0 else None
        pe = round(close / ttm_eps, 2) if (close and ttm_eps) else None
        out.append({"date": e["date"], "pe": pe})
    return out


def fetch_retail_flow(code):
    """個股三大法人「外資/投信/自營商」個別買賣超，與反推「散戶買賣超」(單位:張)。
    邏輯：外資+投信+自營商+散戶 當日買進股數合計 = 賣出股數合計 = 當日成交量，
    所以 散戶買賣超 = -(三大法人合計買賣超)，不用額外抓成交量就能反推。
    """
    rows = finmind("TaiwanStockInstitutionalInvestorsBuySell", code, FIN_START, f"inst_{code}")
    by_date = {}
    for r in rows:
        d = r.get("date")
        name = r.get("name")
        if not d:
            continue
        net = (r.get("buy") or 0) - (r.get("sell") or 0)
        rec = by_date.setdefault(d, {"foreign": 0, "trust": 0, "dealer": 0})
        if name in ("Foreign_Investor", "Foreign_Dealer_Self"):
            rec["foreign"] += net
        elif name == "Investment_Trust":
            rec["trust"] += net
        elif name in ("Dealer_self", "Dealer_Hedging"):
            rec["dealer"] += net

    out = []
    for d, rec in sorted(by_date.items()):
        total_net = rec["foreign"] + rec["trust"] + rec["dealer"]
        out.append({
            "date": d,
            "foreign_lots": round(rec["foreign"] / 1000),
            "trust_lots": round(rec["trust"] / 1000),
            "dealer_lots": round(rec["dealer"] / 1000),
            "institutional_lots": round(total_net / 1000),
            "retail_lots": round(-total_net / 1000),
        })
    return out


def trailing_yield(dividends, latest_close):
    if not latest_close:
        return None
    cutoff = (datetime.today() - timedelta(days=365)).strftime("%Y-%m-%d")
    total_cash = sum(d["cash_per_share"] for d in dividends if d["ex_date"] >= cutoff)
    if total_cash <= 0:
        return None
    return round(total_cash / latest_close * 100, 2)


def build_one(code, kind):
    price = fetch_price(code)
    dividends = fetch_dividend(code)
    dividends = compute_ex_dividend_price(dividends, price)
    latest_close = price[-1]["c"] if price else None

    record = {
        "code": code,
        "kind": kind,
        "price": price,
        "dividends": dividends,
        "trailing_yield_pct": trailing_yield(dividends, latest_close),
        "latest_close": latest_close,
    }

    if kind == "stock":
        record["revenue"] = fetch_revenue(code)
        record["eps"] = fetch_eps(code)
        record["pe"] = compute_pe(record["eps"], price)
        record["retail_flow"] = fetch_retail_flow(code)

    os.makedirs(STOCKS_DIR, exist_ok=True)
    with open(os.path.join(STOCKS_DIR, f"{code}.json"), "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False)
    return record


def yahoo_chart(symbol, cache_key, rng="1y"):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
    data = http_get_json(url, {"range": rng, "interval": "1d"}, cache_key=cache_key)
    try:
        result = data["chart"]["result"][0]
        ts = result["timestamp"]
        closes = result["indicators"]["quote"][0]["close"]
        out = []
        for t, c in zip(ts, closes):
            if c is None:
                continue
            out.append({"t": datetime.utcfromtimestamp(t).strftime("%Y-%m-%d"), "c": round(c, 4)})
        return out
    except Exception as e:
        log(f"  !! yahoo {symbol} 解析失敗: {e}")
        return []


def fetch_market_flow():
    """全市場三大法人「外資/投信/自營商」個別買賣超、三大法人合計、與反推「散戶買賣超」，單位:億元。"""
    rows = finmind("TaiwanStockTotalInstitutionalInvestors", None, FIN_START, "market_institutional")
    by_date = {}
    for r in rows:
        d = r.get("date")
        name = r.get("name")
        if not d or not name:
            continue
        net = (r.get("buy") or 0) - (r.get("sell") or 0)
        by_date.setdefault(d, {})[name] = net

    dates = sorted(by_date)
    foreign_out, trust_out, dealer_out, institutional_out, retail_out = [], [], [], [], []
    for d in dates:
        rec = by_date[d]
        foreign = (rec.get("Foreign_Investor") or 0) + (rec.get("Foreign_Dealer_Self") or 0)
        trust = rec.get("Investment_Trust") or 0
        dealer = (rec.get("Dealer_self") or 0) + (rec.get("Dealer_Hedging") or 0)
        total = rec.get("total")
        foreign_out.append({"t": d, "c": round(foreign / 1e8, 2)})
        trust_out.append({"t": d, "c": round(trust / 1e8, 2)})
        dealer_out.append({"t": d, "c": round(dealer / 1e8, 2)})
        institutional_out.append({"t": d, "c": round(total / 1e8, 2) if total is not None else None})
        retail_out.append({"t": d, "c": round(-total / 1e8, 2) if total is not None else None})
    return foreign_out, trust_out, dealer_out, institutional_out, retail_out


def fetch_futures_flow():
    """全市場台指期(TX)「外資」、「投信」每日淨未平倉部位(口) = 多單-空單。
    負值代表淨空單(偏空)，正值代表淨多單(偏多)。"""
    rows = finmind("TaiwanFuturesInstitutionalInvestors", "TX", FIN_START, "futures_inst_TX")
    foreign_by_date = {}
    trust_by_date = {}
    for r in rows:
        d = r.get("date")
        name = r.get("institutional_investors")
        if not d or name not in ("外資", "投信"):
            continue
        net = (r.get("long_open_interest_balance_volume") or 0) - (r.get("short_open_interest_balance_volume") or 0)
        if name == "外資":
            foreign_by_date[d] = net
        else:
            trust_by_date[d] = net
    dates = sorted(set(foreign_by_date) | set(trust_by_date))
    foreign_out = [{"t": d, "c": foreign_by_date.get(d)} for d in dates]
    trust_out = [{"t": d, "c": trust_by_date.get(d)} for d in dates]
    return foreign_out, trust_out


def build_macro():
    foreign_net, trust_net, dealer_net, institutional_net, retail_net = fetch_market_flow()
    foreign_futures_net, trust_futures_net = fetch_futures_flow()
    macro = {
        "gold": yahoo_chart("GC=F", "macro_gold"),
        "oil_wti": yahoo_chart("CL=F", "macro_oil"),
        "us10y_yield": yahoo_chart("^TNX", "macro_us10y"),
        "taiex": yahoo_chart("^TWII", "macro_taiex"),
        "usdtwd": yahoo_chart("TWD=X", "macro_usdtwd"),
        "foreign_net": foreign_net,
        "trust_net": trust_net,
        "dealer_net": dealer_net,
        "institutional_net": institutional_net,
        "retail_net": retail_net,
        "foreign_futures_net": foreign_futures_net,
        "trust_futures_net": trust_futures_net,
    }
    with open(os.path.join(DATA_DIR, "macro.json"), "w", encoding="utf-8") as f:
        json.dump(macro, f, ensure_ascii=False)
    return macro


def fetch_names():
    data = http_get_json(
        FINMIND_URL, {"dataset": "TaiwanStockInfo"}, cache_key="stock_info", auth_token=FINMIND_TOKEN
    )
    names = {}
    if data and data.get("status") == 200:
        for r in data.get("data", []):
            names.setdefault(r["stock_id"], r["stock_name"])
    return names


def main():
    only = None
    if "--only" in sys.argv:
        idx = sys.argv.index("--only")
        only = set(sys.argv[idx + 1].split(","))

    with open(os.path.join(DATA_DIR, "tickers.json"), encoding="utf-8") as f:
        tickers = json.load(f)

    stocks = tickers["stocks"]
    etfs = tickers["etfs"]
    if only:
        stocks = [c for c in stocks if c in only]
        etfs = [c for c in etfs if c in only]

    total = len(stocks) + len(etfs) + 1
    done = 0
    status = "complete"

    log(f"開始抓取：{len(stocks)} 檔個股 + {len(etfs)} 檔ETF + 總經面板")
    if FINMIND_TOKEN:
        log("已讀到 FinMind API Token，會用比較高的額度。")
    else:
        log("沒有設定 FinMind API Token，用免費/匿名額度（比較容易卡住）。"
            "可以到 scripts\\finmind_token.txt 貼上你的 Token 來提高額度。")

    log("抓股票/ETF中文名稱對照表...")
    try:
        names = fetch_names()
        tickers["names"] = {c: names.get(c, c) for c in (tickers["stocks"] + tickers["etfs"])}
        with open(os.path.join(DATA_DIR, "tickers.json"), "w", encoding="utf-8") as f:
            json.dump(tickers, f, ensure_ascii=False, indent=2)
    except QuotaExceeded:
        log("  額度用完，先跳過中文名稱（卡片會先顯示代號），之後補跑就會補上。")

    log("抓總經面板 (黃金/原油/美債10年/台股大盤/匯率)...")
    build_macro()
    done += 1
    log(f"  [{done}/{total}] 完成")

    results = {"stocks": [], "etfs": []}
    try:
        for code in stocks:
            r = build_one(code, "stock")
            done += 1
            log(f"  [{done}/{total}] 個股 {code} 完成 "
                f"(收盤={r['latest_close']}, 殖利率={r['trailing_yield_pct']})")
            results["stocks"].append(code)

        for code in etfs:
            r = build_one(code, "etf")
            done += 1
            log(f"  [{done}/{total}] ETF {code} 完成 "
                f"(收盤={r['latest_close']}, 殖利率={r['trailing_yield_pct']})")
            results["etfs"].append(code)
    except QuotaExceeded as e:
        status = "partial_quota_exceeded"
        log("")
        log("=" * 60)
        log(f"FinMind 免費額度用完了 (卡在 {e})。")
        log(f"目前已經抓好 {len(results['stocks'])} 檔個股、{len(results['etfs'])} 檔ETF，")
        log("這些資料都留著、網站看得到，沒抓完的之後補就好。")
        log("請等大約 1 小時，讓額度恢復，再重新雙擊「更新資料.bat」，")
        log("之前抓過的會直接用快取跳過，只會繼續抓還沒抓到的部分。")
        log("=" * 60)

    # 用實際存在的檔案算數量，這樣就算這次中途失敗，也能反映之前已經抓好、留在硬碟上的資料
    have_stocks = [c for c in tickers["stocks"] if os.path.exists(os.path.join(STOCKS_DIR, f"{c}.json"))]
    have_etfs = [c for c in tickers["etfs"] if os.path.exists(os.path.join(STOCKS_DIR, f"{c}.json"))]

    meta = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "status": status,
        "stock_count": len(have_stocks),
        "stock_total": len(tickers["stocks"]),
        "etf_count": len(have_etfs),
        "etf_total": len(tickers["etfs"]),
    }
    with open(os.path.join(DATA_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    if status == "complete":
        log(f"全部完成！共 {meta['stock_count']} 檔個股、{meta['etf_count']} 檔ETF。")
        log("打開 index.html 就可以看了。")


if __name__ == "__main__":
    main()

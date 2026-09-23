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
import hashlib
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
CACHE_FRESH_HOURS = 20  # 沒特別指定時的預設時效
MACRO_FRESH_HOURS = 1   # 總經那幾條(黃金/原油/美債/大盤/匯率)：美股是台灣半夜收盤，時效要短
SHORT_RETRY_HOURS = 3   # 追不到基準日時，隔多久才願意再試一次（避免每次跑都白打一輪）

# 股利、月營收、EPS、名稱對照這幾項不是每天變的，快取時效以「天」計就好。
# （原本跟股價一樣用 20 小時，只要隔一天跑就會多打約 350 次 API，容易撞到 600次/小時的上限。）
DIV_FRESH_DAYS = 7      # 配息：公告到除息中間隔很久，一週看一次就夠
NAMES_FRESH_DAYS = 7    # 股票/ETF 中文名稱：幾乎不變，新上市的隔幾天補到也不影響
REV_FRESH_DAYS = 7      # 月營收：平常一週一次
REV_HOT_DAYS = 1        # 月營收公布期(每月1~15號)：一天一次，才不會晚好幾天才看到新的月營收
EPS_FRESH_DAYS = 14     # 季EPS：平常兩週一次
EPS_HOT_DAYS = 2        # 財報公布期(3/5/8/11月)：兩天一次
REV_HOT_MONTH_DAYS = 15         # 每月10日前公布上個月營收，抓寬一點到15號
EPS_HOT_MONTHS = (3, 5, 8, 11)  # 年報3/31、Q1 5/15、Q2 8/14、Q3 11/14
# 這些慢速資料如果所有標的用同一個時效，會在「同一天」一起過期：
# 那天光是配息+月營收+EPS 就要多打近千次 API，一定撞到 600次/小時的上限。
# 所以依代號給每檔一個固定的偏移，把到期時間分散在 1.0~1.5 倍的區間裡。
TTL_JITTER_RATIO = 0.5
REQUEST_DELAY = 0.4  # 秒，避免打太快被 FinMind 擋
MAX_RETRIES = 4
STATE_FILE = os.path.join(CACHE_DIR, "_fetch_state.json")
ETF_HOLDINGS_FILE = os.path.join(DATA_DIR, "etf_holdings.json")
ETF_HOLDINGS_URL = "https://www.sinotrade.com.tw/richclub/api/graphql"
ETF_HOLDINGS_FRESH_DAYS = 5

# 每天各種資料公布的時間不一樣（以下是台北時間的大致情況）：
#   上市(twse)收盤價     14:00 前後就抓得到
#   上櫃(tpex)收盤價     比上市晚，下午較晚才進得來（櫃買個股、債券ETF 都屬這類）
#   三大法人買賣超       證交所約 15:30~16:00 公布，FinMind 再慢一點，下午4點後才抓得到
#   期貨三大法人未平倉   台期所盤後公布，大致同一個時段
# 但「幾點公布」會變，遇到颱風假/補班/連假也會整天沒有資料，寫死時間表很容易出錯。
# 所以這裡不猜時間：每次跑先抓一份「基準」問 FinMind 這份資料目前最新公布到哪一天，
# 再拿那個日期去檢查每一份快取夠不夠新。有新的就更新，沒新的就沿用快取。
REF_START = (datetime.today() - timedelta(days=30)).strftime("%Y-%m-%d")

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


_STATE = None


def load_state():
    """記錄「這個 cache_key 追某個基準日時撲空了」，免得每次跑都對同一批沒資料的標的重打 API。"""
    global _STATE
    if _STATE is None:
        try:
            with open(STATE_FILE, encoding="utf-8") as f:
                _STATE = json.load(f)
        except Exception:
            _STATE = {}
    return _STATE


def save_state():
    if _STATE is None:
        return
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(_STATE, f, ensure_ascii=False)
    except Exception:
        pass


def jittered_hours(code, base_hours):
    """同樣的代號永遠得到同一個偏移量（不會每次跑都變），所以快取不會被無謂地提早作廢。"""
    if not code:
        return base_hours
    h = int(hashlib.md5(code.encode("utf-8")).hexdigest()[:8], 16)
    return base_hours * (1 + TTL_JITTER_RATIO * (h % 1000) / 1000.0)


def revenue_ttl_hours():
    """月營收：每月10日前會公布上個月的，所以月初那半個月抓勤一點，其餘時間一週一次。"""
    days = REV_HOT_DAYS if datetime.today().day <= REV_HOT_MONTH_DAYS else REV_FRESH_DAYS
    return days * 24


def eps_ttl_hours():
    """季EPS：只有財報公布的那幾個月會變，其餘時間不用一直重抓。"""
    days = EPS_HOT_DAYS if datetime.today().month in EPS_HOT_MONTHS else EPS_FRESH_DAYS
    return days * 24


def payload_max_date(data):
    """一份 FinMind 回應裡最新的一筆是哪一天。"""
    rows = (data or {}).get("data") or []
    dates = [r.get("date") for r in rows if r.get("date")]
    return max(dates) if dates else None


def cache_reaches(cache_key, cached, min_date):
    """快取是否已經涵蓋基準日。
    有些標的本來就不會有那一天的資料（停牌、冷門到當天沒成交、該市場還沒公布），
    這種撲空過的先記著，SHORT_RETRY_HOURS 內視同已是最新，不再重打。"""
    have = payload_max_date(cached)
    if have and have >= min_date:
        return True
    rec = load_state().get(cache_key)
    return bool(
        rec
        and rec.get("target") == min_date
        and (time.time() - rec.get("at", 0)) / 3600 < SHORT_RETRY_HOURS
    )


def note_fetch_result(cache_key, data, min_date):
    """重抓過還是沒追到基準日 → 記下來，短時間內不再重試。追到了就把記錄清掉。"""
    state = load_state()
    if cache_reaches_after_fetch(data, min_date):
        state.pop(cache_key, None)
    else:
        state[cache_key] = {"target": min_date, "at": time.time()}


def cache_reaches_after_fetch(data, min_date):
    have = payload_max_date(data)
    return bool(have and have >= min_date)


def read_cache(cache_key):
    try:
        with open(os.path.join(CACHE_DIR, cache_key + ".json"), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def http_get_json(url, params, cache_key=None, auth_token=None, min_date=None, force=False,
                  max_age_hours=None):
    """打 API，帶重試/退避。
    有 cache_key 時先看快取：
      - 有給 min_date（每天更新的資料）：快取要已經涵蓋那個交易日才算新鮮，否則重抓。
      - 沒給 min_date（股利/月營收/EPS 這種慢速資料）：照時效判斷，
        預設 CACHE_FRESH_HOURS，可用 max_age_hours 改短（總經資料用得到）。
    force=True 則一律重抓（用來抓基準日）。
    真的抓不到時會退回舊快取，不會讓畫面整條資料變空白。"""
    ttl = CACHE_FRESH_HOURS if max_age_hours is None else max_age_hours
    if cache_key and not force:
        cache_path = os.path.join(CACHE_DIR, cache_key + ".json")
        if os.path.exists(cache_path):
            age_h = (time.time() - os.path.getmtime(cache_path)) / 3600
            if age_h < ttl:
                cached = read_cache(cache_key)
                if cached is not None and (min_date is None or cache_reaches(cache_key, cached, min_date)):
                    return cached

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
                if min_date:
                    note_fetch_result(cache_key, data, min_date)
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
    if cache_key:
        stale = read_cache(cache_key)
        if stale is not None:
            log(f"  -> {cache_key} 先沿用上次抓到的舊資料（不讓這一項變空白）")
            return stale
    return None


def post_json(url, payload):
    """以 JSON POST 呼叫公開資料端點。"""
    body = json.dumps(payload).encode("utf-8")
    headers = {"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                time.sleep(min(30, 2 ** attempt))
    log(f"  !! ETF 成分股 API 失敗：{last_err}")
    return None


def load_etf_holdings_db():
    try:
        with open(ETF_HOLDINGS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("items"), dict):
            return data
    except (OSError, ValueError, TypeError):
        pass
    return {"source": ETF_HOLDINGS_URL, "items": {}}


def save_etf_holdings_db(data):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(ETF_HOLDINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def fetch_etf_holdings(codes):
    """更新 ETF 前十大持股；每檔資料距上次抓取未滿 5 天則沿用舊資料。"""
    db = load_etf_holdings_db()
    db.setdefault("source", ETF_HOLDINGS_URL)
    db.setdefault("items", {})
    now = datetime.now()
    refreshed = 0
    skipped = 0
    failed = 0
    query = """query($code: String!) {
      getETFHoldings(code: $code) {
        code
        date
        list { id nm r }
      }
    }"""
    for code in codes:
        old = db["items"].get(code)
        fetched_at = None
        if old:
            try:
                fetched_at = datetime.fromisoformat(old.get("fetched_at", ""))
            except (TypeError, ValueError):
                fetched_at = None
        if fetched_at and now - fetched_at < timedelta(days=ETF_HOLDINGS_FRESH_DAYS):
            skipped += 1
            continue

        result = post_json(ETF_HOLDINGS_URL, {"query": query, "variables": {"code": code}})
        payload = (result or {}).get("data", {}).get("getETFHoldings")
        rows = (payload or {}).get("list") or []
        holdings = []
        for row in rows:
            try:
                weight = float(row.get("r"))
            except (TypeError, ValueError):
                continue
            if weight <= 0 or not row.get("id"):
                continue
            holdings.append({
                "code": str(row["id"]),
                "name": row.get("nm") or str(row["id"]),
                "weight": weight,
            })
        holdings.sort(key=lambda item: item["weight"], reverse=True)
        if not payload or not holdings:
            failed += 1
            log(f"  !! ETF {code} 沒有取得有效成分股，保留舊資料")
            continue
        db["items"][code] = {
            "code": code,
            "source_date": payload.get("date"),
            "fetched_at": now.isoformat(timespec="seconds"),
            "holdings": [
                {"rank": rank, **item} for rank, item in enumerate(holdings[:10], start=1)
            ],
        }
        refreshed += 1
        time.sleep(REQUEST_DELAY)

    db["updated_at"] = now.strftime("%Y-%m-%d %H:%M:%S")
    save_etf_holdings_db(db)
    log(f"ETF 成分股：更新 {refreshed} 檔、沿用 {skipped} 檔、失敗 {failed} 檔")
    return db

def finmind(dataset, data_id, start_date, cache_key, min_date=None, force=False,
            max_age_hours=None):
    params = {"dataset": dataset, "start_date": start_date}
    if data_id:
        params["data_id"] = data_id
    data = http_get_json(
        FINMIND_URL, params, cache_key=cache_key, auth_token=FINMIND_TOKEN,
        min_date=min_date, force=force, max_age_hours=max_age_hours,
    )
    if not data or data.get("status") != 200:
        return []
    return data.get("data", [])


# 這一輪的基準日，main() 開頭用 probe_targets() 算出來：
# 上市收盤價 / 上櫃收盤價 / 三大法人，各自最新已經公布到哪一個交易日。
TARGETS = {"twse": None, "tpex": None, "inst": None}
MARKET_OF = {}  # 代號 -> "twse" / "tpex"


def price_target(code):
    """這一檔的收盤價應該要有哪一天。上櫃比上市晚公布，所以兩個市場分開看。"""
    market = MARKET_OF.get(code)
    if market in TARGETS:
        return TARGETS[market]
    # 不知道是上市還上櫃時取比較早的那個，寧可少抓一次也不要每次都白抓
    known = [d for d in (TARGETS["twse"], TARGETS["tpex"]) if d]
    return min(known) if known else None


def probe_targets(tickers):
    """問 FinMind：上市收盤價、上櫃收盤價、三大法人，現在各自最新公布到哪一個交易日。
    用「實際已經公布到哪天」當基準，就不必猜公布時間，也不用維護台股行事曆
    （颱風假、補班、連假這些寫死時間表一定會出錯的狀況都自動涵蓋）。
    每個市場拿 2 檔當樣本取最大值，避免剛好挑到當天停牌的標的。"""
    def latest(data_id, cache_key):
        rows = finmind("TaiwanStockPrice", data_id, REF_START, cache_key, force=True)
        dates = [r.get("date") for r in rows if r.get("date")]
        return max(dates) if dates else None

    for market in ("twse", "tpex"):
        refs = [c for c in tickers["stocks"] if MARKET_OF.get(c) == market][:2]
        found = [d for d in (latest(c, f"ref_price_{market}_{i}") for i, c in enumerate(refs)) if d]
        TARGETS[market] = max(found) if found else None

    # 三大法人這份是全市場合計，順便就是 build_macro() 要用的那份快取，不會多打一次 API
    rows = finmind("TaiwanStockTotalInstitutionalInvestors", None, FIN_START,
                   "market_institutional", force=True)
    dates = [r.get("date") for r in rows if r.get("date")]
    TARGETS["inst"] = max(dates) if dates else None


def fetch_price(code):
    rows = finmind("TaiwanStockPrice", code, PRICE_START, f"price_{code}",
                   min_date=price_target(code))
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
        # FinMind 偶爾會回傳整根都是 0 的K棒（停牌/當天沒有交易），
        # 收盤價 0 不是真的價格：留著會把K線的縱軸壓扁，也會污染均線，所以直接濾掉。
        if r.get("close")
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
    rows = finmind("TaiwanStockDividend", code, DIV_START, f"div_{code}",
                   max_age_hours=jittered_hours(code, DIV_FRESH_DAYS * 24))
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
    """幫每筆配息紀錄算「除權息參考價」：
    除權息參考價 = (除權息前一交易日收盤價 - 現金股利) / (1 + 股票股利/10)
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
        # 股票股利是「每股配發幾元」，面額10元 -> 每股多拿 stock_per_share/10 股
        stock_ratio = (d["stock_per_share"] or 0) / 10
        # 配股的價值不用另外扣：多出來的股數已經在分母 (1 + 配股率) 裡攤掉了。
        # （原本多扣一次 stock_ratio * prev_close，配股多的時候會算出負數的參考價。）
        denom = 1 + stock_ratio
        ref_price = (prev_close - cash) / denom if denom else None
        d["prev_close"] = round(prev_close, 2)
        d["ex_dividend_price"] = round(ref_price, 2) if ref_price is not None else None
    return dividends


def fetch_splits():
    """全市場的股票分割/面額變更（TaiwanStockSplitPrice）。
    不帶 data_id 就是一次抓全市場，只要 1 次 API，不用每檔各問一次。
    回傳 {股票代號: [{date, before, after}, ...]}。
    注意：這份資料只有在「有分割的那一天」才有列，所以用一般時效判斷就好，
    不能套基準日(min_date)——那樣永遠追不到，每次跑都會白重抓一輪。"""
    rows = finmind("TaiwanStockSplitPrice", None, FIN_START, "splits",
                   max_age_hours=24)
    by_code = {}
    for r in rows:
        code, date = r.get("stock_id"), r.get("date")
        before, after = r.get("before_price"), r.get("after_price")
        if not code or not date or not before or not after:
            continue
        by_code.setdefault(code, []).append({"date": date, "before": before, "after": after})
    for v in by_code.values():
        v.sort(key=lambda x: x["date"])
    return by_code


def build_adjustments(price, dividends, splits):
    """算出「還原K線」要用的調整事件。

    每個除權息/分割事件都有一個比例 factor = 事件後的參考價 / 事件前的收盤價。
    畫還原K線時，把事件「之前」的歷史價通通乘上之後所有事件 factor 的連乘積，
    就會把除權息、分割造成的價格斷層抹平（前復權：最新一天維持真實市價不動）。
    """
    if not price:
        return []
    first_day = price[0]["t"]
    events = []

    for d in dividends:
        prev_close, ref = d.get("prev_close"), d.get("ex_dividend_price")
        # 配息日比K線起點還早的沒意義（它只會影響更早的價格，而我們沒抓那麼早）
        if not prev_close or not ref or d["ex_date"] <= first_day:
            continue
        f = ref / prev_close
        if 0 < f <= 1.0000001:
            events.append({"date": d["ex_date"], "factor": round(f, 8), "kind": "除權息"})

    for sp in splits or []:
        if sp["date"] <= first_day:
            continue
        f = sp["after"] / sp["before"]
        if 0 < f <= 1.0000001:
            events.append({"date": sp["date"], "factor": round(f, 8), "kind": "分割"})

    events.sort(key=lambda e: e["date"])

    # 同一件事被算兩次（分割和除權息記到相近的日期）會讓還原過頭，這裡先擋掉並提醒
    deduped = []
    for e in events:
        clash = next((x for x in deduped
                      if x["kind"] != e["kind"] and abs_days(x["date"], e["date"]) <= 3), None)
        if clash:
            log(f"  ! {e['date']} 的「{e['kind']}」和 {clash['date']} 的「{clash['kind']}」"
                "時間太近，可能是同一件事，只採用前者以免還原過頭")
            continue
        deduped.append(e)
    return deduped


def abs_days(d1, d2):
    a = datetime.strptime(d1, "%Y-%m-%d")
    b = datetime.strptime(d2, "%Y-%m-%d")
    return abs((a - b).days)


def adjusted_closes(price, events):
    """把還原後的收盤價算出來（驗證用；網頁端也是照同一套邏輯算）。"""
    cum = 1.0
    ei = len(events) - 1
    out = [None] * len(price)
    for i in range(len(price) - 1, -1, -1):
        while ei >= 0 and events[ei]["date"] > price[i]["t"]:
            cum *= events[ei]["factor"]
            ei -= 1
        out[i] = price[i]["c"] * cum
    return out


# 只檢查「幅度夠大」的事件（分割、大額配股）。
# 台股單日漲跌幅上限是10%，事件當天本來就可能真的大漲大跌；
# 配息 3~5% 這種小事件，還原得對不對會被當天真實漲跌蓋過去，驗了只會一堆假警報。
# 幅度大於15%的事件就不會搞混：漏套用會留下 -15% 以上的斷層，
# 重複套用會變成 +18% 以上的上跳，兩者都超出真實漲跌能達到的範圍。
ADJ_CHECK_MIN_EFFECT = 0.15
ADJ_CHECK_TOLERANCE = 0.12


def check_adjustments(code, price, events):
    """還原對不對，看事件當天最準：還原後那天應該變成「平常的一天」。
    若同一件事被重複調整，殘留的跳空會變成約 1/factor 的「上跳」；
    若漏掉沒調整，就會留著約 factor 的「下跳」。兩種都在這裡抓出來。
    （事件當天股價本來就可能大漲大跌，所以只檢查比例夠大、看得出差別的事件。）"""
    if not events:
        return
    adj = adjusted_closes(price, events)
    idx = {p["t"]: i for i, p in enumerate(price)}
    for e in events:
        i = idx.get(e["date"])
        f = e["factor"]
        if not i or abs(1 - f) < ADJ_CHECK_MIN_EFFECT:
            continue
        before, after = adj[i - 1], adj[i]
        if not before:
            continue
        ratio = after / before
        if abs(ratio - 1) <= ADJ_CHECK_TOLERANCE:
            continue  # 還原後就是平常的一天，正確
        hint = "像是同一件事被調整了兩次" if ratio > 1 else "像是這個事件沒有被套用"
        log(f"  ! {code} {e['date']}（{e['kind']}，比例 {f:.4f}）還原後仍有 "
            f"{(ratio - 1) * 100:+.0f}% 的跳空，{hint}")


def fetch_revenue(code):
    rows = finmind("TaiwanStockMonthRevenue", code, FIN_START, f"rev_{code}",
                   max_age_hours=jittered_hours(code, revenue_ttl_hours()))
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
    rows = finmind("TaiwanStockFinancialStatements", code, FIN_START, f"eps_{code}",
                   max_age_hours=jittered_hours(code, eps_ttl_hours()))
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
    rows = finmind("TaiwanStockInstitutionalInvestorsBuySell", code, FIN_START, f"inst_{code}",
                   min_date=TARGETS["inst"])
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


def build_one(code, kind, splits=None):
    price = fetch_price(code)
    dividends = fetch_dividend(code)
    dividends = compute_ex_dividend_price(dividends, price)
    latest_close = price[-1]["c"] if price else None

    # 還原K線用的調整事件（除權息 + 分割）。只存事件本身，網頁端再換算，
    # 這樣每檔只多幾百個位元組，不用把整條還原後的K線也存進 JSON。
    adjustments = build_adjustments(price, dividends, (splits or {}).get(code))
    check_adjustments(code, price, adjustments)

    record = {
        "code": code,
        "kind": kind,
        "price": price,
        "dividends": dividends,
        "adjustments": adjustments,
        "trailing_yield_pct": trailing_yield(dividends, latest_close),
        "latest_close": latest_close,
    }

    if kind == "stock":
        record["revenue"] = fetch_revenue(code)
        record["eps"] = fetch_eps(code)
        record["pe"] = compute_pe(record["eps"], price)

    # 個股與 ETF 都有三大法人買賣超資料。
    record["retail_flow"] = fetch_retail_flow(code)

    os.makedirs(STOCKS_DIR, exist_ok=True)
    with open(os.path.join(STOCKS_DIR, f"{code}.json"), "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False)
    return record


def yahoo_chart(symbol, cache_key, rng="1y"):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
    # 美股是台灣時間半夜收盤，用 20 小時的時效會讓早上跑的那次抓不到昨晚的收盤，
    # 所以總經這幾條改成短時效，每次跑幾乎都會重抓（Yahoo 不像 FinMind 有額度限制）。
    data = http_get_json(url, {"range": rng, "interval": "1d"}, cache_key=cache_key,
                         max_age_hours=MACRO_FRESH_HOURS)
    try:
        result = data["chart"]["result"][0]
        ts = result["timestamp"]
        quote = result["indicators"]["quote"][0]
        closes = quote["close"]
        out = []
        for i, (t, c) in enumerate(zip(ts, closes)):
            if c is None:
                continue
            row = {"t": datetime.utcfromtimestamp(t).strftime("%Y-%m-%d"), "c": round(c, 4)}
            for key in ("open", "high", "low"):
                if quote[key][i] is not None:
                    row[key[0]] = round(quote[key][i], 4)
            if quote["volume"][i] is not None:
                row["v"] = quote["volume"][i]
            out.append(row)
        return out
    except Exception as e:
        log(f"  !! yahoo {symbol} 解析失敗: {e}")
        return []


def fetch_market_flow():
    """全市場三大法人「外資/投信/自營商」個別買賣超、三大法人合計、與反推「散戶買賣超」，單位:億元。"""
    rows = finmind("TaiwanStockTotalInstitutionalInvestors", None, FIN_START, "market_institutional",
                   min_date=TARGETS["inst"])
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
    rows = finmind("TaiwanFuturesInstitutionalInvestors", "TX", FIN_START, "futures_inst_TX",
                   min_date=TARGETS["inst"])
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


def fetch_tpex_index():
    """抓取最近 15 個月的 TPEx 櫃買指數 OHLC，並合併近期市場成交量。"""
    today = datetime.today()
    price_rows = []
    for offset in range(15):
        year = today.year
        month = today.month - offset
        while month <= 0:
            year -= 1
            month += 12
        roc_month = f"{year - 1911:03d}/{month:02d}"
        data = http_get_json(
            "https://www.tpex.org.tw/www/zh-tw/indexInfo/inx",
            {"date": roc_month},
            cache_key=f"macro_otc_{year:04d}{month:02d}",
            max_age_hours=24,
        ) or {}
        tables = data.get("tables") or []
        if tables:
            price_rows.extend(tables[0].get("data") or [])

    volume_data = http_get_json(
        "https://www.tpex.org.tw/openapi/v1/tpex_daily_trading_index",
        {}, cache_key="macro_otc_volume", force=True,
    ) or []
    volumes = {}
    for row in volume_data:
        raw_date = str(row.get("Date") or "")
        if len(raw_date) == 7 and raw_date.isdigit():
            date = f"{int(raw_date[:3]) + 1911:04d}-{raw_date[3:5]}-{raw_date[5:]}"
            volumes[date] = float(row.get("TradeVolume") or 0)

    out = []
    seen = set()
    for row in price_rows:
        if len(row) < 5:
            continue
        raw_date = str(row[0]).replace("/", "")
        if len(raw_date) != 8 or not raw_date.isdigit():
            continue
        date = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
        if date in seen:
            continue
        try:
            out.append({
                "t": date,
                "o": float(row[1]),
                "h": float(row[2]),
                "l": float(row[3]),
                "c": float(row[4]),
                "v": volumes.get(date, 0),
            })
            seen.add(date)
        except (TypeError, ValueError):
            continue
    return sorted(out, key=lambda row: row["t"])


def build_macro():
    foreign_net, trust_net, dealer_net, institutional_net, retail_net = fetch_market_flow()
    foreign_futures_net, trust_futures_net = fetch_futures_flow()
    macro = {
        "gold": yahoo_chart("GC=F", "macro_gold"),
        "oil_wti": yahoo_chart("CL=F", "macro_oil"),
        "us10y_yield": yahoo_chart("^TNX", "macro_us10y"),
        "taiex": yahoo_chart("^TWII", "macro_taiex"),

        "otc": fetch_tpex_index(),
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
    """回傳 (中文名稱對照, 市場別對照)。市場別是 twse(上市) / tpex(上櫃)，
    上櫃收盤價每天比上市晚公布，要分開判斷快取新不新。"""
    data = http_get_json(
        FINMIND_URL, {"dataset": "TaiwanStockInfo"}, cache_key="stock_info",
        auth_token=FINMIND_TOKEN, max_age_hours=NAMES_FRESH_DAYS * 24,
    )
    names, markets = {}, {}
    if data and data.get("status") == 200:
        for r in data.get("data", []):
            names.setdefault(r["stock_id"], r["stock_name"])
            markets.setdefault(r["stock_id"], r.get("type"))
    return names, markets


def latest_date_in_files(tickers, field, date_key, codes=None):
    """掃過寫好的個股/ETF JSON，看某一項資料實際最新到哪一天。
    codes 有給就只看那一批（拿來分開算上市/上櫃，不然上櫃還停在前一天會被上市的日期蓋過去）。"""
    latest = None
    for code in (codes if codes is not None else tickers["stocks"] + tickers["etfs"]):
        path = os.path.join(STOCKS_DIR, f"{code}.json")
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                rec = json.load(f)
        except Exception:
            continue
        rows = rec.get(field) or []
        if rows:
            d = rows[-1].get(date_key)
            if d and (latest is None or d > latest):
                latest = d
    return latest


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

    log(f"慢速資料的快取時效：配息 {DIV_FRESH_DAYS} 天、"
        f"月營收 {revenue_ttl_hours() // 24} 天、季EPS {eps_ttl_hours() // 24} 天"
        "（這幾項是月更/季更，不用每天重抓，省下來的額度留給股價和三大法人）")
    log("抓股票/ETF中文名稱對照表...")
    try:
        names, markets = fetch_names()
        tickers["names"] = {c: names.get(c, c) for c in (tickers["stocks"] + tickers["etfs"])}
        MARKET_OF.update({c: markets.get(c) for c in (tickers["stocks"] + tickers["etfs"])})
        with open(os.path.join(DATA_DIR, "tickers.json"), "w", encoding="utf-8") as f:
            json.dump(tickers, f, ensure_ascii=False, indent=2)
    except QuotaExceeded:
        log("  額度用完，先跳過中文名稱（卡片會先顯示代號），之後補跑就會補上。")

    log("查最新公布進度（看資料實際公布到哪一天，不用猜公布時間）...")
    try:
        probe_targets(tickers)
    except QuotaExceeded:
        log("  額度用完，這輪先照舊的快取時效跑。")
    log(f"  上市收盤價 最新到 {TARGETS['twse'] or '(查不到)'}")
    log(f"  上櫃收盤價 最新到 {TARGETS['tpex'] or '(查不到)'}"
        + ("（上櫃比上市晚公布，下午較晚才會進來）" if TARGETS["tpex"] and TARGETS["twse"]
           and TARGETS["tpex"] < TARGETS["twse"] else ""))
    log(f"  三大法人   最新到 {TARGETS['inst'] or '(查不到)'}"
        + ("（三大法人是盤後約下午4點後才公布，太早跑就只會抓到前一個交易日）"
           if TARGETS["inst"] and TARGETS["twse"] and TARGETS["inst"] < TARGETS["twse"] else ""))

    log("抓總經面板 (黃金/原油/美債10年/台股大盤/匯率)...")
    build_macro()
    done += 1
    log(f"  [{done}/{total}] 完成")

    log("抓股票分割/面額變更紀錄（還原K線要用，全市場一次抓完）...")
    try:
        splits = fetch_splits()
        log(f"  近三年有 {len(splits)} 檔做過分割/面額變更")
    except QuotaExceeded:
        splits = {}
        log("  額度用完，這輪還原K線先只考慮除權息。")

    log("更新 ETF 前十大成分股（5 天內沿用快取）...")
    fetch_etf_holdings(etfs)

    results = {"stocks": [], "etfs": []}
    try:
        for code in stocks:
            r = build_one(code, "stock", splits)
            done += 1
            log(f"  [{done}/{total}] 個股 {code} 完成 "
                f"(收盤={r['latest_close']}, 殖利率={r['trailing_yield_pct']})")
            results["stocks"].append(code)

        for code in etfs:
            r = build_one(code, "etf", splits)
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

    # 「跑的時間」和「資料到哪一天」是兩回事：晚上跑，但三大法人那天還沒公布，
    # 資料就會停在前一個交易日。兩個都寫進去，網站才能誠實顯示。
    # 收盤價還要分上市/上櫃：下午跑的時候上市有今天、上櫃還停在昨天，
    # 如果只寫一個最大值，就會變成「標示今天、但一堆上櫃的卡片其實是昨天」——
    # 那正是這次要修掉的那種假訊息。
    all_codes = tickers["stocks"] + tickers["etfs"]
    twse_codes = [c for c in all_codes if MARKET_OF.get(c) == "twse"]
    tpex_codes = [c for c in all_codes if MARKET_OF.get(c) == "tpex"]
    meta = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "price_date_twse": latest_date_in_files(tickers, "price", "t", twse_codes) if twse_codes else None,
        "price_date_tpex": latest_date_in_files(tickers, "price", "t", tpex_codes) if tpex_codes else None,
        "price_date": latest_date_in_files(tickers, "price", "t"),
        "institutional_date": latest_date_in_files(tickers, "retail_flow", "date"),
        "status": status,
        "stock_count": len(have_stocks),
        "stock_total": len(tickers["stocks"]),
        "etf_count": len(have_etfs),
        "etf_total": len(tickers["etfs"]),
    }
    with open(os.path.join(DATA_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    save_state()
    if meta["price_date_twse"] and meta["price_date_tpex"] and meta["price_date_twse"] != meta["price_date_tpex"]:
        price_desc = f"上市到 {meta['price_date_twse']}、上櫃到 {meta['price_date_tpex']}"
    else:
        price_desc = f"到 {meta['price_date']}"
    log(f"資料日期：收盤價{price_desc}、三大法人到 {meta['institutional_date']}")
    if meta["price_date_tpex"] and meta["price_date_twse"] and meta["price_date_tpex"] < meta["price_date_twse"]:
        log("  （上櫃還沒公布完，晚點再跑一次就會補上）")

    if status == "complete":
        log(f"全部完成！共 {meta['stock_count']} 檔個股、{meta['etf_count']} 檔ETF。")
        log("打開 index.html 就可以看了。")


if __name__ == "__main__":
    main()

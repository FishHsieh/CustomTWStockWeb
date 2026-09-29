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
import http.client
import json
import os
import re
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
import ssl
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
FRESH_ONLY = False  # 單檔加入追蹤時不讀舊快取，避免把舊資料冒充成剛更新。
FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
TWSE_DAILY_PRICE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_DAILY_PRICE_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes"
TWSE_DAILY_INSTITUTIONAL_URL = "https://www.twse.com.tw/rwd/zh/fund/T86"
TPEX_DAILY_INSTITUTIONAL_URL = "https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading"
TWSE_MONTHLY_REVENUE_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L"
TPEX_MONTHLY_REVENUE_URL = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O"
TWSE_MARKET_INSTITUTIONAL_URL = "https://www.twse.com.tw/rwd/zh/fund/BFI82U"
TAIFEX_DAILY_INSTITUTIONAL_URL = (
    "https://openapi.taifex.com.tw/v1/"
    "MarketDataOfMajorInstitutionalTradersDetailsOfFuturesContractsBytheDate"
)
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
ACTIVE_ETF_CHANGES_FILE = os.path.join(DATA_DIR, "active_etf_changes.json")
FOREIGN_FLOW_FILE = os.path.join(DATA_DIR, "foreign_flow.json")
ACTIVE_ETF_DATES_URL = "https://super168.work/api/dates"
ACTIVE_ETF_DIFF_URL = "https://super168.work/api/diff"
ACTIVE_ETF_TREND_URL = "https://www.jojoradar.com/api/{etf}/stock_trend/{stock}"
ACTIVE_ETF_CODES = ("00981A", "00991A", "00990A", "00982A", "00992A", "00403A")
DIVIDEND_ETF_CODES = ("00919", "0056", "00878", "00918", "00901", "00891", "00830", "00947", "00735", "0052", "0050")
DIVIDEND_ETF_FLOW_FILE = os.path.join(DATA_DIR, "dividend_etf_flow.json")
ACTIVE_ETF_NAMES = {
    "00981A": "主動統一台股增長",
    "00991A": "主動復華未來50",
    "00990A": "主動元大AI新經濟",
    "00982A": "00982A",
    "00992A": "00992A",
    "00403A": "00403A",
}

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
    if cache_key and not force and not FRESH_ONLY:
        cache_path = os.path.join(CACHE_DIR, cache_key + ".json")
        if os.path.exists(cache_path):
            age_h = (time.time() - os.path.getmtime(cache_path)) / 3600
            if age_h < ttl:
                cached = read_cache(cache_key)
                if cached is not None and (min_date is None or (payload_max_date(cached) or "") >= min_date):
                    return cached

    qs = urllib.parse.urlencode(params)
    full_url = f"{url}?{qs}" if qs else url
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
        except (urllib.error.URLError, TimeoutError, http.client.HTTPException,
                json.JSONDecodeError, UnicodeDecodeError) as e:
            last_err = e
            wait = min(30, 2 ** attempt)
            log(f"  ! {cache_key or url} 傳輸/JSON 不完整或連線失敗 ({e})，{wait}s 後重試 ({attempt}/{MAX_RETRIES})")
            time.sleep(wait)
    log(f"  !! {cache_key or url} 放棄，最後錯誤: {last_err}")
    if cache_key and not FRESH_ONLY:
        stale = read_cache(cache_key)
        if stale is not None and (min_date is None or (payload_max_date(stale) or "") >= min_date):
            log(f"  -> {cache_key} 先沿用上次抓到的舊資料（不讓這一項變空白）")
            return stale
        if stale is not None and min_date:
            log(f"  -> {cache_key} cache does not reach required date {min_date}; ignoring stale response")
    return None


def post_json(url, payload):
    """以 JSON POST 呼叫公開資料端點。"""
    body = json.dumps(payload).encode("utf-8")
    headers = {"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}
    # Sinotrade's chain omits a Subject Key Identifier required by OpenSSL's
    # optional X.509 strict-profile checks. Keep CA-chain and hostname checks
    # enabled, relaxing only that profile check for this ETF API helper.
    tls_context = ssl.create_default_context()
    if hasattr(ssl, "VERIFY_X509_STRICT"):
        tls_context.verify_flags &= ~ssl.VERIFY_X509_STRICT
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=20, context=tls_context) as resp:
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


def fetch_active_etf_changes(codes=ACTIVE_ETF_CODES):
    """抓主動式 ETF 近一個月每日持股快照差異。

    super168 的 diff API 以官方每日 PCF 快照計算異動；JoJoRadar 的
    stock_trend API 用來補齊新進／剔除在前後兩日的實際股數。價格不是
    交易回報，而是本專案同日個股收盤價，僅作估算參考。
    """
    all_items = {}
    price_cache = {}
    trend_cache = {}

    def close_price(stock, date):
        if stock not in price_cache:
            try:
                with open(os.path.join(STOCKS_DIR, f"{stock}.json"), encoding="utf-8") as f:
                    payload = json.load(f)
                price_cache[stock] = {row.get("t"): row.get("c") for row in payload.get("price", [])}
            except (OSError, ValueError, TypeError):
                price_cache[stock] = {}
        return price_cache[stock].get(date)

    def trend_shares(etf, stock, date):
        # 00990A 可能含海外股票代碼（例如「DIOD US」），JoJoRadar
        # 的逐股趨勢端點只支援台股代號；海外標的改用 diff API 的股數。
        if etf == "00990A" or not re.fullmatch(r"\d{4,6}", stock):
            return None
        key = (etf, stock)
        if key not in trend_cache:
            payload = http_get_json(
                ACTIVE_ETF_TREND_URL.format(etf=etf, stock=stock), {},
                cache_key=f"active_etf_trend_{etf}_{stock}", max_age_hours=12,
            ) or {}
            trend_cache[key] = {row.get("date"): row.get("shares_qty") for row in payload.get("rows", [])}
        values = trend_cache[key]
        if date in values and values[date] is not None:
            return float(values[date])
        prior = [d for d in values if d and d <= date and values[d] is not None]
        return float(values[max(prior)]) if prior else None

    def make_item(etf, date, row, action, previous=None, current=None):
        stock = str(row.get("code") or "")
        if not stock:
            return None
        if previous is None:
            previous = row.get("shares_prev")
        if current is None:
            current = row.get("shares")
        previous = float(previous or 0)
        current = float(current or 0)
        delta = current - previous
        price = close_price(stock, date)
        price_label = "同日收盤參考價"
        if price is None:
            prior_dates = [d for d in price_cache.get(stock, {}) if d and d < date and price_cache[stock][d] is not None]
            pct = row.get("pct")
            if prior_dates and pct is not None:
                prior_price = price_cache[stock][max(prior_dates)]
                price = round(float(prior_price) * (1 + float(pct) / 100), 2)
                price_label = "以前日收盤按來源漲跌幅推算"
        return {
            "date": date,
            "action": action,
            "code": stock,
            "name": row.get("name") or stock,
            "shares_prev": previous,
            "shares": current,
            "delta_shares": delta,
            "delta_lots": delta / 1000,
            "price": price,
            "price_label": price_label,
            "estimated_amount": abs(delta) * price if price is not None else None,
            "weight": row.get("weight"),
            "weight_prev": row.get("weight_prev"),
        }

    for etf in codes:
        dates = http_get_json(
            f"{ACTIVE_ETF_DATES_URL}/{etf}", {"ds": "active"},
            cache_key=f"active_etf_dates_{etf}", force=True,
        ) or []
        dates = sorted(str(date) for date in dates if date)
        if len(dates) < 2:
            continue
        latest = datetime.strptime(dates[-1], "%Y-%m-%d")
        start = (latest - timedelta(days=93)).strftime("%Y-%m-%d")
        recent_dates = [date for date in dates if date >= start]
        events = []
        for previous_date, date in zip(recent_dates, recent_dates[1:]):
            diff = http_get_json(
                f"{ACTIVE_ETF_DIFF_URL}/{etf}",
                {"from": previous_date, "to": date, "ds": "active"},
                cache_key=f"active_etf_diff_{etf}_{date}", force=True,
            ) or {}
            for row in diff.get("added", []):
                stock = str(row.get("code") or "")
                # The diff endpoint already includes the current share count.
                # Only fall back to jojoradar when that field is unavailable;
                # some newer ETFs have constituents that return 404 there.
                current = row.get("shares")
                if current is None:
                    current = row.get("dshares")
                item = make_item(etf, date, row, "新進", previous=0, current=current or row.get("shares"))
                if item and item["delta_shares"] > 0:
                    events.append(item)
            for row in diff.get("removed", []):
                stock = str(row.get("code") or "")
                previous = row.get("shares_prev")
                current = row.get("shares")
                if previous is None:
                    previous = abs(float(row.get("dshares") or 0))
                if current is None:
                    current = 0
                if current is None or current <= 1000:
                    current = 0
                item = make_item(etf, date, row, "剔除", previous=previous or row.get("shares"), current=current)
                if item and item["delta_shares"] < 0:
                    events.append(item)
            for row in diff.get("changed", []):
                action = row.get("action") or ("加碼" if row.get("dshares", 0) > 0 else "減碼")
                item = make_item(etf, date, row, action)
                if item and item["delta_shares"] != 0:
                    events.append(item)
        all_items[etf] = {
            "code": etf,
            "name": ACTIVE_ETF_NAMES.get(etf, etf),
            "from": recent_dates[0] if recent_dates else None,
            "to": recent_dates[-1] if recent_dates else None,
            "events": sorted(events, key=lambda row: (row["date"], row["code"]), reverse=True),
        }

    mover_map = {}
    for item in all_items.values():
        for row in item["events"]:
            key = row["code"]
            mover = mover_map.setdefault(key, {
                "code": key,
                "name": row["name"],
                "buy_lots": 0,
                "sell_lots": 0,
                "turnover_lots": 0,
                "net_lots": 0,
                "event_count": 0,
                "etfs": set(),
            })
            delta_lots = float(row["delta_lots"])
            if delta_lots > 0:
                mover["buy_lots"] += delta_lots
            else:
                mover["sell_lots"] += abs(delta_lots)
            mover["turnover_lots"] += abs(delta_lots)
            mover["net_lots"] += delta_lots
            mover["event_count"] += 1
            mover["etfs"].add(item["code"])
    top_movers = sorted(mover_map.values(), key=lambda row: row["turnover_lots"], reverse=True)[:60]
    for row in top_movers:
        row["etfs"] = sorted(row["etfs"])
        for key in ("buy_lots", "sell_lots", "turnover_lots", "net_lots"):
            row[key] = round(row[key], 2)

    payload = {
        "source": {
            "holdings": "https://super168.work/",
            "trend": "https://www.jojoradar.com/",
            "price": "data/stocks/*.json",
        },
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "items": all_items,
        "top_movers": top_movers,
        "top_movers_period_days": 93,
        "note": "張數為公開每日持股快照差額；價格為同日收盤參考價，不代表經理人逐筆成交價。",
    }
    with open(ACTIVE_ETF_CHANGES_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    log(f"主動式 ETF 異動已更新：{sum(len(v['events']) for v in all_items.values())} 筆")
    return payload


def rebuild_active_etf_top_movers():
    """不重抓網路資料，使用既有事件快取重算前 60 名。"""
    try:
        with open(ACTIVE_ETF_CHANGES_FILE, encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, ValueError, TypeError):
        return None
    mover_map = {}
    for item in (payload.get("items") or {}).values():
        for row in item.get("events") or []:
            key = row.get("code")
            if not key:
                continue
            mover = mover_map.setdefault(key, {
                "code": key, "name": row.get("name", key), "buy_lots": 0,
                "sell_lots": 0, "turnover_lots": 0, "net_lots": 0,
                "event_count": 0, "etfs": set(),
            })
            delta = float(row.get("delta_lots") or 0)
            if delta > 0:
                mover["buy_lots"] += delta
            else:
                mover["sell_lots"] += abs(delta)
            mover["turnover_lots"] += abs(delta)
            mover["net_lots"] += delta
            mover["event_count"] += 1
            mover["etfs"].add(item.get("code"))
    top = sorted(mover_map.values(), key=lambda row: row["turnover_lots"], reverse=True)[:60]
    for row in top:
        row["etfs"] = sorted(row["etfs"])
        for key in ("buy_lots", "sell_lots", "turnover_lots", "net_lots"):
            row[key] = round(row[key], 2)
    payload["top_movers"] = top
    payload["top_movers_period_days"] = 93
    with open(ACTIVE_ETF_CHANGES_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return payload


def build_foreign_flow(period_days=93, limit=20):
    """用已抓好的個股三大法人資料，建立外資近三個月買賣排行。"""
    names = {}
    try:
        with open(os.path.join(DATA_DIR, "tickers.json"), encoding="utf-8") as f:
            names = (json.load(f).get("names") or {})
    except (OSError, ValueError, TypeError):
        pass

    records = []
    latest_dates = []
    for filename in os.listdir(STOCKS_DIR):
        if not filename.endswith(".json"):
            continue
        try:
            with open(os.path.join(STOCKS_DIR, filename), encoding="utf-8") as f:
                stock = json.load(f)
            if stock.get("kind") != "stock" or not stock.get("retail_flow"):
                continue
            records.append((stock.get("code") or filename[:-5], stock.get("retail_flow") or []))
            latest_dates.extend(row.get("date") for row in stock.get("retail_flow") or [] if row.get("date"))
        except (OSError, ValueError, TypeError):
            continue
    latest = max(latest_dates) if latest_dates else None
    if not latest:
        return None
    def build_period(days):
        start = (datetime.strptime(latest, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")
        totals = {}
        for code, rows in records:
            selected = [row for row in rows if start <= row.get("date", "") <= latest]
            if not selected:
                continue
            buy = sum(max(float(row.get("foreign_lots") or 0), 0) for row in selected)
            sell = sum(abs(min(float(row.get("foreign_lots") or 0), 0)) for row in selected)
            net = buy - sell
            totals[code] = {
                "code": code,
                "name": names.get(code, code),
                "buy_lots": round(buy, 2),
                "sell_lots": round(sell, 2),
                "net_lots": round(net, 2),
                "days": len(selected),
            }
        return {
            "from": start,
            "to": latest,
            "universe": len(totals),
            "top_buy": sorted(totals.values(), key=lambda row: row["net_lots"], reverse=True)[:limit],
            "top_sell": sorted(totals.values(), key=lambda row: row["net_lots"])[:limit],
        }

    periods = {str(days): build_period(days) for days in (7, 14, 31, 62, 93)}
    current = periods[str(period_days)]
    payload = {
        "source": "FinMind TaiwanStockInstitutionalInvestorsBuySell",
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "from": current["from"],
        "to": current["to"],
        "universe": current["universe"],
        "periods": periods,
        "note": "範圍為網站目前已抓取的台股個股；外資包含 Foreign_Investor 與 Foreign_Dealer_Self。",
        "top_buy": current["top_buy"],
        "top_sell": current["top_sell"],
    }
    with open(FOREIGN_FLOW_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    log(f"外資排行資料已更新：涵蓋 {current['universe']} 檔個股")
    return payload

def build_dividend_etf_flow(period_days=93):
    """建立指定高股息 ETF 的多期間外資、投信、散戶買賣排行。"""
    names = {}
    try:
        with open(os.path.join(DATA_DIR, "tickers.json"), encoding="utf-8") as f:
            names = (json.load(f).get("names") or {})
    except (OSError, ValueError, TypeError):
        pass

    rows_by_etf = {}
    latest_dates = []
    for code in DIVIDEND_ETF_CODES:
        path = os.path.join(STOCKS_DIR, f"{code}.json")
        try:
            with open(path, encoding="utf-8") as f:
                stock = json.load(f)
            rows = stock.get("retail_flow") or []
            rows_by_etf[code] = rows
            latest_dates.extend(row.get("date") for row in rows if row.get("date"))
        except (OSError, ValueError, TypeError):
            rows_by_etf[code] = []
    latest = max(latest_dates) if latest_dates else None
    if not latest:
        return None

    def summarize(days):
        start = (datetime.strptime(latest, "%Y-%m-%d") - timedelta(days=days)).strftime("%Y-%m-%d")
        result = []
        for code in DIVIDEND_ETF_CODES:
            rows = [row for row in rows_by_etf.get(code, []) if start <= row.get("date", "") <= latest]
            if not rows:
                continue
            metrics = {}
            for label, key in (("foreign", "foreign_lots"), ("trust", "trust_lots"), ("retail", "retail_lots")):
                net = sum(float(row.get(key) or 0) for row in rows)
                metrics[label] = {
                    "buy_lots": round(sum(max(float(row.get(key) or 0), 0) for row in rows), 2),
                    "sell_lots": round(sum(abs(min(float(row.get(key) or 0), 0)) for row in rows), 2),
                    "net_lots": round(net, 2),
                }
            result.append({"code": code, "name": names.get(code, code), "days": len(rows), **metrics})
        return {"from": start, "to": latest, "rows": result}

    periods = {str(days): summarize(days) for days in (7, 14, 31, 62, 93)}
    payload = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "codes": list(DIVIDEND_ETF_CODES),
        "periods": periods,
        "note": "買賣張數依 ETF 本身每日三大法人資料加總；散戶為反推的市場散戶淨買賣估計。",
    }
    with open(DIVIDEND_ETF_FLOW_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    log(f"指定 ETF 法人買賣資料已更新：{len(rows_by_etf)} 檔")
    return payload


def finmind(dataset, data_id, start_date, cache_key, min_date=None, force=False,
            max_age_hours=None):
    params = {"dataset": dataset, "start_date": start_date}
    if data_id:
        params["data_id"] = data_id
    data = http_get_json(
        FINMIND_URL, params, cache_key=cache_key, auth_token=FINMIND_TOKEN,
        min_date=min_date, force=(force or FRESH_ONLY), max_age_hours=max_age_hours,
    )
    if not data or data.get("status") != 200:
        if FRESH_ONLY:
            raise RuntimeError(f"FinMind {dataset}/{data_id or 'all'} 沒有取得新資料，拒絕使用快取")
        return []
    return data.get("data", [])


# 這一輪的基準日，main() 開頭用 probe_targets() 算出來：
# 上市收盤價 / 上櫃收盤價 / 三大法人，各自最新已經公布到哪一個交易日。
TARGETS = {"twse": None, "tpex": None, "inst": None}
PRICE_TARGETS = {"twse": None, "tpex": None}
MARKET_OF = {}  # 代號 -> "twse" / "tpex"
# 官方端點一次回傳全市場最新交易日，這裡保留成「市場 -> 代號 -> 日線」的索引。
# 日線主來源改為 TWSE/TPEx；FinMind 僅在官方沒有該標的或既有歷史不存在時才補上。
OFFICIAL_PRICE_ROWS = {"twse": {}, "tpex": {}}
# 個股法人資料由 TWSE T86 與 TPEx 全市場端點供應；兩者都能保留現有
# Foreign_Investor + Foreign_Dealer_Self、投信與自營商合計的欄位定義。
OFFICIAL_INSTITUTIONAL_ROWS = {"twse": {}, "tpex": {}}
OFFICIAL_INSTITUTIONAL_DATES = {"twse": None, "tpex": None}
# 月營收官方端點每次回傳全市場「最新已公告月份」；金額單位為千元，讀取時
# 會轉成現有 JSON／FinMind 使用的元，避免前端與 YoY/MoM 計算改變單位。
OFFICIAL_REVENUE_ROWS = {"twse": {}, "tpex": {}}
# FinMind 的 TaiwanStockTotalInstitutionalInvestors 實際對應上市市場（TWSE）
# 的 BFI82U 三大法人買賣金額表，不是上市櫃合併值。
OFFICIAL_MARKET_INSTITUTIONAL = None
OFFICIAL_FUTURES_FLOW = None


def roc_date_to_iso(value):
    """把官方 API 的民國日期（1150924 / 115/09/24）轉成 YYYY-MM-DD。"""
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) != 7:
        return None
    try:
        return f"{int(digits[:3]) + 1911:04d}-{digits[3:5]}-{digits[5:]}"
    except ValueError:
        return None


def roc_year_month(value):
    """把官方月營收的民國年月（11508）轉成 (2026, 8)。"""
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) != 5:
        return None, None
    year, month = int(digits[:3]) + 1911, int(digits[3:])
    return (year, month) if 1 <= month <= 12 else (None, None)


def official_number(value):
    """官方日成交端點的數值可能帶逗號、空白或 --。"""
    text = str(value or "").replace(",", "").strip()
    if not text or text in ("--", "---", "----"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def official_integer(value):
    number = official_number(value)
    return int(number) if number is not None else None


def official_signed_integer(value):
    text = str(value or "").replace(",", "").strip()
    if not text or text in ("--", "---", "----"):
        return 0
    try:
        return int(float(text))
    except ValueError:
        return 0


def fetch_official_daily_prices(market, force=False):
    """抓官方全市場最新日線，回傳 {代號: {t,o,h,l,c,v}}。

    TWSE 與 TPEx 都是全市場批次端點，因此每日各一次就能補齊追蹤清單，
    不再為每一檔標的各呼叫一次 FinMind。
    """
    if market == "twse":
        url, cache_key = TWSE_DAILY_PRICE_URL, "official_price_twse"
    else:
        url, cache_key = TPEX_DAILY_PRICE_URL, "official_price_tpex"
    payload = http_get_json(url, {}, cache_key=cache_key, force=force, max_age_hours=6) or []
    if not isinstance(payload, list):
        log(f"  ! 官方 {market} 日成交端點回應格式不符，改用 FinMind 備援")
        return {}

    rows = {}
    for item in payload:
        if not isinstance(item, dict):
            continue
        if market == "twse":
            code = str(item.get("Code") or "")
            point = {
                "t": roc_date_to_iso(item.get("Date")),
                "o": official_number(item.get("OpeningPrice")),
                "h": official_number(item.get("HighestPrice")),
                "l": official_number(item.get("LowestPrice")),
                "c": official_number(item.get("ClosingPrice")),
                "v": official_integer(item.get("TradeVolume")),
            }
        else:
            code = str(item.get("SecuritiesCompanyCode") or "")
            point = {
                "t": roc_date_to_iso(item.get("Date")),
                "o": official_number(item.get("Open")),
                "h": official_number(item.get("High")),
                "l": official_number(item.get("Low")),
                "c": official_number(item.get("Close")),
                "v": official_integer(item.get("TradingShares")),
            }
        # 停牌／無成交資料不覆蓋既有歷史，交給 FinMind fallback 或下次更新。
        if code and point["t"] and point["c"] is not None:
            rows[code] = point
    return rows


def fetch_twse_daily_institutional(date):
    """抓 TWSE T86 全市場三大法人明細，標準化為 FinMind 既有的淨買賣股數。

    T86 明確分出「外陸資（不含外資自營商）」與「外資自營商」，因此合併後
    與現有 Foreign_Investor + Foreign_Dealer_Self 的定義一致。
    """
    if not date:
        return {}
    payload = http_get_json(
        TWSE_DAILY_INSTITUTIONAL_URL,
        {"response": "json", "date": date.replace("-", ""), "selectType": "ALLBUT0999"},
        cache_key=f"official_institutional_twse_{date}", max_age_hours=6,
    ) or {}
    fields, data = payload.get("fields"), payload.get("data")
    if not isinstance(fields, list) or not isinstance(data, list) or len(fields) < 18:
        log("  ! 官方 TWSE 三大法人端點回應格式不符，改用 FinMind 備援")
        return {}

    rows = {}
    for item in data:
        if not isinstance(item, list) or len(item) < 18:
            continue
        code = str(item[0] or "").strip()
        if not code:
            continue
        # 欄位位置依 TWSE T86 官方欄位順序：外資(不含自營商)、外資自營商、
        # 投信、自營商自行買賣、自營商避險；所有數值單位皆為股。
        rows[code] = {
            "foreign": (
                official_signed_integer(item[2]) - official_signed_integer(item[3])
                + official_signed_integer(item[5]) - official_signed_integer(item[6])
            ),
            "trust": official_signed_integer(item[8]) - official_signed_integer(item[9]),
            "dealer": (
                official_signed_integer(item[12]) - official_signed_integer(item[13])
                + official_signed_integer(item[15]) - official_signed_integer(item[16])
            ),
        }
    return rows


def fetch_tpex_daily_institutional():
    """抓 TPEx 全市場三大法人明細，回傳 (ISO 日期, {代號: 淨買賣股數})。

    TPEx 端點提供外資（不含外資自營商）、外資自營商、投信及自營商合計；
    既有輸出只存自營商合計，所以不需要另行拆分自行買賣／避險。
    """
    payload = http_get_json(
        TPEX_DAILY_INSTITUTIONAL_URL, {}, cache_key="official_institutional_tpex",
        max_age_hours=6,
    ) or []
    if not isinstance(payload, list):
        log("  ! 官方 TPEx 三大法人端點回應格式不符，改用 FinMind 備援")
        return None, {}

    rows, dates = {}, set()
    for item in payload:
        if not isinstance(item, dict):
            continue
        code = str(item.get("SecuritiesCompanyCode") or "").strip()
        date = roc_date_to_iso(item.get("Date"))
        if not code or not date:
            continue
        dates.add(date)
        foreign = (
            official_signed_integer(
                item.get("ForeignInvestorsInclude MainlandAreaInvestors-Difference")
            )
            + official_signed_integer(item.get("ForeignDealers-Difference"))
        )
        rows[code] = {
            "foreign": foreign,
            "trust": official_signed_integer(item.get("SecuritiesInvestmentTrustCompanies-Difference")),
            "dealer": official_signed_integer(item.get("Dealers-Difference")),
        }
    # 官方回應預期為單一交易日；多日期時拒用，避免把資料寫到錯誤日期。
    if len(dates) != 1:
        log("  ! 官方 TPEx 三大法人日期不唯一，改用 FinMind 備援")
        return None, {}
    return dates.pop(), rows


def fetch_official_monthly_revenue(market):
    """抓官方全市場最新月營收，轉成 {(西元年, 月): 元} 的既有單位。"""
    if market == "twse":
        url, cache_key = TWSE_MONTHLY_REVENUE_URL, "official_revenue_twse"
    else:
        url, cache_key = TPEX_MONTHLY_REVENUE_URL, "official_revenue_tpex"
    payload = http_get_json(
        url, {}, cache_key=cache_key, max_age_hours=revenue_ttl_hours()
    ) or []
    if not isinstance(payload, list):
        log(f"  ! 官方 {market} 月營收端點回應格式不符，改用 FinMind 備援")
        return {}

    rows = {}
    for item in payload:
        if not isinstance(item, dict):
            continue
        code = str(item.get("公司代號") or "").strip()
        year, month = roc_year_month(item.get("資料年月"))
        # TWSE／TPEx 公開資料的月營收單位是「千元」；現有資料是「元」。
        revenue_thousands = official_integer(item.get("營業收入-當月營收"))
        if code and year and month and revenue_thousands is not None:
            rows[code] = (year, month, revenue_thousands * 1000)
    return rows


def fetch_twse_market_institutional(date):
    """抓 TWSE BFI82U 全市場法人買賣金額，保留 FinMind 的既有分類口徑。"""
    if not date:
        return None
    payload = http_get_json(
        TWSE_MARKET_INSTITUTIONAL_URL,
        {"response": "json", "dayDate": date.replace("-", ""), "type": "day"},
        cache_key=f"official_market_institutional_{date}", max_age_hours=6,
    ) or {}
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or len(rows) < 6:
        log("  ! 官方 TWSE 全市場法人端點回應格式不符，改用 FinMind 備援")
        return None
    try:
        # BFI82U 順序：自營商自行、避險、投信、外資、外資自營商、合計。
        # 為了不改變既有圖表，外資自營商仍併到 foreign；官方合計則原樣使用。
        return {
            "date": date,
            "foreign": official_signed_integer(rows[3][3]) + official_signed_integer(rows[4][3]),
            "trust": official_signed_integer(rows[2][3]),
            "dealer": official_signed_integer(rows[0][3]) + official_signed_integer(rows[1][3]),
            "total": official_signed_integer(rows[5][3]),
        }
    except (IndexError, TypeError):
        log("  ! 官方 TWSE 全市場法人欄位不完整，改用 FinMind 備援")
        return None


def fetch_taifex_futures_institutional():
    """抓 TAIFEX 最新 TX 外資、投信未平倉淨口數。"""
    payload = http_get_json(
        TAIFEX_DAILY_INSTITUTIONAL_URL, {}, cache_key="official_futures_institutional_TX",
        max_age_hours=6,
    ) or []
    if not isinstance(payload, list):
        log("  ! 官方 TAIFEX 法人期貨端點回應格式不符，改用 FinMind 備援")
        return None

    tx_name = "\u81fa\u80a1\u671f\u8ca8"
    trust_name = "\u6295\u4fe1"
    foreign_names = ("\u5916\u8cc7\u53ca\u9678\u8cc7", "\u5916\u8cc7")
    rows = [row for row in payload if isinstance(row, dict) and row.get("ContractCode") == tx_name]
    dates = {str(row.get("Date") or "") for row in rows if row.get("Date")}
    if len(dates) != 1:
        log("  ! 官方 TAIFEX TX 日期不唯一，改用 FinMind 備援")
        return None

    date_digits = dates.pop()
    if len(date_digits) != 8 or not date_digits.isdigit():
        log("  ! 官方 TAIFEX TX 日期格式不符，改用 FinMind 備援")
        return None
    date = f"{date_digits[:4]}-{date_digits[4:6]}-{date_digits[6:]}"
    result = {"date": date}
    for row in rows:
        item = row.get("Item")
        if item == trust_name:
            result["trust"] = official_signed_integer(row.get("OpenInterest(Net)"))
        elif item in foreign_names:
            result["foreign"] = official_signed_integer(row.get("OpenInterest(Net)"))
    if "foreign" not in result or "trust" not in result:
        log("  ! 官方 TAIFEX TX 缺少外資或投信欄位，改用 FinMind 備援")
        return None
    return result


def add_moving_averages(points):
    """替標準化後的日線重算均線，避免不同來源留下不一致的 ma 值。"""
    points = sorted(points, key=lambda point: point["t"])
    closes = [point["c"] for point in points]
    for key, window in MA_WINDOWS.items():
        for i, point in enumerate(points):
            point[key] = None if i + 1 < window else round(
                sum(closes[i + 1 - window:i + 1]) / window, 4
            )
    return points


def existing_price_history(code):
    """讀取既有輸出日線；官方批次日線只補最新一天，歷史仍可沿用。"""
    path = os.path.join(STOCKS_DIR, f"{code}.json")
    try:
        with open(path, encoding="utf-8") as f:
            rows = json.load(f).get("price") or []
        return [
            {key: row.get(key) for key in ("t", "o", "h", "l", "c", "v")}
            for row in rows
            if row.get("t") and row.get("c") is not None
        ]
    except (OSError, ValueError, TypeError):
        return []


def existing_retail_flow(code):
    path = os.path.join(STOCKS_DIR, f"{code}.json")
    try:
        with open(path, encoding="utf-8") as f:
            rows = json.load(f).get("retail_flow") or []
        return [row for row in rows if row.get("date")]
    except (OSError, ValueError, TypeError):
        return []


def existing_revenue_history(code):
    """讀取既有月營收，讓官方快照只取代最新已公告月份。"""
    path = os.path.join(STOCKS_DIR, f"{code}.json")
    try:
        with open(path, encoding="utf-8") as f:
            rows = json.load(f).get("revenue") or []
        return {
            (int(row["year"]), int(row["month"])): row.get("revenue")
            for row in rows
            if row.get("year") is not None and row.get("month") is not None
            and row.get("revenue") is not None
        }
    except (OSError, ValueError, TypeError, KeyError):
        return {}


def price_target(code):
    """這一檔的收盤價應該要有哪一天。上櫃比上市晚公布，所以兩個市場分開看。"""
    market = MARKET_OF.get(code)
    if market in TARGETS:
        return PRICE_TARGETS.get(market) or TARGETS[market]
    # 不知道是上市還上櫃時取比較早的那個，寧可少抓一次也不要每次都白抓
    known = [d for d in (TARGETS["twse"], TARGETS["tpex"]) if d]
    return min(known) if known else None


def probe_targets(tickers):
    """取得各市場最新公布日。

    價格優先使用官方全市場日成交資料；官方端點暫時失敗時才以 FinMind 樣本
    探測日期。個別法人與月營收也優先使用官方全市場端點，無法取得時才備援。
    """
    for market in ("twse", "tpex"):
        rows = fetch_official_daily_prices(market)
        OFFICIAL_PRICE_ROWS[market] = rows
        if rows:
            TARGETS[market] = max(row["t"] for row in rows.values())
            for code in rows:
                MARKET_OF[code] = market
            log(f"  官方 {market} 日成交：{len(rows)} 檔，最新到 {TARGETS[market]}")

    # TWSE and TPEx normally publish the same trading day. If one official
    # feed is behind, bypass its local cache once before accepting that date.
    available_targets = [date for date in (TARGETS["twse"], TARGETS["tpex"]) if date]
    freshest_target = max(available_targets) if available_targets else None
    for market in ("twse", "tpex"):
        if not freshest_target or not TARGETS[market] or TARGETS[market] >= freshest_target:
            continue
        log(f"  ! {market} official quotes stop at {TARGETS[market]}, behind {freshest_target}; retrying without cache")
        rows = fetch_official_daily_prices(market, force=True)
        if rows:
            OFFICIAL_PRICE_ROWS[market] = rows
            TARGETS[market] = max(row["t"] for row in rows.values())
            for code in rows:
                MARKET_OF[code] = market
        if not TARGETS[market] or TARGETS[market] < freshest_target:
            PRICE_TARGETS[market] = freshest_target
            log(f"  ! {market} official feed remains behind; fallback prices must reach {freshest_target}")

    def latest(data_id, cache_key):
        rows = finmind("TaiwanStockPrice", data_id, REF_START, cache_key, force=True)
        dates = [r.get("date") for r in rows if r.get("date")]
        return max(dates) if dates else None

    for market in ("twse", "tpex"):
        if TARGETS[market]:
            continue
        refs = [c for c in tickers["stocks"] if MARKET_OF.get(c) == market][:2]
        found = [d for d in (latest(c, f"ref_price_{market}_{i}") for i, c in enumerate(refs)) if d]
        TARGETS[market] = max(found) if found else None

    # 上市個別三大法人與價格共用官方公布日，成功時可避免每檔都打 FinMind。
    OFFICIAL_INSTITUTIONAL_ROWS["twse"] = fetch_twse_daily_institutional(TARGETS["twse"])
    if OFFICIAL_INSTITUTIONAL_ROWS["twse"]:
        OFFICIAL_INSTITUTIONAL_DATES["twse"] = TARGETS["twse"]
        log(f"  官方 TWSE 三大法人：{len(OFFICIAL_INSTITUTIONAL_ROWS['twse'])} 檔，"
            f"最新到 {TARGETS['twse']}")

    tpex_inst_date, tpex_inst_rows = fetch_tpex_daily_institutional()
    if tpex_inst_rows and tpex_inst_date == TARGETS["tpex"]:
        OFFICIAL_INSTITUTIONAL_ROWS["tpex"] = tpex_inst_rows
        OFFICIAL_INSTITUTIONAL_DATES["tpex"] = tpex_inst_date
        log(f"  官方 TPEx 三大法人：{len(tpex_inst_rows)} 檔，最新到 {tpex_inst_date}")
    elif tpex_inst_rows:
        log(f"  ! 官方 TPEx 三大法人到 {tpex_inst_date}，與收盤價日期 "
            f"{TARGETS['tpex']} 不同，改用 FinMind 備援")

    for market in ("twse", "tpex"):
        OFFICIAL_REVENUE_ROWS[market] = fetch_official_monthly_revenue(market)
        if OFFICIAL_REVENUE_ROWS[market]:
            latest = max((year, month) for year, month, _ in OFFICIAL_REVENUE_ROWS[market].values())
            log(f"  官方 {market} 月營收：{len(OFFICIAL_REVENUE_ROWS[market])} 檔，"
                f"最新到 {latest[0]}-{latest[1]:02d}")

    global OFFICIAL_MARKET_INSTITUTIONAL
    OFFICIAL_MARKET_INSTITUTIONAL = fetch_twse_market_institutional(TARGETS["twse"])
    if OFFICIAL_MARKET_INSTITUTIONAL:
        log(f"  官方 TWSE 全市場法人：最新到 {OFFICIAL_MARKET_INSTITUTIONAL['date']}")

    global OFFICIAL_FUTURES_FLOW
    OFFICIAL_FUTURES_FLOW = fetch_taifex_futures_institutional()
    if OFFICIAL_FUTURES_FLOW:
        log(f"  官方 TAIFEX TX 法人未平倉：最新到 {OFFICIAL_FUTURES_FLOW['date']}")

    # 三大法人這份是全市場合計，順便就是 build_macro() 要用的那份快取，不會多打一次 API
    rows = finmind("TaiwanStockTotalInstitutionalInvestors", None, FIN_START,
                   "market_institutional", force=True)
    dates = [r.get("date") for r in rows if r.get("date")]
    TARGETS["inst"] = max(dates) if dates else None
    if OFFICIAL_FUTURES_FLOW and OFFICIAL_FUTURES_FLOW["date"] != TARGETS["inst"]:
        log(f"  ! TAIFEX 官方期貨資料到 {OFFICIAL_FUTURES_FLOW['date']}，與法人基準日 "
            f"{TARGETS['inst']} 不同，改用 FinMind 備援")
        OFFICIAL_FUTURES_FLOW = None


def fetch_price(code):
    market = MARKET_OF.get(code)
    official = OFFICIAL_PRICE_ROWS.get(market, {}).get(code)
    expected_date = price_target(code)
    if official and not FRESH_ONLY and (not expected_date or official["t"] >= expected_date):
        points_by_date = {point["t"]: point for point in existing_price_history(code)}
        points_by_date[official["t"]] = official
        # 有既有歷史時，官方資料是唯一的最新日線來源；完全新標的才向 FinMind 回補。
        if len(points_by_date) > 1:
            return add_moving_averages(list(points_by_date.values()))

    rows = finmind("TaiwanStockPrice", code, PRICE_START, f"price_{code}",
                   min_date=expected_date)
    points = [
        {
            "t": row["date"],
            "o": row.get("open"),
            "h": row.get("max"),
            "l": row.get("min"),
            "c": row.get("close"),
            "v": row.get("Trading_Volume"),
        }
        for row in rows
        # FinMind 偶爾會回傳整根都是 0 的K棒（停牌/當天沒有交易），
        # 收盤價 0 不是真的價格：留著會把K線的縱軸壓扁，也會污染均線，所以直接濾掉。
        if row.get("close")
    ]
    if FRESH_ONLY and not points:
        raise RuntimeError(f"{code} 沒有取得新的價格資料")
    if official:
        points = [point for point in points if point["t"] != official["t"]] + [official]
    if not points and not FRESH_ONLY:
        points = existing_price_history(code)
        if official:
            points = [point for point in points if point["t"] != official["t"]] + [official]
        if points:
            log(f"  ! {code} has no fresh price response; preserving existing price history")
    return add_moving_averages(points)


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


def build_revenue_records(by_month):
    """依既有 schema 從月營收值重算 YoY/MoM。"""
    sorted_items = sorted(by_month.items())
    out = []
    for i, ((y, m), rev) in enumerate(sorted_items):
        prev_year = by_month.get((y - 1, m))
        yoy = ((rev - prev_year) / prev_year * 100) if (rev is not None and prev_year) else None
        prev_month = sorted_items[i - 1][1] if i > 0 else None
        mom = ((rev - prev_month) / prev_month * 100) if (rev is not None and prev_month) else None
        out.append({"year": y, "month": m, "revenue": rev, "yoy_pct": yoy, "mom_pct": mom})
    return out


def fetch_revenue(code):
    official = OFFICIAL_REVENUE_ROWS.get(MARKET_OF.get(code), {}).get(code)
    if official and not FRESH_ONLY:
        year, month, revenue = official
        by_month = existing_revenue_history(code)
        by_month[(year, month)] = revenue
        # 有既有歷史時，官方資料是唯一的最新月營收來源；新標的才用 FinMind 回補。
        if len(by_month) > 1:
            return build_revenue_records(by_month)

    rows = finmind("TaiwanStockMonthRevenue", code, FIN_START, f"rev_{code}",
                   max_age_hours=jittered_hours(code, revenue_ttl_hours()))
    by_month = {}
    for r in rows:
        y, m = r.get("revenue_year"), r.get("revenue_month")
        if y is None or m is None:
            continue
        by_month[(y, m)] = r.get("revenue")
    if official:
        year, month, revenue = official
        by_month[(year, month)] = revenue
    return build_revenue_records(by_month)


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
    market = MARKET_OF.get(code)
    official = OFFICIAL_INSTITUTIONAL_ROWS.get(market, {}).get(code)
    official_date = OFFICIAL_INSTITUTIONAL_DATES.get(market)
    if official and official_date and not FRESH_ONLY:
        by_date = {row["date"]: row for row in existing_retail_flow(code)}
        by_date[official_date] = {
            "date": official_date,
            "foreign_lots": round(official["foreign"] / 1000),
            "trust_lots": round(official["trust"] / 1000),
            "dealer_lots": round(official["dealer"] / 1000),
            "institutional_lots": round(
                (official["foreign"] + official["trust"] + official["dealer"]) / 1000
            ),
            "retail_lots": round(
                -(official["foreign"] + official["trust"] + official["dealer"]) / 1000
            ),
        }
        # 有既有歷史時，官方資料是唯一的最新個別法人來源；新標的才用 FinMind 回補。
        if len(by_date) > 1:
            return [by_date[date] for date in sorted(by_date)]

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
    if official and official_date:
        out = [row for row in out if row["date"] != official_date]
        total_net = official["foreign"] + official["trust"] + official["dealer"]
        out.append({
            "date": official_date,
            "foreign_lots": round(official["foreign"] / 1000),
            "trust_lots": round(official["trust"] / 1000),
            "dealer_lots": round(official["dealer"] / 1000),
            "institutional_lots": round(total_net / 1000),
            "retail_lots": round(-total_net / 1000),
        })
        out.sort(key=lambda row: row["date"])
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


def fetch_foreign_etf_component_prices(holdings_db):
    """為 ETF 成分股中的海外代號建立可供前端查價的價格檔。"""
    codes = sorted({
        str(holding.get("code"))
        for item in (holdings_db.get("items") or {}).values()
        for holding in (item.get("holdings") or [])
        if str(holding.get("code") or "").rsplit(".", 1)[-1] in {"US", "JP", "KS"}
    })
    refreshed = 0
    failed = 0
    for code in codes:
        market = code.rsplit(".", 1)[-1]
        ticker = code.rsplit(".", 1)[0]
        symbol = ticker if market == "US" else f"{ticker}.T" if market == "JP" else f"{ticker}.KS"
        rows = yahoo_chart(symbol, f"foreign_component_{market}_{ticker}", rng="2y")
        if not rows:
            failed += 1
            continue
        record = {
            "code": code,
            "kind": "foreign",
            "symbol": symbol,
            "price": rows,
            "dividends": [],
            "adjustments": [],
            "retail_flow": [],
            "eps": [],
            "revenue": [],
            "pe": [],
        }
        with open(os.path.join(STOCKS_DIR, f"{code}.json"), "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False)
        refreshed += 1
    log(f"海外 ETF 成分股價格：更新 {refreshed} 檔、失敗 {failed} 檔")
    return refreshed, failed


def fetch_twse_taiex_recent(base_rows):
    """用證交所盤中資料補 Yahoo 尚未提供的最近幾個交易日。"""
    rows_by_date = {row["t"]: row for row in base_rows}

    # Yahoo 的大盤指數 OHLC 會正常回傳，但成交量常常是 0。
    # 改用證交所 FMTQIK 的每日成交股數補上最近資料，避免量柱被前端濾掉。
    volume_by_date = {}
    amount_by_date = {}
    volume_data = http_get_json(
        "https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK",
        {"response": "json", "date": datetime.today().strftime("%Y%m%d")},
        cache_key="macro_taiex_volume",
        max_age_hours=24,
    ) or {}
    for item in volume_data.get("data") or []:
        try:
            raw_date = str(item[0]).replace("/", "")
            if len(raw_date) != 7:
                continue
            date_text = f"{int(raw_date[:3]) + 1911:04d}-{raw_date[3:5]}-{raw_date[5:7]}"
            volume_by_date[date_text] = float(str(item[1]).replace(",", ""))
            amount_by_date[date_text] = float(str(item[2]).replace(",", ""))
        except (IndexError, TypeError, ValueError):
            continue

    for date_text, volume in volume_by_date.items():
        if date_text in rows_by_date:
            rows_by_date[date_text]["v"] = volume
            rows_by_date[date_text]["a"] = amount_by_date.get(date_text, 0)

    today = datetime.today()
    for offset in range(10):
        date = (today - timedelta(days=offset)).strftime("%Y%m%d")
        date_text = date[:4] + "-" + date[4:6] + "-" + date[6:]
        data = http_get_json(
            "https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_INDEX",
            {"response": "json", "date": date},
            cache_key=f"macro_taiex_twse_{date}",
            max_age_hours=24,
        ) or {}
        points = []
        for item in data.get("data") or []:
            try:
                points.append(float(str(item[1]).replace(",", "")))
            except (IndexError, TypeError, ValueError):
                continue
        if not points:
            continue
        rows_by_date[date_text] = {
            "t": date_text,
            "o": round(points[0], 4),
            "h": round(max(points), 4),
            "l": round(min(points), 4),
            "c": round(points[-1], 4),
            "v": volume_by_date.get(date_text, 0),
            "a": amount_by_date.get(date_text, 0),
        }
    return sorted(rows_by_date.values(), key=lambda row: row["t"])


def existing_market_flow():
    """讀取既有 macro 的全市場法人歷史，讓官方資料只取代最新交易日。"""
    keys = ("foreign_net", "trust_net", "dealer_net", "institutional_net", "retail_net")
    try:
        with open(os.path.join(DATA_DIR, "macro.json"), encoding="utf-8") as f:
            macro = json.load(f)
        out = []
        for key in keys:
            rows = [row for row in (macro.get(key) or []) if row.get("t")]
            if not rows:
                return None
            out.append({row["t"]: row.get("c") for row in rows})
        return out
    except (OSError, ValueError, TypeError):
        return None


def official_market_flow_series(official):
    values = (
        official["foreign"], official["trust"], official["dealer"],
        official["total"], -official["total"],
    )
    return [{"t": official["date"], "c": round(value / 1e8, 2)} for value in values]


def fetch_market_flow():
    """全市場三大法人「外資/投信/自營商」個別買賣超、三大法人合計、與反推「散戶買賣超」，單位:億元。"""
    official = OFFICIAL_MARKET_INSTITUTIONAL
    if official:
        existing = existing_market_flow()
        if existing and all(len(series) > 1 for series in existing):
            latest = official_market_flow_series(official)
            for series, point in zip(existing, latest):
                series[point["t"]] = point["c"]
            return [
                [{"t": date, "c": value} for date, value in sorted(series.items())]
                for series in existing
            ]

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
    if official:
        latest = official_market_flow_series(official)
        out = (foreign_out, trust_out, dealer_out, institutional_out, retail_out)
        for series, point in zip(out, latest):
            series[:] = [row for row in series if row["t"] != point["t"]] + [point]
            series.sort(key=lambda row: row["t"])
    return foreign_out, trust_out, dealer_out, institutional_out, retail_out


def fetch_futures_flow():
    """全市場台指期(TX)「外資」、「投信」每日淨未平倉部位(口) = 多單-空單。
    負值代表淨空單(偏空)，正值代表淨多單(偏多)。"""
    official = OFFICIAL_FUTURES_FLOW
    if official:
        try:
            with open(os.path.join(DATA_DIR, "macro.json"), encoding="utf-8") as f:
                macro = json.load(f)
            foreign_out = [row for row in (macro.get("foreign_futures_net") or []) if row.get("t")]
            trust_out = [row for row in (macro.get("trust_futures_net") or []) if row.get("t")]
        except (OSError, ValueError, TypeError):
            foreign_out, trust_out = [], []
        if len(foreign_out) > 1 and len(trust_out) > 1:
            foreign_out = [row for row in foreign_out if row["t"] != official["date"]]
            trust_out = [row for row in trust_out if row["t"] != official["date"]]
            foreign_out.append({"t": official["date"], "c": official["foreign"]})
            trust_out.append({"t": official["date"], "c": official["trust"]})
            foreign_out.sort(key=lambda row: row["t"])
            trust_out.sort(key=lambda row: row["t"])
            return foreign_out, trust_out

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
    if official:
        foreign_out = [row for row in foreign_out if row["t"] != official["date"]]
        trust_out = [row for row in trust_out if row["t"] != official["date"]]
        foreign_out.append({"t": official["date"], "c": official["foreign"]})
        trust_out.append({"t": official["date"], "c": official["trust"]})
        foreign_out.sort(key=lambda row: row["t"])
        trust_out.sort(key=lambda row: row["t"])
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
    amounts = {}
    for row in volume_data:
        raw_date = str(row.get("Date") or "")
        if len(raw_date) == 7 and raw_date.isdigit():
            date = f"{int(raw_date[:3]) + 1911:04d}-{raw_date[3:5]}-{raw_date[5:]}"
            volumes[date] = float(row.get("TradeVolume") or 0)
            amounts[date] = float(row.get("TradeAmount") or 0)

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
                "a": amounts.get(date, 0),
            })
            seen.add(date)
        except (TypeError, ValueError):
            continue
    return sorted(out, key=lambda row: row["t"])


def fetch_vietnam_index():
    """抓取越南 VN-Index 近一年日線資料；Yahoo 的 VNINDEX 目前只回傳最新一筆。"""
    today = datetime.today()
    data = http_get_json(
        "https://kbbuddywts.kbsec.com.vn/iis-server/investment/index/VNINDEX/data_day",
        {
            "sdate": (today - timedelta(days=365)).strftime("%d-%m-%Y"),
            "edate": today.strftime("%d-%m-%Y"),
        },
        cache_key="macro_vietnam_index",
        max_age_hours=12,
    ) or {}
    rows_by_date = {}
    for item in data.get("data_day") or []:
        try:
            date_text = str(item["t"])[:10]
            rows_by_date[date_text] = {
                "t": date_text,
                "o": float(item["o"]),
                "h": float(item["h"]),
                "l": float(item["l"]),
                "c": float(item["c"]),
                "v": float(item.get("v") or 0),
            }
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(rows_by_date.values(), key=lambda row: row["t"])


def build_macro():
    foreign_net, trust_net, dealer_net, institutional_net, retail_net = fetch_market_flow()
    foreign_futures_net, trust_futures_net = fetch_futures_flow()
    macro = {
        "gold": yahoo_chart("GC=F", "macro_gold"),
        "oil_wti": yahoo_chart("CL=F", "macro_oil"),
        "us10y_yield": yahoo_chart("^TNX", "macro_us10y"),
        "taiex": fetch_twse_taiex_recent(yahoo_chart("^TWII", "macro_taiex")),
        "nikkei225": yahoo_chart("^N225", "macro_nikkei225"),
        "kospi": yahoo_chart("^KS11", "macro_kospi"),
        "philadelphia_semiconductor": yahoo_chart("^SOX", "macro_philadelphia_semiconductor"),
        "nasdaq": yahoo_chart("^IXIC", "macro_nasdaq"),
        "vietnam": fetch_vietnam_index(),
        "sp500": yahoo_chart("^GSPC", "macro_sp500"),
        "btc_usd": yahoo_chart("BTC-USD", "macro_btc_usd"),

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
        auth_token=FINMIND_TOKEN, force=FRESH_ONLY,
        max_age_hours=NAMES_FRESH_DAYS * 24,
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
    global FRESH_ONLY
    FRESH_ONLY = "--fresh-only" in sys.argv
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

    total = len(stocks) + len(etfs) + (0 if only else 1)
    done = 0
    status = "complete"

    log(f"開始抓取：{len(stocks)} 檔個股 + {len(etfs)} 檔ETF" + ("（強制使用新資料）" if FRESH_ONLY else " + 總經面板"))
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

    if not only:
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
    holdings_db = fetch_etf_holdings(etfs)
    fetch_foreign_etf_component_prices(holdings_db)

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

    if not only:
        try:
            fetch_active_etf_changes()
        except Exception as e:
            log(f"  !! 主動式 ETF 異動更新失敗：{e}")
        try:
            build_foreign_flow()
        except Exception as e:
            log(f"  !! 外資排行更新失敗：{e}")
        try:
            build_dividend_etf_flow()
        except Exception as e:
            log(f"  !! 指定 ETF 法人買賣更新失敗：{e}")

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

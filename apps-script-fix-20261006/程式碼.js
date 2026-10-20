/**
 * ================================================================
 * 重要：修改／部署前必讀（防止「改 A 壞 B」）
 * ================================================================
 *
 * 這個檔案同時服務多個工作表與多種自訂函式。請只修改本次需求涉及的
 * 最小區塊，不可拿舊檔、局部備份或其他對話產生的版本整檔覆蓋。
 *
 * 資產紀錄保護原則：
 *   - 與資產紀錄無關的修改，不得改動 UPDATE_ASSET_CHANGE_LOG_WITH_ALERT、
 *     UPDATE_ASSET_CHANGE_LOG、findColumnByHeader_、findRowByLabelInColA_，
 *     也不得改變它們讀取的工作表、列欄定位或寫入欄位。
 *   - 若需求確實需要修改上述函式或「資產紀錄」分頁，必須先通知使用者，
 *     說明影響範圍並取得確認後才能修改與部署。
 *   - 任何修改都要依序執行：先 clasp pull，再局部修改、檢查，最後 clasp push。
 *
 * 變更紀錄：
 *   - 2026-08-27：資產紀錄新增列的 E 欄損益固定使用黑色字體；
 *     只影響新寫入的 E 欄，不改動既有紀錄。
 *
 * 下列關鍵功能曾因整檔覆蓋而被意外移除，任何修改都必須保留：
 *   1. GET_TW_OTC_ETF_INFO
 *      - 「個股分析」EL／EM 欄的 00725B、00937B，以及 N 欄費半歷史
 *        指標（Yahoo 代碼 ^SOX）依賴此函式。
 *   2. GET_TAIEX_FUTURES_INFO
 *      - 台指期即時資料依賴此函式。
 *   3. GET_OTC_INFO、GET_GOLD_INFO、GET_SILVER_INFO、GET_BRENT_INFO
 *      - 各市場資料、快取與歷史價格計算不可互相覆蓋。
 *   4. isTaiwanMarketHours_、isTaiexFuturesMarketHours_、
 *      UPDATE_MARKET_REFRESH_TOKEN、SETUP_MARKET_REFRESH_TRIGGER
 *      - 台股與台指期交易時段不同，更新閘門不可合併或刪除。
 *   5. appsscript.json 的 external_request、spreadsheets、scriptapp 權限。
 *
 * 部署前最低檢查：
 *   - 先看 git diff，確認沒有與需求無關的大量刪除或整檔改寫。
 *   - 執行語法檢查，並確認上述函式名稱仍全部存在。
 *   - 不要直接在目前工作目錄執行 clasp pull；若需比對雲端版本，
 *     請拉到暫存目錄後逐段比較，避免較舊的雲端內容覆蓋完整本地版。
 *   - clasp push 後實際驗證本次修改及上述關鍵工作表欄位。
 *   - clasp push 後一律執行 `clasp run RUN_SELF_TESTS`，確認回歸測試全部通過
 *     再視為修改完成；有任何一項失敗都要先排除才能結束這次修改。
 *   - 這一步已用 .githooks/pre-commit 強制：只要 commit 有動到
 *     my-apps-script/，hook 會自動 clasp push 目前版本並執行
 *     RUN_SELF_TESTS，任何一項失敗都會直接擋下 commit（需先執行一次
 *     `git config core.hooksPath .githooks` 才會生效）。
 *
 * 事故紀錄：2026-08-21、2026-08-25 曾發生舊版覆蓋，造成
 * GET_TW_OTC_ETF_INFO／GET_TAIEX_FUTURES_INFO 遺失。
 * ================================================================
 */

/**
 * 取得台灣上櫃（TPEx）ETF／債券ETF的現價、均線與90日最高價。
 * 00725B（國泰投資級公司債）、00937B（群益ESG投等債20+）這類上櫃債券ETF
 * GOOGLEFINANCE 完全查不到資料（試過 TPE:/TPEX: 前綴與純代碼皆為 #N/A），
 * 改走 Yahoo Finance（.TWO 後綴），與 get_stock_price／GET_TW_OTC_PRICE
 * 對上櫃個股的處理方式一致。
 * 用法：=GET_TW_OTC_ETF_INFO("00725B","現價")
 * 不帶 item 會回傳全部指標。
 *
 * @param {string} code 上櫃代碼（可加或不加 .TWO），或 ^SOX 等 Yahoo 指數代碼
 * @param {string} item 要查詢的指標
 * @param {*} refresh 可傳入 $ZZ$1 等會定時變動的儲存格，讓函式跟著重新計算
 * @customfunction
 */
function GET_TW_OTC_ETF_INFO(code, item, refresh) {
  try {
    var symbol = String(code).trim();
    // ^SOX 等 Yahoo 指數代碼必須保留 ^ 前綴；一般上櫃代碼才補 .TWO。
    if (symbol.charAt(0) !== "^" && !/\.TWO$/i.test(symbol)) symbol += ".TWO";

    var cache = CacheService.getScriptCache();
    var cacheKey = "TW_OTC_ETF_INFO_V1_" + symbol;
    var cached = cache.get(cacheKey);
    var metrics;

    if (cached) {
      metrics = JSON.parse(cached);
    } else {
      var url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
                encodeURIComponent(symbol) + "?interval=1d&range=2y&_=" + Date.now();
      var response = UrlFetchApp.fetch(url, {
        method: "get",
        headers: {"Accept": "application/json", "User-Agent": "Mozilla/5.0"},
        muteHttpExceptions: true
      });

      var statusCode = response.getResponseCode();
      if (statusCode !== 200) {
        return symbol + " 資料來源回應錯誤 (HTTP " + statusCode + ")";
      }

      var payload = JSON.parse(response.getContentText());
      if (!payload.chart || payload.chart.error ||
          !payload.chart.result || payload.chart.result.length === 0) {
        var message = payload.chart && payload.chart.error
          ? payload.chart.error.description
          : "找不到資料";
        return "無法取得 " + symbol + " 資料: " + message;
      }

      var result = payload.chart.result[0];
      var meta = result.meta || {};
      var timestamps = result.timestamp || [];
      var quote = result.indicators && result.indicators.quote
        ? result.indicators.quote[0]
        : null;

      if (!quote || !Array.isArray(quote.close) || !Array.isArray(quote.high)) {
        return "無法取得 " + symbol + " 每日價格";
      }

      var prices = [];
      for (var i = 0; i < quote.close.length; i++) {
        var close = Number(quote.close[i]);
        var high = Number(quote.high[i]);
        var low = quote.low ? Number(quote.low[i]) : NaN;
        if (quote.close[i] !== null && quote.high[i] !== null &&
            !isNaN(close) && !isNaN(high) && close > 0 && high > 0) {
          prices.push({
            timestamp: timestamps[i] || 0,
            close: close,
            high: high,
            low: (!isNaN(low) && low > 0 && low <= high) ? low : high
          });
        }
      }

      if (prices.length < 240) {
        return symbol + " 歷史交易日資料不足，目前只有 " + prices.length + " 筆";
      }

      function movingAverage(days) {
        var sum = 0;
        for (var i = prices.length - days; i < prices.length; i++) {
          sum += prices[i].close;
        }
        return sum / days;
      }

      function highestHigh(days) {
        var highest = -Infinity;
        for (var i = prices.length - days; i < prices.length; i++) {
          if (prices[i].high > highest) highest = prices[i].high;
        }
        return highest;
      }

      function lowestLow(days) {
        var lowest = Infinity;
        for (var i = prices.length - days; i < prices.length; i++) {
          if (prices[i].low < lowest) lowest = prices[i].low;
        }
        return lowest;
      }

      function round2(value) {
        return Number(Number(value).toFixed(2));
      }

      var latest = prices[prices.length - 1];
      var currentPrice = Number(meta.regularMarketPrice);
      if (isNaN(currentPrice) || currentPrice <= 0) currentPrice = latest.close;

      // 注意：Yahoo 的 meta.previousClose／chartPreviousClose 在 range=2y 時
      // 並非「昨日收盤」，而是整個 2 年區間起點前一筆的收盤價（差了將近 2 年），
      // 之前用它算漲跌導致離譜的錯誤數字。一律改用每日序列本身倒數第二筆
      // （即上一個完整交易日的收盤價）才可靠。
      var previousPrice = prices[prices.length - 2].close;

      var dataTimestamp = Number(meta.regularMarketTime);
      if (isNaN(dataTimestamp) || dataTimestamp <= 0) {
        dataTimestamp = latest.timestamp;
      }

      metrics = {
        dataDate: Utilities.formatDate(
          new Date(dataTimestamp * 1000), "Asia/Taipei", "yyyy/MM/dd"
        ),
        current: round2(currentPrice),
        previous: round2(previousPrice),
        change: round2(currentPrice - previousPrice),
        changePercent: previousPrice ? round2((currentPrice - previousPrice) / previousPrice * 100) : null,
        ma5: round2(movingAverage(5)),
        ma10: round2(movingAverage(10)),
        ma20: round2(movingAverage(20)),
        ma60: round2(movingAverage(60)),
        ma120: round2(movingAverage(120)),
        ma240: round2(movingAverage(240)),
        high90: round2(highestHigh(90)),
        high10: round2(highestHigh(10)),
        low10: round2(lowestLow(10))
      };

      cache.put(cacheKey, JSON.stringify(metrics), 60);
    }

    console.log(symbol + "_METRICS: " + JSON.stringify(metrics));

    var aliases = {
      "資料日期": "dataDate",
      "日期": "dataDate",
      "現價": "current",
      "最新價": "current",
      "漲跌": "change",
      "漲跌點數": "change",
      "漲跌幅": "changePercent",
      "漲跌%": "changePercent",
      "昨日價格": "previous",
      "昨收": "previous",
      "昨日收盤價": "previous",
      "5日均線": "ma5",
      "5MA": "ma5",
      "MA5": "ma5",
      "10日均線": "ma10",
      "10MA": "ma10",
      "MA10": "ma10",
      "月均線": "ma20",
      "20日均線": "ma20",
      "20MA": "ma20",
      "MA20": "ma20",
      "季均線": "ma60",
      "60日均線": "ma60",
      "60MA": "ma60",
      "MA60": "ma60",
      "半年線": "ma120",
      "120日均線": "ma120",
      "120MA": "ma120",
      "MA120": "ma120",
      "年線": "ma240",
      "240日均線": "ma240",
      "240MA": "ma240",
      "MA240": "ma240",
      "90日最高價": "high90",
      "90日間最高價": "high90",
      "90DAYHIGH": "high90",
      "前10日最高價": "high10",
      "10日最高價": "high10",
      "前10日最低價": "low10",
      "10日最低價": "low10"
    };

    if (item !== undefined && item !== null && String(item).trim() !== "") {
      var normalized = String(item).trim().toUpperCase().replace(/\s+/g, "");
      var metricKey = aliases[normalized];
      if (!metricKey) {
        return "不支援的指標: " + item;
      }
      return metrics[metricKey];
    }

    return [
      ["項目", "數值"],
      ["資料日期", metrics.dataDate],
      ["現價", metrics.current],
      ["漲跌", metrics.change],
      ["漲跌幅(%)", metrics.changePercent],
      ["昨日價格", metrics.previous],
      ["5日均線", metrics.ma5],
      ["10日均線", metrics.ma10],
      ["月均線(20日)", metrics.ma20],
      ["季均線(60日)", metrics.ma60],
      ["半年線(120日)", metrics.ma120],
      ["年線(240日)", metrics.ma240],
      ["90日最高價", metrics.high90],
      ["前10日最高價", metrics.high10],
      ["前10日最低價", metrics.low10]
    ];
  } catch (error) {
    console.log(error);
    return "發生錯誤: " + error.toString();
  }
}

/**
 * 開啟試算表時自動加一個選單，可以直接點選執行每日資產記錄更新，
 * 不需要開 Apps Script 編輯器或用 clasp 指令。
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("資產記錄")
    .addItem("執行今日更新", "UPDATE_ASSET_CHANGE_LOG_WITH_ALERT")
    .addToUi();
}

/**
 * 給選單用的包裝函式：執行完後跳出提示視窗顯示結果，
 * 手動從選單點擊時才看得到有沒有成功、寫入的是哪一列。
 */
function UPDATE_ASSET_CHANGE_LOG_WITH_ALERT() {
  var result = UPDATE_ASSET_CHANGE_LOG();
  SpreadsheetApp.getUi().alert(result);
}

/**
 * 讀取「2025」持股總結列（成本/市值/股數/盈虧）與「殖利率黃金日圓重要指標」
 * 即時匯率／指數／訊連股價，在「資產變化」分頁最後一列之後新增一列今天的資產記錄。
 * 每天執行一次即可（手動執行或設定時間驅動觸發條件皆可）。
 */
function findColumnByHeader_(headerRow, name) {
  for (var i = 0; i < headerRow.length; i++) {
    if (String(headerRow[i]).indexOf(name) !== -1) return i + 1; // 1-based
  }
  throw new Error("找不到標題包含「" + name + "」的欄位");
}

/**
 * 依 A 欄文字內容找列號，取代寫死列號（例如「總結」「訊連」）。
 * 「2025」分頁常因新增／刪除持股列而整體上下移動，寫死列號會抓錯資料。
 * 先採用完整相等比對；若工作表在標籤前後加了說明文字，才退回包含比對。
 * 「訊連」不可誤抓到「無訊連」。
 */
function findRowByLabelInColA_(sheet, label, maxRow) {
  var wanted = String(label).trim();
  var values = sheet.getRange(1, 1, maxRow, 1).getDisplayValues();
  var fallbackRow = 0;

  for (var i = 0; i < values.length; i++) {
    var cellText = String(values[i][0]).trim();
    if (cellText === wanted) return i + 1;
    if (fallbackRow === 0 && cellText.indexOf(wanted) !== -1 &&
        !(wanted === "訊連" && cellText.indexOf("無訊連") !== -1)) {
      fallbackRow = i + 1;
    }
  }

  if (fallbackRow > 0) return fallbackRow;
  throw new Error("找不到 A 欄包含「" + wanted + "」的列");
}

function UPDATE_ASSET_CHANGE_LOG() {
  var spreadsheet = SpreadsheetApp.openById("1WQNCHJfK5CXluCeWsSee64NczdG6DapcbBkI7C8OuFI");
  var sheetAsset = spreadsheet.getSheetById(598885406);
  var sheet2025 = spreadsheet.getSheetByName("2025");
  var indicators = spreadsheet.getSheetByName("殖利率黃金日圓重要指標");

  var lastRow = sheetAsset.getLastRow();
  var newRow = lastRow + 1;

  // 「2025」欄位順序可能會調整，改成依標題文字動態找欄位，不寫死欄位字母。
  // 持股列數也會因新增／刪除持股而增減，依 A 欄標籤找列號，不寫死列號。
  var lastRow2025 = sheet2025.getLastRow();
  var totalRowNum = findRowByLabelInColA_(sheet2025, "總結", lastRow2025);
  var xunlianRowNum = findRowByLabelInColA_(sheet2025, "訊連", lastRow2025);

  var header2025 = sheet2025.getRange(1, 1, 1, sheet2025.getLastColumn()).getValues()[0];
  var costCol = findColumnByHeader_(header2025, "成本總額");
  var mktvalCol = findColumnByHeader_(header2025, "市值");
  var sharesCol = findColumnByHeader_(header2025, "股數");
  var pnlCol = findColumnByHeader_(header2025, "預估損益"); // 手動維護的估計值，跟券商顯示的損益較接近，不是 O-N 現算
  var curPriceCol = findColumnByHeader_(header2025, "現價");

  var cost = sheet2025.getRange(totalRowNum, costCol).getValue();
  var mktval = sheet2025.getRange(totalRowNum, mktvalCol).getValue();
  var shares = sheet2025.getRange(totalRowNum, sharesCol).getValue();
  var pnl = sheet2025.getRange(totalRowNum, pnlCol).getValue();

  var xunlianPrice = sheet2025.getRange(xunlianRowNum, curPriceCol).getValue();
  var taiex = indicators.getRange("U2").getValue();
  var twd = indicators.getRange("B2").getValue();
  var jpy = indicators.getRange("C2").getValue();
  var usdIndex = indicators.getRange("D2").getValue();
  var us10y = indicators.getRange("E2").getValue();

  function round1(v){ return Math.round(Number(v) * 10) / 10; }
  function round2(v){ return Math.round(Number(v) * 100) / 100; }

  var note = "訊連" + round1(xunlianPrice) + " 大盤" + Math.round(taiex) +
    "，台幣/日圓/美元10年殖利率 " + round2(twd) + "/" + round2(jpy) + "/" + round2(usdIndex) + "/" + round2(us10y);

  sheetAsset.getRange(newRow, 1).setValue(new Date());
  sheetAsset.getRange(newRow, 2).setValue(mktval);
  sheetAsset.getRange(newRow, 3).setFormula("=B" + newRow + "-B" + (newRow - 1));
  sheetAsset.getRange(newRow, 4).setValue(shares);
  // 新增損益固定使用黑字，避免沿用資產紀錄的紅字格式。
  sheetAsset.getRange(newRow, 5).setValue(pnl).setFontColor("#000000");
  sheetAsset.getRange(newRow, 6).setFormula("=E" + newRow + "-E" + (newRow - 1));
  sheetAsset.getRange(newRow, 7).setValue(cost);
  sheetAsset.getRange(newRow, 8).setFormula("=E" + newRow + "/G" + newRow);
  sheetAsset.getRange(newRow, 9).setFormula("=G" + newRow + "-G" + (newRow - 1));
  sheetAsset.getRange(newRow, 10).setValue(note);

  SpreadsheetApp.flush();
  return "已寫入第 " + newRow + " 列：" + note;
}

/**
 * 取得東京證交所（TSE）股票現價，供 GOOGLEFINANCE 不支援日股代碼時使用。
 * 用法：=GET_JP_STOCK_PRICE("6976")　（太陽誘電）
 *
 * @param {string} code 東證代碼（4碼數字，可加或不加 .T）
 * @customfunction
 */
function GET_JP_STOCK_PRICE(code) {
  var symbol = String(code).trim();
  if (!/\.T$/i.test(symbol)) symbol += ".T";
  var result = getYahooLiveQuote_(symbol);
  return result.quote ? result.quote.price : "價格擷取失敗: " + result.error;
}

/**
 * 取得台灣上櫃（TPEx）股票現價，供 GOOGLEFINANCE 對該代碼常抓不到資料時使用。
 * 用法：=GET_TW_OTC_PRICE("6274")　（台耀）
 *
 * @param {string} code 股票代碼（可加或不加 .TWO）
 * @customfunction
 */
function GET_TW_OTC_PRICE(code) {
  var symbol = String(code).trim();
  if (!/\.TWO$/i.test(symbol)) symbol += ".TWO";
  var result = getYahooLiveQuote_(symbol);
  return result.quote ? result.quote.price : "價格擷取失敗: " + result.error;
}

/**
 * 以 Yahoo Finance 日線資料計算漲跌幅，避免 1 分鐘 chart 端點頻繁回傳 429。
 * 只取最近 10 天，資料量小且足以取得最近兩個交易日收盤價。
 */
function getYahooDailyChangePct_(symbol) {
  var hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];
  for (var hostIndex = 0; hostIndex < hosts.length; hostIndex++) {
    try {
      var url = "https://" + hosts[hostIndex] +
        "/v8/finance/chart/" + encodeURIComponent(symbol) +
        "?interval=1d&range=10d&_=" + Date.now();
      var response = UrlFetchApp.fetch(url, {
        method: "get",
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        muteHttpExceptions: true
      });
      if (response.getResponseCode() !== 200) continue;

      var payload = JSON.parse(response.getContentText());
      var result = payload.chart && payload.chart.result
        ? payload.chart.result[0]
        : null;
      var quote = result && result.indicators && result.indicators.quote
        ? result.indicators.quote[0]
        : null;
      if (!quote || !Array.isArray(quote.close)) continue;

      var closes = [];
      for (var i = 0; i < quote.close.length; i++) {
        var close = Number(quote.close[i]);
        if (quote.close[i] !== null && !isNaN(close) && isFinite(close) && close > 0) {
          closes.push(close);
        }
      }
      if (closes.length < 2) continue;

      var current = closes[closes.length - 1];
      var previous = closes[closes.length - 2];
      return (current - previous) / previous;
    } catch (error) {
      console.log("YAHOO_DAILY_CHANGE_ERROR: " + error.toString());
    }
  }
  return null;
}

/**
 * 計算台灣上櫃（TPEx）股票現價與前一日收盤價的漲跌百分比。
 * 只使用 Yahoo 低頻日線資料；失敗時優先回傳最近一次成功值，
 * 避免 1 分鐘端點的 HTTP 429 與長時間載入。refresh 參數僅用來接收 $ZZ$1 刷新依賴。
 * 用法：=GET_TW_OTC_CHANGE_PCT("00679B",$ZZ$1)
 *
 * @param {string} code 股票代碼（可加或不加 .TWO）
 * @param {*} refresh 可傳入 $ZZ$1 等會定時變動的儲存格
 * @customfunction
 */
function GET_TW_OTC_CHANGE_PCT(code, refresh) {
  var symbol = String(code).trim();
  var codeText = symbol.replace(/\.TWO$/i, "").replace(/\.TW$/i, "");
  var cache = CacheService.getScriptCache();
  var cacheKey = "TW_OTC_CHANGE_PCT_V2_" + codeText.replace(/[^A-Z0-9]/g, "_");
  var staleKey = cacheKey + "_STALE";
  var cached = cache.get(cacheKey);
  if (cached !== null && cached !== "") return Number(cached);

  var yahooSymbol = /\.TWO$/i.test(symbol) ? symbol : symbol + ".TWO";
  var dailyChange = getYahooDailyChangePct_(yahooSymbol);
  if (dailyChange !== null) {
    cache.put(cacheKey, String(dailyChange), 60);
    cache.put(staleKey, String(dailyChange), 21600);
    return dailyChange;
  }

  var stale = cache.get(staleKey);
  if (stale !== null && stale !== "") return Number(stale);
  return "暫無資料: Yahoo 日線無法取得 (" + yahooSymbol + ")";
}

/**
 * 從 histock.tw 抓取股票當日漲跌百分比，供 Yahoo Finance／GOOGLEFINANCE 都查不到資料的個股使用
 * （例如 6806 森崴能源，這類股票在 Yahoo／TWSE 官方 API 上沒有資料）。
 * 用法：=GET_HISTOCK_CHANGE_PCT("6806")
 *
 * @param {string} code 股票代碼
 * @customfunction
 */
function GET_HISTOCK_CHANGE_PCT(code) {
  try {
    var url = "https://histock.tw/stock/" + encodeURIComponent(String(code).trim());
    var response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: {"User-Agent":"Mozilla/5.0"},
      muteHttpExceptions: true
    });
    var responseCode = response.getResponseCode();
    if (responseCode !== 200) return "暫無資料: HTTP " + responseCode;
    var match = response.getContentText().match(/id="Price1_lbTPercent"[^>]*>[\s\S]*?>([+\-]?[\d.]+)%/);
    if (!match) return "暫無資料: 頁面格式改變或查無代碼 " + code;
    return Number(match[1]) / 100;
  } catch (e) {
    return "暫無資料: " + e.toString();
  }
}

function test_get_stock_price(){
  var result = get_stock_price("00719B","z","otc");
  Logger.log(result);
  var result = get_stock_price("3293","z","otc");
  Logger.log(result);
}

function getGoldPrice() {
  var quote = getFutunnGoldSpotQuote_();
  return quote ? quote.price : "價格擷取失敗";
}



function IMPORTJSON(url, query, headers){
  try{
    var response = UrlFetchApp.fetch(url);
    var content = response.getContentText();
    var json = JSON.parse(content);

    var data = json;
    query = query || "";
    if (query !== ""){
      var queries = query.split(".");
      for (var i = 0; i < queries.length; i++){
        data = data[queries[i]];
      }
    }

    if (headers){
      var header = [];
      for (var key in data[0]){
        header.push(key);
      }
      var rows = [header];
      for (var j = 0; j < data.length; j++){
        var row = [];
        for (var k in data[j]){
          row.push(data[j][k]);
        }
        rows.push(row);
      }
      return rows;
    } else {
      return data;
    }
  } catch(e){
    return "ERROR: " + e;
  }
}


function get_stock_price(code,gettype,ot,refresh) {
  if (ot == "") { ot = "tse"; }

  // 現價改走 Yahoo Finance（比 TWSE 即時 API 穩定，且能容忍 ot 標錯市場）：
  // 先試 ot 對應的後綴，失敗再試另一個市場的後綴當自動修正，
  // 兩邊都失敗才退回下方原本的 TWSE 抓法當備援。
  var yahooErrors = [];
  if (gettype == "z") {
    var symbol = String(code).trim();
    var primarySuffix = (ot == "otc") ? ".TWO" : ".TW";
    var altSuffix = (ot == "otc") ? ".TW" : ".TWO";
    var primaryResult = getYahooLiveQuote_(symbol + primarySuffix);
    if (primaryResult.quote && primaryResult.quote.price > 0) return primaryResult.quote.price;
    yahooErrors.push(primaryResult.error);

    var altResult = getYahooLiveQuote_(symbol + altSuffix);
    if (altResult.quote && altResult.quote.price > 0) return altResult.quote.price;
    yahooErrors.push(altResult.error);
  }

  try {
    var headers = {"User-Agent":"Mozilla/5.0"};
   //var headers = {
    //  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36",
    //  "Accept": "application/json, text/javascript, */*; q=0.01", // 告訴伺服器你接受 JSON
    // "Accept-Language": "zh-TW,en;q=0.9",
    //  "Referer": "https://mis.twse.com.tw/", // 假裝是從 TWSE 網站內部發出的請求
    //  "X-Requested-With": "XMLHttpRequest" // 模擬 AJAX 請求
    //  };
    var options = {"method":"get","headers":headers,"timeout":50000};
    var date = new Date();
    var year = date.getYear()+1900;
    var month = date.getMonth()+1; if(month.toString().length==1){ month='0'+month; }
    var day = date.getDate(); if(day.toString().length==1){ day='0'+day; }
    var hour = date.getHours(); if(hour.toString().length==1){ hour='0'+hour; }
    var minu = date.getMinutes(); if(minu.toString().length==1){ minu='0'+minu; }
    var seco = date.getSeconds(); if(seco.toString().length==1){ seco='0'+seco; }
    var datestr = year+month+day+hour+minu+seco;
   // var url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" + ot + "_" + code + ".tw&json=1&delay=0&_= " + datestr;
    var url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" + ot + "_" + code + ".tw&json=1&delay=0"
    //return url;
    var response = UrlFetchApp.fetch(url, options);
    var data = JSON.parse(response.getContentText());
        // 在 catch(e) 之前，加入一行來返回完整內容 (暫時修改)        
    //return data; // 返回原始回應內容，看 TWSE 給了什麼
// ... 刪除後續的 JSON 解析和判斷邏輯

    if (gettype == "z") {
      if (data.msgArray[0].z == "-") {
        var buy_5 = data.msgArray[0].b.split("_");
        if (buy_5[0] == "-") {
          var sell_5 = data.msgArray[0].a.split("_");
          if (parseFloat(sell_5[0]) == 0) {
            return parseFloat(sell_5[1]);
          } else {
            return parseFloat(sell_5[0]);
          }
        } else if (parseFloat(buy_5[0]) == 0) {
          return parseFloat(buy_5[1]);
        } else {
          return parseFloat(buy_5[0]);
        }
      } else {
        return parseFloat(data.msgArray[0].z);
      }
    } else if (gettype == "n") {
      return data.msgArray[0].n;
    } else if (gettype == "y") {
      return parseFloat(data.msgArray[0].y);
    } else {
      return "";
    }
  } catch(e) {
    if (yahooErrors.length) {
      return "價格擷取失敗 (Yahoo: " + yahooErrors.join("; ") + "; TWSE: " + e.toString() + ")";
    }
    return e.toString();
  }
}


/**
 * 取得櫃買指數現價、均線與90日最高價。
 *
 * 個別查詢範例：
 * =GET_OTC_INFO("現價")
 * =GET_OTC_INFO("昨日價格")
 * =GET_OTC_INFO("5日均線")
 * =GET_OTC_INFO("10日均線")
 * =GET_OTC_INFO("月均線")
 * =GET_OTC_INFO("季均線")
 * =GET_OTC_INFO("半年線")
 * =GET_OTC_INFO("年線")
 * =GET_OTC_INFO("90日最高價")
 *
 * 不帶參數會回傳全部指標：
 * =GET_OTC_INFO()
 *
 * 月、季、半年、年線分別採 20、60、120、240 個交易日。
 * 「現價」為櫃買中心最新公布的收市指數。
 *
 * @param {string} item 要查詢的指標
 * @return {number|string|Array<Array<number|string>>}
 * @customfunction
 */
/**
 * 回傳 { quote, error }：成功時 quote 為報價物件、error 為 null；
 * 失敗時 quote 為 null、error 是可以直接顯示在儲存格上的失敗原因，
 * 方便呼叫端組出比「價格擷取失敗」更有用的錯誤訊息。
 */
function getYahooLiveQuote_(symbol) {
  try {
    var url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
              encodeURIComponent(symbol) +
              "?interval=1m&range=1d";
    var response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      },
      muteHttpExceptions: true
    });
    var responseCode = response.getResponseCode();
    if (responseCode !== 200) {
      return { quote: null, error: "HTTP " + responseCode + " (" + symbol + ")" };
    }

    var payload = JSON.parse(response.getContentText());
    if (payload.chart && payload.chart.error) {
      return {
        quote: null,
        error: (payload.chart.error.description || payload.chart.error.code || "查無資料") +
               " (" + symbol + ")"
      };
    }

    var result = payload.chart && payload.chart.result
      ? payload.chart.result[0]
      : null;
    if (!result || !result.meta) {
      return { quote: null, error: "回應中無報價資料 (" + symbol + ")" };
    }

    var price = Number(result.meta.regularMarketPrice);
    var marketTime = Number(result.meta.regularMarketTime);
    if (isNaN(price) || price <= 0) {
      return { quote: null, error: "回應中無有效現價 (" + symbol + ")" };
    }

    var ageMs = Date.now() - marketTime * 1000;
    if (isNaN(marketTime) || marketTime <= 0 ||
        ageMs < -86400000 || ageMs > 7 * 86400000) {
      var staleDays = isNaN(marketTime) || marketTime <= 0
        ? "未知"
        : Math.round(ageMs / 86400000);
      var staleError = "資料過期（" + staleDays + " 天前, " + symbol + "）";
      console.log("YAHOO_LIVE_STALE: " + symbol + " / " + marketTime);
      return { quote: null, error: staleError };
    }

    var previousClose = Number(result.meta.previousClose || result.meta.chartPreviousClose);

    return {
      quote: {
        price: price,
        marketTime: !isNaN(marketTime) && marketTime > 0 ? marketTime : null,
        previousClose: !isNaN(previousClose) && previousClose > 0 ? previousClose : null
      },
      error: null
    };
  } catch (error) {
    console.log("YAHOO_LIVE_ERROR: " + error.toString());
    return { quote: null, error: error.toString() };
  }
}


function getTwseOtcLiveQuote_() {
  try {
    var url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp" +
              "?ex_ch=otc_o00.tw&json=1&delay=0&_=" + Date.now();
    var response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: {
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "Referer": "https://mis.twse.com.tw/stock/index.jsp",
        "User-Agent": "Mozilla/5.0"
      },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) return null;

    var payload = JSON.parse(response.getContentText());
    var quote = payload.msgArray && payload.msgArray.length
      ? payload.msgArray[0]
      : null;
    if (!quote) return null;

    var price = Number(quote.z);
    if (isNaN(price) || price <= 0) return null;

    var quoteDate = String(quote.d || "");
    if (!/^\d{8}$/.test(quoteDate)) return null;

    return {
      price: price,
      date: quoteDate.substring(0, 4) + "/" +
            quoteDate.substring(4, 6) + "/" +
            quoteDate.substring(6, 8),
      time: String(quote.t || "")
    };
  } catch (error) {
    console.log("TWSE_OTC_LIVE_ERROR: " + error.toString());
    return null;
  }
}

function GET_OTC_INFO(item, refresh) {
  try {
    var cache = CacheService.getScriptCache();
    var cacheKey = "GET_OTC_INFO_V15";
    var cached = cache.get(cacheKey);
    var metrics;

    if (cached) {
      metrics = JSON.parse(cached);
    } else {
      var timezone = "Asia/Taipei";
      var yearMonth = Utilities.formatDate(new Date(), timezone, "yyyy/MM").split("/");
      var currentYear = Number(yearMonth[0]);
      var currentMonth = Number(yearMonth[1]);
      var requests = [];

      // 抓取最近15個月份，確保扣除休市日後仍有240個交易日。
      for (var offset = 0; offset < 15; offset++) {
        var monthIndex = currentYear * 12 + currentMonth - 1 - offset;
        var year = Math.floor(monthIndex / 12);
        var month = monthIndex % 12 + 1;
        var monthText = month < 10 ? "0" + month : String(month);
        var queryDate = year + "/" + monthText + "/01";

        requests.push({
          url: "https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=" +
               encodeURIComponent(queryDate),
          method: "get",
          headers: {
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0"
          },
          muteHttpExceptions: true
        });
      }

      var responses = [];
      try {
        responses = UrlFetchApp.fetchAll(requests);
      } catch (batchError) {
        console.log("OTC_BATCH_FETCH_ERROR: " + batchError.toString());
        for (var requestIndex = 0; requestIndex < requests.length; requestIndex++) {
          try {
            responses.push(UrlFetchApp.fetch(requests[requestIndex].url, {
              method: "get",
              headers: requests[requestIndex].headers,
              muteHttpExceptions: true
            }));
          } catch (monthError) {
            console.log("OTC_MONTH_FETCH_ERROR: " +
                        requests[requestIndex].url + " / " +
                        monthError.toString());
            responses.push(null);
          }
        }
      }
      var byDate = {};

      function toNumber(value) {
        if (value === null || value === undefined || value === "") return null;
        var number = Number(String(value).replace(/,/g, "").trim());
        return isNaN(number) ? null : number;
      }

      for (var r = 0; r < responses.length; r++) {
        if (!responses[r] || responses[r].getResponseCode() !== 200) continue;

        var payload;
        try {
          payload = JSON.parse(responses[r].getContentText());
        } catch (parseError) {
          continue;
        }

        if (!payload.tables || !payload.tables[0] ||
            !Array.isArray(payload.tables[0].data)) {
          continue;
        }

        var rows = payload.tables[0].data;
        for (var i = 0; i < rows.length; i++) {
          var date = rows[i][0];
          var high = toNumber(rows[i][2]);
          var low = toNumber(rows[i][3]);
          var close = toNumber(rows[i][4]);

          if (date && high !== null && close !== null &&
              high > 0 && close > 0) {
            byDate[date] = {
              date: date,
              high: high,
              low: (low !== null && low > 0 && low <= high) ? low : high,
              close: close
            };
          }
        }
      }

      var prices = Object.keys(byDate).map(function(date) {
        return byDate[date];
      });

      prices.sort(function(a, b) {
        return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
      });

      if (prices.length < 240) {
        return "歷史交易日資料不足，目前只有 " + prices.length + " 筆";
      }

      function movingAverage(days) {
        var sum = 0;
        for (var i = prices.length - days; i < prices.length; i++) {
          sum += prices[i].close;
        }
        return sum / days;
      }

      function highestHigh(days) {
        var highest = -Infinity;
        for (var i = prices.length - days; i < prices.length; i++) {
          if (prices[i].high > highest) highest = prices[i].high;
        }
        return highest;
      }

      function lowestLow(days) {
        var lowest = Infinity;
        for (var i = prices.length - days; i < prices.length; i++) {
          if (prices[i].low < lowest) lowest = prices[i].low;
        }
        return lowest;
      }

      function round2(value) {
        return Number(value.toFixed(2));
      }

      var otcLiveQuote = getTwseOtcLiveQuote_();
      var latestHistory = prices[prices.length - 1];
      var nowTaipei = new Date();
      var todayText = Utilities.formatDate(nowTaipei, timezone, "yyyy/MM/dd");
      var taipeiTime = Number(
        Utilities.formatDate(nowTaipei, timezone, "HHmm")
      );
      var hasOfficialTodayClose =
        latestHistory.date === todayText && taipeiTime >= 1335;
      var hasTodayLiveQuote =
        otcLiveQuote && otcLiveQuote.date === todayText;

      // 盤中採即時價；13:35 後若櫃買中心已發布當日日資料，
      // 一律採正式收盤指數，避免最後成交欄位 z 與收盤指數不一致。
      var otcCurrentPrice = hasOfficialTodayClose
        ? latestHistory.close
        : (hasTodayLiveQuote ? otcLiveQuote.price : latestHistory.close);
      var otcDataDate = hasOfficialTodayClose
        ? latestHistory.date
        : (hasTodayLiveQuote ? otcLiveQuote.date : latestHistory.date);

      // 歷史資料已有今日收盤時，昨日價格取前一交易日；
      // 尚未有今日資料（盤中、休市或來源未更新）時，取最近交易日收盤。
      var otcPreviousClose = latestHistory.date === todayText
        ? prices[prices.length - 2].close
        : latestHistory.close;

      metrics = {
        dataDate: otcDataDate,
        current: round2(otcCurrentPrice),
        previous: round2(otcPreviousClose),
        ma5: round2(movingAverage(5)),
        ma10: round2(movingAverage(10)),
        ma20: round2(movingAverage(20)),
        ma60: round2(movingAverage(60)),
        ma120: round2(movingAverage(120)),
        ma240: round2(movingAverage(240)),
        high10: round2(highestHigh(10)),
        high20: round2(highestHigh(20)),
        high60: round2(highestHigh(60)),
        high90: round2(highestHigh(90)),
        high120: round2(highestHigh(120)),
        high240: round2(highestHigh(240)),
        low10: round2(lowestLow(10))
      };

      // 個別儲存格重複呼叫時共用結果，最多 60 秒後自動更新。
      cache.put(cacheKey, JSON.stringify(metrics), 60);
    }

    console.log("OTC_METRICS: " + JSON.stringify(metrics));

    var aliases = {
      "資料日期": "dataDate",
      "日期": "dataDate",
      "現價": "current",
      "最新價": "current",
      "最新櫃買指數": "current",
      "昨日價格": "previous",
      "昨收": "previous",
      "昨日收盤價": "previous",
      "5日均線": "ma5",
      "5MA": "ma5",
      "MA5": "ma5",
      "10日均線": "ma10",
      "10MA": "ma10",
      "MA10": "ma10",
      "月均線": "ma20",
      "20日均線": "ma20",
      "20MA": "ma20",
      "MA20": "ma20",
      "季均線": "ma60",
      "60日均線": "ma60",
      "60MA": "ma60",
      "MA60": "ma60",
      "半年線": "ma120",
      "120日均線": "ma120",
      "120MA": "ma120",
      "MA120": "ma120",
      "年線": "ma240",
      "240日均線": "ma240",
      "240MA": "ma240",
      "MA240": "ma240",
      "10日最高價": "high10",
      "前10日最高價": "high10",
      "10日間最高價": "high10",
      "10DAYHIGH": "high10",
      "20日最高價": "high20",
      "前20日最高價": "high20",
      "20日間最高價": "high20",
      "20DAYHIGH": "high20",
      "60日最高價": "high60",
      "前60日最高價": "high60",
      "60日間最高價": "high60",
      "60DAYHIGH": "high60",
      "90日最高價": "high90",
      "前90日最高價": "high90",
      "90日間最高價": "high90",
      "90DAYHIGH": "high90",
      "120日最高價": "high120",
      "前120日最高價": "high120",
      "120日間最高價": "high120",
      "120DAYHIGH": "high120",
      "240日最高價": "high240",
      "前240日最高價": "high240",
      "240日間最高價": "high240",
      "240DAYHIGH": "high240",
      "10日最低價": "low10",
      "前10日最低價": "low10",
      "10日間最低價": "low10",
      "10DAYLOW": "low10"
    };

    if (item !== undefined && item !== null && String(item).trim() !== "") {
      var normalized = String(item).trim().toUpperCase().replace(/\s+/g, "");
      var metricKey = aliases[normalized];
      if (!metricKey) {
        return "不支援的指標: " + item;
      }
      return metrics[metricKey];
    }

    return [
      ["項目", "數值"],
      ["資料日期", metrics.dataDate],
      ["現價", metrics.current],
      ["昨日價格", metrics.previous],
      ["5日均線", metrics.ma5],
      ["10日均線", metrics.ma10],
      ["月均線(20日)", metrics.ma20],
      ["季均線(60日)", metrics.ma60],
      ["半年線(120日)", metrics.ma120],
      ["年線(240日)", metrics.ma240],
      ["10日最高價", metrics.high10],
      ["20日最高價", metrics.high20],
      ["60日最高價", metrics.high60],
      ["90日最高價", metrics.high90],
      ["120日最高價", metrics.high120],
      ["240日最高價", metrics.high240],
      ["10日最低價", metrics.low10]
    ];
  } catch (error) {
    console.log(error);
    return "發生錯誤: " + error.toString();
  }
}

/**
 * 取得 XAUUSD 現貨黃金（美元/盎司）的現價、均線與90日最高價。
 * 現價與昨日價格採富途 XAUUSD 現貨；歷史均線與90日高點採 Yahoo GC=F 歷史資料。
 * 用法：=GET_GOLD_INFO("現價")、=GET_GOLD_INFO("年線")
 * 不帶參數會回傳全部指標。
 *
 * @param {string} item 要查詢的指標
 * @customfunction
 */
function GET_GOLD_INFO(item, refresh) {
  var result = getMetalInfo_("GC=F", "黃金", item);
  console.log("GOLD_RESULT: " + JSON.stringify(result));
  return result;
}

/**
 * 取得COMEX 白銀期貨（美元/盎司）的價格、均線與90日最高價。
 * 用法：=GET_SILVER_INFO("現價")、=GET_SILVER_INFO("年線")
 * 不帶參數會回傳全部指標。
 *
 * @param {string} item 要查詢的指標
 * @customfunction
 */
function GET_SILVER_INFO(item, refresh) {
  var result = getMetalInfo_("SI=F", "白銀", item);
  console.log("SILVER_RESULT: " + JSON.stringify(result));
  return result;
}

/**
 * 黃金與白銀共用的查詢邏輯。
 * 月、季、半年、年線分別採20、60、120、240個交易日。
 */
function getBrentActivePrice_() {
  var monthCodes = ["F", "G", "H", "J", "K", "M", "N", "Q", "U", "V", "X", "Z"];
  var now = new Date();
  var candidates = [];

  for (var offset = 1; offset <= 2; offset++) {
    var contractDate = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() + offset,
      1
    ));
    candidates.push(
      "BZ" +
      monthCodes[contractDate.getUTCMonth()] +
      String(contractDate.getUTCFullYear()).slice(-2) +
      ".NYM"
    );
  }

  var requests = candidates.map(function(symbol) {
    return {
      url: "https://query1.finance.yahoo.com/v8/finance/chart/" +
           encodeURIComponent(symbol) +
           "?interval=1d&range=5d&_=" + Date.now(),
      method: "get",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      },
      muteHttpExceptions: true
    };
  });

  var responses = UrlFetchApp.fetchAll(requests);
  var best = null;

  for (var i = 0; i < responses.length; i++) {
    if (responses[i].getResponseCode() !== 200) continue;

    var payload = JSON.parse(responses[i].getContentText());
    var result = payload.chart && payload.chart.result
      ? payload.chart.result[0]
      : null;
    if (!result) continue;

    var meta = result.meta || {};
    var quote = result.indicators && result.indicators.quote
      ? result.indicators.quote[0]
      : null;
    var closes = quote && quote.close ? quote.close : [];
    var volumes = quote && quote.volume ? quote.volume : [];
    var price = Number(meta.regularMarketPrice);
    var quoteTime = Number(meta.regularMarketTime) || 0;
    var volume = Number(meta.regularMarketVolume) || 0;

    for (var j = closes.length - 1; j >= 0; j--) {
      if ((isNaN(price) || price <= 0) && closes[j] !== null) {
        price = Number(closes[j]);
      }
      if (volumes[j] !== null && Number(volumes[j]) > 0) {
        volume = Math.max(volume, Number(volumes[j]));
        break;
      }
    }

    if (isNaN(price) || price <= 0) continue;

    // 以報價日期（是否為當天實際交易）為優先，避免選到已停止交易的舊合約；
    // 只有在兩個合約報價日期相同時，才用成交量判斷哪個是主力合約。
    var candidateDay = Math.floor(quoteTime / 86400);
    var bestDay = best ? Math.floor(best.quoteTime / 86400) : -1;

    if (!best || candidateDay > bestDay ||
        (candidateDay === bestDay && volume > best.volume)) {
      best = {
        symbol: candidates[i],
        price: price,
        volume: volume,
        quoteTime: quoteTime
      };
    }
  }

  if (!best) return null;
  console.log("BRENT_ACTIVE_CONTRACT: " + JSON.stringify(best));
  return best.price;
}

/**
 * 取得富途 XAUUSD 現貨報價。
 * 富途公開 quote API 需要以參數 JSON 產生 quote-token。
 */
function futunnSerializeParams_(params) {
  var normalized = {};
  Object.keys(params).forEach(function(key) {
    if (params[key] !== undefined) normalized[key] = String(params[key]);
  });
  return JSON.stringify(normalized);
}

function futunnBytesToHex_(bytes) {
  return bytes.map(function(byte) {
    var value = byte < 0 ? byte + 256 : byte;
    return ("0" + value.toString(16)).slice(-2);
  }).join("");
}

function futunnQuoteToken_(serializedParams) {
  var hmac = futunnBytesToHex_(
    Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_512, serializedParams, "quote_web")
  ).slice(0, 10);
  return futunnBytesToHex_(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, hmac)
  ).slice(0, 10);
}

function getFutunnSpotQuote_(stockId, metalLabel) {
  try {
    var params = {
      stockId: stockId,
      marketType: 11,
      marketCode: 11,
      instrumentType: 10
    };
    var serializedParams = futunnSerializeParams_(params);
    var query = Object.keys(params).map(function(key) {
      return encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key]));
    }).join("&");
    var response = UrlFetchApp.fetch(
      "https://www.futunn.com/quote-api/quote-v2/get-stock-quote?" + query,
      {
        method: "get",
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0",
          "quote-token": futunnQuoteToken_(serializedParams)
        },
        muteHttpExceptions: true
      }
    );

    if (response.getResponseCode() !== 200) return null;
    var payload = JSON.parse(response.getContentText());
    if (!payload || Number(payload.code) !== 0 || !payload.data) return null;

    var data = payload.data;
    var price = Number(data.price || data.priceNominal);
    if (isNaN(price) || price <= 0) return null;

    var previous = Number(data.priceLastClose);
    var timeMs = Number(data.exchangeDataTimeMs || data.serverSendToClientTimeMs);
    return {
      price: price,
      previous: previous,
      time: timeMs > 100000000000 ? timeMs / 1000 : timeMs
    };
  } catch (error) {
    console.log("FUTUNN_" + metalLabel + "_QUOTE_ERROR: " + error);
    return null;
  }
}

function getFutunnGoldSpotQuote_() {
  return getFutunnSpotQuote_(72000031, "GOLD");
}

function getFutunnSilverSpotQuote_() {
  return getFutunnSpotQuote_(72000032, "SILVER");
}

function getMetalInfo_(symbol, metalName, item) {
  try {
    var cache = CacheService.getScriptCache();
    var cacheKey = "METAL_INFO_V15_" + symbol;
    var cached = cache.get(cacheKey);
    var metrics;

    if (cached) {
      metrics = JSON.parse(cached);
    } else {
      var url = "https://query1.finance.yahoo.com/v8/finance/chart/" +
                encodeURIComponent(symbol) +
                "?interval=1d&range=2y&_=" + Date.now();

      var response = UrlFetchApp.fetch(url, {
        method: "get",
        headers: {
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        muteHttpExceptions: true
      });

      var statusCode = response.getResponseCode();
      if (statusCode !== 200) {
        return metalName + "資料來源回應錯誤 (HTTP " + statusCode + ")";
      }

      var payload = JSON.parse(response.getContentText());
      if (!payload.chart || payload.chart.error ||
          !payload.chart.result || payload.chart.result.length === 0) {
        var message = payload.chart && payload.chart.error
          ? payload.chart.error.description
          : "找不到資料";
        return "無法取得" + metalName + "資料: " + message;
      }

      var result = payload.chart.result[0];
      var meta = result.meta || {};
      var timestamps = result.timestamp || [];
      var quote = result.indicators && result.indicators.quote
        ? result.indicators.quote[0]
        : null;

      if (!quote || !Array.isArray(quote.close) ||
          !Array.isArray(quote.high)) {
        return "無法取得" + metalName + "每日價格";
      }

      var prices = [];
      for (var i = 0; i < quote.close.length; i++) {
        var close = Number(quote.close[i]);
        var high = Number(quote.high[i]);
        var low = quote.low ? Number(quote.low[i]) : NaN;
        if (quote.close[i] !== null && quote.high[i] !== null &&
            !isNaN(close) && !isNaN(high) && close > 0 && high > 0) {
          prices.push({
            timestamp: timestamps[i] || 0,
            close: close,
            high: high,
            low: (!isNaN(low) && low > 0 && low <= high) ? low : high
          });
        }
      }

      if (prices.length < 240) {
        return metalName + "歷史交易日資料不足，目前只有 " +
               prices.length + " 筆";
      }

      function movingAverage(days) {
        var sum = 0;
        for (var i = prices.length - days; i < prices.length; i++) {
          sum += prices[i].close;
        }
        return sum / days;
      }

      function highestHigh(days) {
        var highest = -Infinity;
        for (var i = prices.length - days; i < prices.length; i++) {
          if (prices[i].high > highest) highest = prices[i].high;
        }
        return highest;
      }

      function lowestLow(days) {
        var lowest = Infinity;
        for (var i = prices.length - days; i < prices.length; i++) {
          if (prices[i].low < lowest) lowest = prices[i].low;
        }
        return lowest;
      }

      function round2(value) {
        return Number(Number(value).toFixed(2));
      }

      var latest = prices[prices.length - 1];
      var spotQuote = symbol === "GC=F" ? getFutunnGoldSpotQuote_()
        : symbol === "SI=F" ? getFutunnSilverSpotQuote_()
        : null;
      var currentPrice = symbol === "BZ=F"
        ? getBrentActivePrice_()
        : spotQuote && spotQuote.price > 0
          ? spotQuote.price
          : Number(meta.regularMarketPrice);
      if (isNaN(currentPrice) || currentPrice <= 0) {
        currentPrice = latest.close;
      }

      var previousPrice = spotQuote && spotQuote.previous > 0
        ? spotQuote.previous
        : Number(meta.previousClose);
      if (isNaN(previousPrice) || previousPrice <= 0) {
        previousPrice = prices[prices.length - 2].close;
      }

      var dataTimestamp = spotQuote && spotQuote.time > 0
        ? spotQuote.time
        : Number(meta.regularMarketTime);
      if (isNaN(dataTimestamp) || dataTimestamp <= 0) {
        dataTimestamp = latest.timestamp + 86400;
      }

      metrics = {
        dataDate: Utilities.formatDate(
          new Date(dataTimestamp * 1000),
          "Asia/Taipei",
          "yyyy/MM/dd"
        ),
        currency: meta.currency || "USD",
        current: round2(currentPrice),
        previous: round2(previousPrice),
        ma5: round2(movingAverage(5)),
        ma10: round2(movingAverage(10)),
        ma20: round2(movingAverage(20)),
        ma60: round2(movingAverage(60)),
        ma120: round2(movingAverage(120)),
        ma240: round2(movingAverage(240)),
        high10: round2(highestHigh(10)),
        high20: round2(highestHigh(20)),
        high60: round2(highestHigh(60)),
        high90: round2(highestHigh(90)),
        high120: round2(highestHigh(120)),
        high240: round2(highestHigh(240)),
        low10: round2(lowestLow(10))
      };

      // 黃金、白銀與布倫特原油配合刷新標記，最多共用 60 秒。
      cache.put(cacheKey, JSON.stringify(metrics), 60);
    }

    console.log(metalName + "_METRICS: " + JSON.stringify(metrics));

    var aliases = {
      "資料日期": "dataDate",
      "日期": "dataDate",
      "幣別": "currency",
      "現價": "current",
      "最新價": "current",
      "昨日價格": "previous",
      "昨收": "previous",
      "昨日收盤價": "previous",
      "5日均線": "ma5",
      "5MA": "ma5",
      "MA5": "ma5",
      "10日均線": "ma10",
      "10MA": "ma10",
      "MA10": "ma10",
      "月均線": "ma20",
      "20日均線": "ma20",
      "20MA": "ma20",
      "MA20": "ma20",
      "季均線": "ma60",
      "60日均線": "ma60",
      "60MA": "ma60",
      "MA60": "ma60",
      "半年線": "ma120",
      "120日均線": "ma120",
      "120MA": "ma120",
      "MA120": "ma120",
      "年線": "ma240",
      "240日均線": "ma240",
      "240MA": "ma240",
      "MA240": "ma240",
      "10日最高價": "high10",
      "前10日最高價": "high10",
      "10日間最高價": "high10",
      "10DAYHIGH": "high10",
      "20日最高價": "high20",
      "前20日最高價": "high20",
      "20日間最高價": "high20",
      "20DAYHIGH": "high20",
      "60日最高價": "high60",
      "前60日最高價": "high60",
      "60日間最高價": "high60",
      "60DAYHIGH": "high60",
      "90日最高價": "high90",
      "前90日最高價": "high90",
      "90日間最高價": "high90",
      "90DAYHIGH": "high90",
      "120日最高價": "high120",
      "前120日最高價": "high120",
      "120日間最高價": "high120",
      "120DAYHIGH": "high120",
      "240日最高價": "high240",
      "前240日最高價": "high240",
      "240日間最高價": "high240",
      "240DAYHIGH": "high240",
      "10日最低價": "low10",
      "前10日最低價": "low10",
      "10日間最低價": "low10",
      "10DAYLOW": "low10"
    };

    if (item !== undefined && item !== null && String(item).trim() !== "") {
      var normalized = String(item).trim().toUpperCase().replace(/\s+/g, "");
      var metricKey = aliases[normalized];
      if (!metricKey) {
        return "不支援的指標: " + item;
      }
      return metrics[metricKey];
    }

    return [
      ["項目", "數值"],
      ["資料日期", metrics.dataDate],
      ["幣別", metrics.currency],
      ["現價", metrics.current],
      ["昨日價格", metrics.previous],
      ["5日均線", metrics.ma5],
      ["10日均線", metrics.ma10],
      ["月均線(20日)", metrics.ma20],
      ["季均線(60日)", metrics.ma60],
      ["半年線(120日)", metrics.ma120],
      ["年線(240日)", metrics.ma240],
      ["10日最高價", metrics.high10],
      ["20日最高價", metrics.high20],
      ["60日最高價", metrics.high60],
      ["90日最高價", metrics.high90],
      ["120日最高價", metrics.high120],
      ["240日最高價", metrics.high240],
      ["10日最低價", metrics.low10]
    ];
  } catch (error) {
    console.log(error);
    return "發生錯誤: " + error.toString();
  }
}

/**
 * 取得布倫特原油期貨（美元/桶）的價格、均線與90日最高價。
 * 用法：=GET_BRENT_INFO("現價")、=GET_BRENT_INFO("年線")
 * 不帶參數會回傳全部指標。
 *
 * @param {string} item 要查詢的指標
 * @customfunction
 */
function GET_BRENT_INFO(item, refresh) {
  var result = getMetalInfo_("BZ=F", "布倫特原油", item);
  console.log("BRENT_RESULT: " + JSON.stringify(result));
  return result;
}

/**
 * 取得鉅亨網（cnyes）台指期近月合約即時報價（現價／漲跌／漲跌幅／昨收），
 * 涵蓋日盤與夜盤。cnyes 的 "21" 欄位以 TSMC(2330) 昨收比對驗證過，
 * 確認對應「昨收參考價」而非成交均價。
 */
function getTaiexFuturesLiveQuote_() {
  try {
    var response = UrlFetchApp.fetch(
      "https://ws.api.cnyes.com/ws/api/v1/quote/quotes/TWF:TXF:FUTURES?_=" + Date.now(),
      {
        method: "get",
        headers: {"Accept": "application/json", "User-Agent": "Mozilla/5.0"},
        muteHttpExceptions: true
      }
    );
    if (response.getResponseCode() !== 200) return null;

    var payload = JSON.parse(response.getContentText());
    var row = payload.data && payload.data.length ? payload.data[0] : null;
    if (!row) return null;

    var price = Number(row["6"]);
    if (isNaN(price) || price <= 0) return null;

    var previous = Number(row["21"]);
    var change = Number(row["11"]);
    var changePercent = Number(row["56"]);
    var time = Number(row["200007"]);

    return {
      price: price,
      previous: !isNaN(previous) && previous > 0 ? previous : null,
      change: isNaN(change) ? null : change,
      changePercent: isNaN(changePercent) ? null : changePercent,
      time: !isNaN(time) && time > 0 ? time : null
    };
  } catch (error) {
    console.log("TAIEX_FUTURES_LIVE_ERROR: " + error.toString());
    return null;
  }
}

/**
 * 取得台指期（台灣期貨交易所 TX 近月合約）現價、漲跌、均線與90日最高價。
 * 現價／昨日價格／漲跌／漲跌幅採鉅亨網近月合約即時報價，日盤、夜盤皆可更新；
 * 均線與90日高低點採台股加權指數（^TWII）歷史收盤價 —— 因台指期與現貨長期
 * 緊密貼合，且目前無可靠免費來源可取得期貨完整歷史日資料，做法與
 * getMetalInfo_ 用 Yahoo 期貨歷史資料配即時現貨報價的概念一致。
 *
 * 個別查詢範例：
 * =GET_TAIEX_FUTURES_INFO("現價")
 * =GET_TAIEX_FUTURES_INFO("漲跌")
 * =GET_TAIEX_FUTURES_INFO("漲跌幅")
 * =GET_TAIEX_FUTURES_INFO("昨日價格")
 * =GET_TAIEX_FUTURES_INFO("10日均線")
 * =GET_TAIEX_FUTURES_INFO("90日最高價")
 *
 * 不帶參數會回傳全部指標。第二參數 refresh 可傳入會定時變動的儲存格
 * （例如 $ZZ$1），讓這個函式跟著該儲存格的變動重新計算。
 *
 * @param {string} item 要查詢的指標
 * @customfunction
 */
function GET_TAIEX_FUTURES_INFO(item, refresh) {
  try {
    var cache = CacheService.getScriptCache();
    var cacheKey = "TAIEX_FUTURES_INFO_V1";
    var cached = cache.get(cacheKey);
    var metrics;

    if (cached) {
      metrics = JSON.parse(cached);
    } else {
      var liveQuote = getTaiexFuturesLiveQuote_();

      var url = "https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII" +
                "?interval=1d&range=2y&_=" + Date.now();
      var response = UrlFetchApp.fetch(url, {
        method: "get",
        headers: {"Accept": "application/json", "User-Agent": "Mozilla/5.0"},
        muteHttpExceptions: true
      });

      var statusCode = response.getResponseCode();
      if (statusCode !== 200) {
        return "台指期資料來源回應錯誤 (HTTP " + statusCode + ")";
      }

      var payload = JSON.parse(response.getContentText());
      if (!payload.chart || payload.chart.error ||
          !payload.chart.result || payload.chart.result.length === 0) {
        var message = payload.chart && payload.chart.error
          ? payload.chart.error.description
          : "找不到資料";
        return "無法取得台指期歷史資料: " + message;
      }

      var result = payload.chart.result[0];
      var timestamps = result.timestamp || [];
      var quote = result.indicators && result.indicators.quote
        ? result.indicators.quote[0]
        : null;

      if (!quote || !Array.isArray(quote.close) || !Array.isArray(quote.high)) {
        return "無法取得台指期每日價格";
      }

      var prices = [];
      for (var i = 0; i < quote.close.length; i++) {
        var close = Number(quote.close[i]);
        var high = Number(quote.high[i]);
        var low = quote.low ? Number(quote.low[i]) : NaN;
        if (quote.close[i] !== null && quote.high[i] !== null &&
            !isNaN(close) && !isNaN(high) && close > 0 && high > 0) {
          prices.push({
            timestamp: timestamps[i] || 0,
            close: close,
            high: high,
            low: (!isNaN(low) && low > 0 && low <= high) ? low : high
          });
        }
      }

      if (prices.length < 240) {
        return "台指期歷史交易日資料不足，目前只有 " + prices.length + " 筆";
      }

      function movingAverage(days) {
        var sum = 0;
        for (var i = prices.length - days; i < prices.length; i++) {
          sum += prices[i].close;
        }
        return sum / days;
      }

      function highestHigh(days) {
        var highest = -Infinity;
        for (var i = prices.length - days; i < prices.length; i++) {
          if (prices[i].high > highest) highest = prices[i].high;
        }
        return highest;
      }

      function lowestLow(days) {
        var lowest = Infinity;
        for (var i = prices.length - days; i < prices.length; i++) {
          if (prices[i].low < lowest) lowest = prices[i].low;
        }
        return lowest;
      }

      function round2(value) {
        return Number(Number(value).toFixed(2));
      }

      var latest = prices[prices.length - 1];
      var currentPrice = liveQuote && liveQuote.price > 0 ? liveQuote.price : latest.close;
      var previousPrice = liveQuote && liveQuote.previous > 0
        ? liveQuote.previous
        : prices[prices.length - 2].close;
      var changeAmount = liveQuote && liveQuote.change !== null
        ? liveQuote.change
        : (currentPrice - previousPrice);
      var changePercent = liveQuote && liveQuote.changePercent !== null
        ? liveQuote.changePercent
        : (previousPrice ? (currentPrice - previousPrice) / previousPrice * 100 : null);
      var dataTimestamp = liveQuote && liveQuote.time > 0 ? liveQuote.time : latest.timestamp;

      metrics = {
        dataDate: Utilities.formatDate(
          new Date(dataTimestamp * 1000), "Asia/Taipei", "yyyy/MM/dd HH:mm"
        ),
        current: round2(currentPrice),
        previous: round2(previousPrice),
        change: round2(changeAmount),
        changePercent: changePercent === null ? null : round2(changePercent),
        ma5: round2(movingAverage(5)),
        ma10: round2(movingAverage(10)),
        ma20: round2(movingAverage(20)),
        ma60: round2(movingAverage(60)),
        ma120: round2(movingAverage(120)),
        ma240: round2(movingAverage(240)),
        high90: round2(highestHigh(90)),
        high10: round2(highestHigh(10)),
        low10: round2(lowestLow(10))
      };

      // 個別儲存格重複呼叫時共用結果，最多 110 秒後自動更新（約每2分鐘一次）。
      cache.put(cacheKey, JSON.stringify(metrics), 110);
    }

    console.log("TAIEX_FUTURES_METRICS: " + JSON.stringify(metrics));

    var aliases = {
      "資料日期": "dataDate",
      "日期": "dataDate",
      "現價": "current",
      "最新價": "current",
      "漲跌": "change",
      "漲跌點數": "change",
      "漲跌幅": "changePercent",
      "漲跌%": "changePercent",
      "昨日價格": "previous",
      "昨收": "previous",
      "昨日收盤價": "previous",
      "5日均線": "ma5",
      "5MA": "ma5",
      "MA5": "ma5",
      "10日均線": "ma10",
      "10MA": "ma10",
      "MA10": "ma10",
      "月均線": "ma20",
      "20日均線": "ma20",
      "20MA": "ma20",
      "MA20": "ma20",
      "季均線": "ma60",
      "60日均線": "ma60",
      "60MA": "ma60",
      "MA60": "ma60",
      "半年線": "ma120",
      "120日均線": "ma120",
      "120MA": "ma120",
      "MA120": "ma120",
      "年線": "ma240",
      "240日均線": "ma240",
      "240MA": "ma240",
      "MA240": "ma240",
      "90日最高價": "high90",
      "90日間最高價": "high90",
      "90DAYHIGH": "high90",
      "前10日最高價": "high10",
      "10日最高價": "high10",
      "前10日最低價": "low10",
      "10日最低價": "low10"
    };

    if (item !== undefined && item !== null && String(item).trim() !== "") {
      var normalized = String(item).trim().toUpperCase().replace(/\s+/g, "");
      var metricKey = aliases[normalized];
      if (!metricKey) {
        return "不支援的指標: " + item;
      }
      return metrics[metricKey];
    }

    return [
      ["項目", "數值"],
      ["資料時間", metrics.dataDate],
      ["現價", metrics.current],
      ["漲跌", metrics.change],
      ["漲跌幅(%)", metrics.changePercent],
      ["昨日價格", metrics.previous],
      ["5日均線", metrics.ma5],
      ["10日均線", metrics.ma10],
      ["月均線(20日)", metrics.ma20],
      ["季均線(60日)", metrics.ma60],
      ["半年線(120日)", metrics.ma120],
      ["年線(240日)", metrics.ma240],
      ["90日最高價", metrics.high90],
      ["前10日最高價", metrics.high10],
      ["前10日最低價", metrics.low10]
    ];
  } catch (error) {
    console.log(error);
    return "發生錯誤: " + error.toString();
  }
}

/**
 * 判斷現在是否為台指期交易時間（Asia/Taipei）：
 * 日盤 週一~五 08:45~13:45；夜盤 週一~五 15:00 開盤，
 * 延續至翌日 05:00（即週二~六 00:00~05:00 視為前一交易日夜盤）。
 */
function isTaiexFuturesMarketHours_() {
  var timezone = "Asia/Taipei";
  var now = new Date();
  var isoWeekday = Number(Utilities.formatDate(now, timezone, "u")); // 1=一 ... 7=日
  var hhmm = Number(Utilities.formatDate(now, timezone, "HHmm"));
  var daySession = isoWeekday <= 5 && hhmm >= 845 && hhmm <= 1345;
  var nightSessionEvening = isoWeekday <= 5 && hhmm >= 1500;
  var nightSessionMorning = isoWeekday >= 2 && isoWeekday <= 6 && hhmm < 500;
  return daySession || nightSessionEvening || nightSessionMorning;
}

/**
 * 判斷現在是否為台股交易時間（週一~五 09:00~13:35，Asia/Taipei）。
 * 每分鐘強制重算只在這段時間內有意義，其餘時間執行只會白白消耗
 * UrlFetchApp 每日呼叫配額（get_stock_price 等函式會因此被觸發重算）。
 */
function isTaiwanMarketHours_() {
  var timezone = "Asia/Taipei";
  var now = new Date();
  var isoWeekday = Number(Utilities.formatDate(now, timezone, "u")); // 1=一 ... 7=日
  if (isoWeekday > 5) return false;
  var hhmm = Number(Utilities.formatDate(now, timezone, "HHmm"));
  return hhmm >= 900 && hhmm <= 1335;
}

/**
 * 更新市場報價刷新標記。由每 1 分鐘觸發條件自動執行，
 * 但只在台股交易時間或台指期交易時間（含夜盤）內實際寫入，
 * 避免非交易時間浪費 UrlFetch 配額。
 */
function UPDATE_MARKET_REFRESH_TOKEN() {
  var refreshTokens = isTaiwanMarketHours_() || isTaiexFuturesMarketHours_();
  var now = new Date();
  var weekday = Number(Utilities.formatDate(now, "Asia/Taipei", "u"));
  var hhmm = Number(Utilities.formatDate(now, "Asia/Taipei", "HHmm"));
  // 收盤後保留更新窗口，等櫃買中心發布正式收盤資料。
  var refreshOtc = weekday <= 5 && hhmm >= 900 && hhmm <= 1405;
  if (!refreshTokens && !refreshOtc) return;

  var spreadsheet = SpreadsheetApp.openById("1WQNCHJfK5CXluCeWsSee64NczdG6DapcbBkI7C8OuFI");
  var sheetIds = [
    828678278,  // 個股分析
    1613199650, // 殖利率黃金日圓重要指標
    2069040316, // 標兵（AE122/AF118 等自訂函式格所在分頁）
    1525480597, // 太空支付未來車
    1802841501, // 國外ETF在台灣
    1377786989  // 國內ETF
  ];
  for (var i = 0; refreshTokens && i < sheetIds.length; i++) {
    var sheet = spreadsheet.getSheetById(sheetIds[i]);
    if (!sheet) throw new Error("找不到指定工作表: " + sheetIds[i]);
    var refreshNow = new Date();
    // 保留既有 ZZ1 依賴；個股分析的台指公式實際依賴 AAA1，兩者同步更新。
    sheet.getRange("ZZ1").setValue(refreshNow);
    if (sheetIds[i] === 828678278) {
      sheet.getRange("AAA1").setValue(refreshNow);
    }
  }
  SpreadsheetApp.flush();
  if (refreshOtc) {
    try {
      UPDATE_BIAOBING_OTC_QUOTE();
    } catch (error) {
      console.error("BIAOBING_OTC_UPDATE_ERROR: " + error.toString());
    }
  }
}

/**
 * 直接更新標兵 AE3/AF3，不依賴 ZZ1 或試算表自訂函式重新計算。
 * 使用同一份報價快照，取得有效價格後才一起寫入，保留既有格式。
 */
function UPDATE_BIAOBING_OTC_QUOTE() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var table = GET_OTC_INFO();
    if (!Array.isArray(table)) throw new Error(String(table));
    var quote = {};
    for (var i = 1; i < table.length; i++) {
      quote[table[i][0]] = table[i][1];
    }
    var current = quote["現價"];
    var previous = quote["昨日價格"];
    if (typeof current !== "number" || !isFinite(current) || current <= 0 ||
        typeof previous !== "number" || !isFinite(previous) || previous <= 0) {
      throw new Error("櫃買報價無效，保留原值");
    }
    var spreadsheet = SpreadsheetApp.openById("1WQNCHJfK5CXluCeWsSee64NczdG6DapcbBkI7C8OuFI");
    var sheet = spreadsheet.getSheetById(2069040316);
    if (!sheet) throw new Error("找不到標兵工作表");
    // 保留原 AF3 公式的分母（現價）。
    var values = [[current, (current - previous) / current]];
    sheet.getRange("AE3:AF3").setValues(values);
    SpreadsheetApp.flush();
    console.log("BIAOBING_OTC_UPDATED: " + JSON.stringify({
      date: quote["資料日期"], current: current, previous: previous,
      change: values[0][1]
    }));
    return values;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 建立唯一的每 1 分鐘市場報價更新觸發條件。
 */
function SETUP_MARKET_REFRESH_TRIGGER() {
  var handler = "UPDATE_MARKET_REFRESH_TOKEN";
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(1).create();
  UPDATE_MARKET_REFRESH_TOKEN();
}

/**
 * 部署後回歸自我測試：確認關鍵函式仍存在、可正常執行、回傳合理型別。
 * 每次修改／clasp push 之後，執行 `clasp run RUN_SELF_TESTS` 做最低限度的
 * 「有沒有改壞其他功能」檢查（只驗證函式沒壞掉，不驗證報價數字本身的正確性，
 * 也刻意只呼叫少量會發送 UrlFetch 的函式，避免消耗每日配額）。
 */
function RUN_SELF_TESTS() {
  var results = [];

  function check(name, fn) {
    try {
      var value = fn();
      var pass = value !== false;
      results.push({name: name, pass: pass, value: value});
    } catch (error) {
      results.push({name: name, pass: false, error: error.toString()});
    }
  }

  function isNumber(value) {
    return typeof value === "number" && !isNaN(value);
  }

  // 1. 關鍵函式必須存在（用識別字直接參照，函式若被誤刪這裡會直接拋 ReferenceError）
  check("GET_TW_OTC_ETF_INFO 存在", function() { return typeof GET_TW_OTC_ETF_INFO === "function"; });
  check("GET_TAIEX_FUTURES_INFO 存在", function() { return typeof GET_TAIEX_FUTURES_INFO === "function"; });
  check("GET_OTC_INFO 存在", function() { return typeof GET_OTC_INFO === "function"; });
  check("GET_GOLD_INFO 存在", function() { return typeof GET_GOLD_INFO === "function"; });
  check("GET_SILVER_INFO 存在", function() { return typeof GET_SILVER_INFO === "function"; });
  check("GET_BRENT_INFO 存在", function() { return typeof GET_BRENT_INFO === "function"; });
  check("get_stock_price 存在", function() { return typeof get_stock_price === "function"; });
  check("GET_TW_OTC_CHANGE_PCT 存在", function() { return typeof GET_TW_OTC_CHANGE_PCT === "function"; });
  check("GET_TW_OTC_PRICE 存在", function() { return typeof GET_TW_OTC_PRICE === "function"; });
  check("GET_JP_STOCK_PRICE 存在", function() { return typeof GET_JP_STOCK_PRICE === "function"; });
  check("UPDATE_ASSET_CHANGE_LOG_WITH_ALERT 存在", function() { return typeof UPDATE_ASSET_CHANGE_LOG_WITH_ALERT === "function"; });
  check("UPDATE_ASSET_CHANGE_LOG 存在", function() { return typeof UPDATE_ASSET_CHANGE_LOG === "function"; });
  check("findColumnByHeader_ 存在", function() { return typeof findColumnByHeader_ === "function"; });
  check("findRowByLabelInColA_ 存在", function() { return typeof findRowByLabelInColA_ === "function"; });
  check("isTaiwanMarketHours_ 存在", function() { return typeof isTaiwanMarketHours_ === "function"; });
  check("UPDATE_MARKET_REFRESH_TOKEN 存在", function() { return typeof UPDATE_MARKET_REFRESH_TOKEN === "function"; });
  check("SETUP_MARKET_REFRESH_TRIGGER 存在", function() { return typeof SETUP_MARKET_REFRESH_TRIGGER === "function"; });

  // 2. UPDATE_MARKET_REFRESH_TOKEN 涵蓋的 6 個工作表 sheetId 不可被誤刪
  check("UPDATE_MARKET_REFRESH_TOKEN 涵蓋 6 個必要工作表", function() {
    var src = UPDATE_MARKET_REFRESH_TOKEN.toString();
    var requiredIds = [828678278, 1613199650, 2069040316, 1525480597, 1802841501, 1377786989];
    var missing = requiredIds.filter(function(id) { return src.indexOf(String(id)) === -1; });
    if (missing.length) throw new Error("缺少 sheetId: " + missing.join(", "));
    return true;
  });

  // 3. 少量輕量呼叫，確認關鍵函式實際可執行且回傳合理型別（非例外、非文字錯誤訊息）
  check("isTaiwanMarketHours_() 回傳布林值", function() {
    return typeof isTaiwanMarketHours_() === "boolean";
  });
  check("GET_OTC_INFO(\"現價\") 回傳數字", function() {
    return isNumber(GET_OTC_INFO("現價"));
  });
  check("GET_BRENT_INFO(\"現價\") 回傳數字", function() {
    return isNumber(GET_BRENT_INFO("現價"));
  });
  check("GET_TAIEX_FUTURES_INFO(\"現價\") 回傳數字", function() {
    return isNumber(GET_TAIEX_FUTURES_INFO("現價"));
  });

  var failed = results.filter(function(r) { return !r.pass; });
  var summary = "自我測試完成：共 " + results.length + " 項，通過 " +
    (results.length - failed.length) + " 項，失敗 " + failed.length + " 項。";

  Logger.log(summary);
  if (failed.length) {
    Logger.log("失敗項目：\n" + failed.map(function(r) {
      return "- " + r.name + (r.error ? "：" + r.error : "");
    }).join("\n"));
  }
  Logger.log(JSON.stringify(results, null, 2));

  return summary + (failed.length
    ? "\n失敗：" + failed.map(function(r) { return r.name; }).join("; ")
    : "\n全部通過。");
}

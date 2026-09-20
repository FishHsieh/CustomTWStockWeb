# -*- coding: utf-8 -*-
"""
從 Google 試算表「標兵」分頁 (gid=2069040316) 前200列的欄位 U 擷取出的原始代號，
整理成乾淨的股票/ETF清單 (tickers.json)。
來源：使用者的個人投資追蹤表，欄位U = 代號。此腳本只需執行一次來重建 tickers.json；
若使用者更新試算表清單，可重新擷取後改這裡的 RAW_ROWS 再跑一次。
"""
import json
import re
import os

# (row, raw_code) 從試算表「標兵」分頁 column U, row 1-200 擷取
RAW_ROWS = [
    (1,"ㄥ/"),(2,"TPE:IX0001"),(4,"KRX:KOSPI"),(5,"INDEXNIKKEI:NI225"),(6,".IXIC"),
    (7,"INDEXNASDAQ:SOX"),(8,".INX"),(10,"TPE:2330"),(11,"TPE:3711"),(12,"TPE:2454"),
    (14,"TPE:0052"),(15,"TPE:00631L"),(16,"TPE:00685L"),(17,"TPE:0050"),(18,"TPE:00922"),
    (19,"TPE:009816"),(21,"TPE:0056"),(22,"TPE:00919"),(23,"TPE:00918"),(25,"TPE:00947"),
    (26,"TPE:00735"),(27,"TPE:00991A"),(28,"TPE:00981A"),(29,"TPE:00982A"),(31,"TPE:00891"),
    (32,"TPE:00830"),(33,"TPE:00876"),(34,"TPE:00988A"),(35,"TPE:00990A"),(37,"TPE:00646"),
    (38,"TPE:00924"),(39,"TPE:00909"),(40,"TPE:00901"),(42,"KRX:005930"),(43,"KRX:000660"),
    (44,"TPE:5203"),(46,"TPE:2303"),(47,"TPE:2382"),(48,"TPE:2317"),(49,"TPE:3231"),
    (50,"TPE:2376"),(51,"TPE:3702"),(52,"TPE:2301"),(53,"TPE:3034"),(54,"TPE:3481"),
    (55,"8299"),(58,"TPE:00895"),(59,"TPE:00911"),(60,"TPE:009805"),(61,"TPE:00917"),
    (62,"TPE:00885"),(63,"TPE:00757"),(64,"TPE:00910"),(65,"TPE:00896"),(66,"TPE:00965"),
    (67,"TPE:009814"),(68,"TPE:00662"),(69,"009815"),(71,"TPE:2880"),(72,"TPE:2892"),
    (73,"TPE:2886"),(74,"TPE:2801"),(75,"TPE:5880"),(76,"TPE:2834"),(78,"TPE:2855"),
    (79,"TPE:2887"),(80,"TPE:2881"),(81,"TPE:2882"),(83,"TPE:2883"),(84,"TPE:2891"),
    (85,"TPE:2885"),(86,"TPE:6005"),(88,"TPE:2890"),(89,"TPE:2884"),(90,"TPE:2812"),
    (91,"TPE:2845"),(92,"TPE:5876"),(93,"TPE:2850"),(94,"TPE:2851"),(96,"TPE:00635U"),
    (97,"TPE:00738U"),(98,"TPE:00763u"),(99,"TPE:7610"),(100,"TPE:1605"),(101,"TPE:2009"),
    (103,"TPE:00642U"),(104,"TPE:00715L"),(107,"TPE:00878"),(108,"TPE:00900"),(109,"TPE:00713"),
    (110,"TPE:00915"),(111,"TPE:00701"),(113,"TPE:00992A"),(114,"00998A"),(115,"TPE:00403A"),
    (117,"TPE:00945b"),(118,"TPE:00953b"),(120,"00720B"),(121,"00725B"),(122,"00933B"),
    (123,"00937B"),(125,"00764B"),(126,"TPE:00688l"),(127,"00679B"),(128,"00687B"),
    (129,"00719B"),(130,"00795B"),(131,"00981B"),(133,"TPE:2408"),(134,"TPE:2344"),
    (135,"TPE:2337"),(136,"TPE:3017"),(137,"TPE:3443"),(138,"6274"),(139,"TPE:2059"),
    (140,"TPE:2383"),(141,"TPE:2368"),(142,"5439"),(144,"TPE:6669"),(145,"TPE:2308"),
    (146,"TPE:2449"),(147,"TPE:6239"),(148,"TPE:2357"),(149,"TPE:6770"),(150,"TPE:2353"),
    (151,"TPE:2455"),(152,"TPE:2327"),(153,"TPE:3037"),(154,"TPE:3653"),(155,"TPE:4551"),
    (156,"TPE:3019"),(157,"TPE:3481"),(158,"TPE:3008"),(159,"TPE:2464"),(160,"TPE:6285"),
    (161,"TPE:2303"),(162,"TPE:2409"),(163,"TPE:6176"),(165,"TPE:2451"),(166,"TPE:3006"),
    (167,"TPE:8110"),(168,"https://histock.tw/stock/6485"),(169,"3260"),(171,"TPE:2375"),
    (172,"TPE:2492"),(173,"6173"),(174,"8042"),(175,"5328"),(177,"TPE:1513"),(178,"TPE:1519"),
    (179,"TPE:1605"),(180,"TPE:6781"),(181,"TPE:2349"),(182,"TPE:6409"),
    (183,"https://histock.tw/stock/3211"),(184,"4931"),(187,"TPE:3665"),(188,"TPE:6257"),
    (189,"TPE:6442"),(190,"4979"),(193,"TPE:3450"),(194,"TPE:6451"),(195,"TPE:6830"),
    (196,"3587"),(197,"3289"),(198,"3081"),(199,"3265"),(200,"4971"),
]

EXCLUDE_PREFIXES = ("KRX:", "INDEXNIKKEI:", "INDEXNASDAQ:")
EXCLUDE_EXACT = {".IXIC", ".INX", "ㄥ/"}
MACRO_KEEP = {"TPE:IX0001"}  # 台股大盤指數，另外放進總經面板，不算個股/ETF

def normalize(raw):
    raw = raw.strip()
    m = re.match(r"https?://histock\.tw/stock/(\w+)", raw)
    if m:
        return m.group(1).upper()
    if raw.startswith("TPE:"):
        raw = raw[4:]
    return raw.upper()

def classify(code):
    if re.match(r"^00\d{2,4}[A-Z]{0,2}$", code):
        return "etf"
    if re.match(r"^\d{4,6}$", code):
        return "stock"
    return "unknown"

def main():
    seen = {}
    macro = []
    skipped = []
    for row, raw in RAW_ROWS:
        if raw in EXCLUDE_EXACT or raw.startswith(EXCLUDE_PREFIXES):
            continue
        if raw in MACRO_KEEP:
            macro.append({"row": row, "raw": raw, "code": "IX0001", "name": "台股加權指數"})
            continue
        code = normalize(raw)
        kind = classify(code)
        if kind == "unknown":
            skipped.append((row, raw, code))
            continue
        if code not in seen:
            seen[code] = {"code": code, "kind": kind, "first_row": row}

    stocks = sorted([v["code"] for v in seen.values() if v["kind"] == "stock"])
    etfs = sorted([v["code"] for v in seen.values() if v["kind"] == "etf"])

    out = {
        "generated_from": "標兵 tab (gid=2069040316), rows 1-200, column U",
        "stocks": stocks,
        "etfs": etfs,
        "macro_index": macro,
    }

    out_dir = os.path.join(os.path.dirname(__file__), "..", "data")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "tickers.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"stocks: {len(stocks)}, etfs: {len(etfs)}, macro: {len(macro)}")
    if skipped:
        print("skipped (unrecognized):", skipped)
    print("written to", out_path)

if __name__ == "__main__":
    main()

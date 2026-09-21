# -*- coding: utf-8 -*-
"""
把 scripts/watchlist.txt 的追蹤清單整理成 data/tickers.json（給 fetch_data.py 用）。

清單來源是 Google 試算表「殖利率」→「標兵」分頁的 **欄位 U（代號欄）**，整欄全掃、不限列數。

⚠ 歷史教訓：舊版是把代號寫死在這支程式裡，而且只抄了「前200列」，
   結果第200列以後的代號（例如 U244 的 3661 世芯-KY）全部漏掉，網站上看不到。
   現在改成讀 watchlist.txt 這個純文字檔，要增減標的直接改那個檔就好，
   不用動程式，也就不會再有「只抄了一部分」這種事。

用法：
    python scripts/build_tickers.py
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
WATCHLIST = os.path.join(HERE, "watchlist.txt")
OUT_PATH = os.path.join(HERE, "..", "data", "tickers.json")

# 台股大盤指數：不算個股/ETF，另外放進總經面板
MACRO_INDEX = [{"code": "IX0001", "name": "台股加權指數"}]


def read_watchlist():
    """讀 watchlist.txt，回傳代號清單（保持檔案裡的順序、去重）。"""
    if not os.path.exists(WATCHLIST):
        raise SystemExit(f"找不到 {WATCHLIST}，請先建立追蹤清單檔。")
    codes, seen = [], set()
    for lineno, line in enumerate(open(WATCHLIST, encoding="utf-8"), 1):
        line = line.split("#", 1)[0].strip()   # 砍掉 # 之後的註解
        if not line:
            continue
        code = line.upper()
        if not re.fullmatch(r"\d{4,6}[A-Z]{0,2}", code):
            print(f"  ! 第 {lineno} 行看不懂，跳過：{line!r}")
            continue
        if code not in seen:
            seen.add(code)
            codes.append(code)
    return codes


def classify(code):
    """台股 ETF 的代號都是 00 開頭（含 00xxxL 槓桿、00xxxB 債券、00xxxA 主動式）。"""
    return "etf" if re.fullmatch(r"00\d{2,4}[A-Z]{0,2}", code) else "stock"


def main():
    codes = read_watchlist()
    stocks = sorted(c for c in codes if classify(c) == "stock")
    etfs = sorted(c for c in codes if classify(c) == "etf")

    out = {
        "generated_from": "Google 試算表「殖利率」→「標兵」分頁 欄位U（整欄全掃，不限列數）"
                          "；實際清單見 scripts/watchlist.txt",
        "stocks": stocks,
        "etfs": etfs,
        "macro_index": MACRO_INDEX,
    }

    # 保留上次抓到的中文名稱對照，免得重建清單後網站卡片先變成只有代號
    if os.path.exists(OUT_PATH):
        try:
            with open(OUT_PATH, encoding="utf-8") as f:
                old = json.load(f)
            if old.get("names"):
                out["names"] = {c: old["names"][c] for c in (stocks + etfs) if c in old["names"]}
        except Exception:
            pass

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"個股 {len(stocks)} 檔、ETF {len(etfs)} 檔，共 {len(stocks) + len(etfs)} 檔")
    print("寫到", os.path.normpath(OUT_PATH))


if __name__ == "__main__":
    main()

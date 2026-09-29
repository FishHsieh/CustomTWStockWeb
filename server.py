# -*- coding: utf-8 -*-
"""Local-only web server with a small watchlist management API."""
import json
import re
import subprocess
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
WATCHLIST = ROOT / "scripts" / "watchlist.txt"
CODE_RE = re.compile(r"\d{4,6}[A-Z]{0,2}$")
ETF_RE = re.compile(r"00\d{2,4}[A-Z]{0,2}$")


def json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def current_codes():
    codes = []
    if not WATCHLIST.exists():
        return codes
    for line in WATCHLIST.read_text(encoding="utf-8").splitlines():
        code = line.split("#", 1)[0].strip().upper()
        if CODE_RE.fullmatch(code) and code not in codes:
            codes.append(code)
    return codes


def rebuild_tickers():
    return subprocess.run(
        [sys.executable, "scripts/build_tickers.py"], cwd=ROOT,
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
    )


def remove_watchlist_code(code):
    lines = WATCHLIST.read_text(encoding="utf-8").splitlines(keepends=True)
    kept = [line for line in lines if line.split("#", 1)[0].strip().upper() != code]
    WATCHLIST.write_text("".join(kept), encoding="utf-8")
    return rebuild_tickers()


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlparse(self.path).path == "/api/watchlist":
            return json_response(self, 200, {"codes": current_codes()})
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/watchlist/add", "/api/watchlist/add-and-update", "/api/watchlist/update"):
            return json_response(self, 404, {"ok": False, "error": "Not found"})
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 8192)
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, TypeError, json.JSONDecodeError):
            return json_response(self, 400, {"ok": False, "error": "請輸入有效資料"})

        code = str(payload.get("code", "")).strip().upper()
        kind = str(payload.get("kind", "stock")).strip().lower()
        name = str(payload.get("name", "")).strip()
        if not CODE_RE.fullmatch(code):
            return json_response(self, 400, {"ok": False, "error": "代號格式不正確"})
        if kind not in ("stock", "etf"):
            return json_response(self, 400, {"ok": False, "error": "類型不正確"})
        if (kind == "etf") != bool(ETF_RE.fullmatch(code)):
            return json_response(self, 400, {"ok": False, "error": "個股與 ETF 代號類型不一致"})

        newly_added = False
        line = None
        if path.endswith("/add") or path.endswith("/add-and-update"):
            if code not in current_codes():
                safe_name = re.sub(r"\s+", " ", name).strip()
                line = f"{code}   # {safe_name or code}\n"
                with WATCHLIST.open("a", encoding="utf-8") as f:
                    f.write(line)
                newly_added = True
                result = rebuild_tickers()
                if result.returncode != 0:
                    remove_watchlist_code(code)
                    return json_response(self, 500, {"ok": False, "error": result.stderr[-1000:]})
            if path.endswith("/add"):
                return json_response(self, 200, {
                    "ok": True, "added": newly_added,
                    "message": f"{code} 已加入追蹤清單，請抓取行情",
                })

        if code not in current_codes():
            return json_response(self, 404, {"ok": False, "error": f"{code} 尚未加入追蹤清單"})
        stock_path = ROOT / "data" / "stocks" / f"{code}.json"
        previous_mtime_ns = stock_path.stat().st_mtime_ns if stock_path.exists() else 0
        started_ns = time.time_ns()
        try:
            result = subprocess.run(
                [sys.executable, "scripts/fetch_data.py", "--only", code, "--fresh-only"], cwd=ROOT,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900,
            )
        except subprocess.TimeoutExpired:
            error = "抓取時間超過 15 分鐘；沒有使用舊快取冒充新資料"
            if newly_added:
                remove_watchlist_code(code)
            return json_response(self, 504, {"ok": False, "error": error})
        meta_path = ROOT / "data" / "meta.json"
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            stock_mtime_ns = stock_path.stat().st_mtime_ns if stock_path.exists() else 0
            stock_fresh = stock_mtime_ns >= started_ns and stock_mtime_ns > previous_mtime_ns
            complete = meta.get("status") == "complete" and stock_fresh
        except (OSError, ValueError, TypeError):
            complete = False
        if result.returncode != 0 or not complete:
            if result.returncode != 0:
                error = result.stderr[-1500:] or result.stdout[-1500:] or "新資料抓取失敗"
            else:
                error = "未取得完整的新資料；舊快取不會顯示為更新結果"
            if newly_added:
                remove_watchlist_code(code)
            return json_response(self, 500, {"ok": False, "error": error})
        if name:
            tickers_path = ROOT / "data" / "tickers.json"
            try:
                tickers = json.loads(tickers_path.read_text(encoding="utf-8"))
                tickers.setdefault("names", {})[code] = re.sub(r"\s+", " ", name).strip()
                tickers_path.write_text(json.dumps(tickers, ensure_ascii=False, indent=2), encoding="utf-8")
            except (OSError, ValueError, TypeError):
                pass
        return json_response(self, 200, {"ok": True, "message": f"{code} 資料更新完成", "output": result.stdout[-2000:]})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8765), Handler)
    print("Local stock site: http://localhost:8765/index.html", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

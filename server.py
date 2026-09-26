# -*- coding: utf-8 -*-
"""Local-only web server with a small watchlist management API."""
import json
import re
import subprocess
import sys
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


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if urlparse(self.path).path == "/api/watchlist":
            return json_response(self, 200, {"codes": current_codes()})
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/watchlist/add", "/api/watchlist/update"):
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

        if path.endswith("/add"):
            if code in current_codes():
                return json_response(self, 200, {"ok": True, "added": False, "message": f"{code} 已在追蹤清單"})
            line = f"{code}   # {name or code}\n"
            with WATCHLIST.open("a", encoding="utf-8") as f:
                f.write(line)
            result = subprocess.run(
                [sys.executable, "scripts/build_tickers.py"], cwd=ROOT,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
            )
            if result.returncode != 0:
                text = WATCHLIST.read_text(encoding="utf-8")
                WATCHLIST.write_text(text.removesuffix(line), encoding="utf-8")
                return json_response(self, 500, {"ok": False, "error": result.stderr[-1000:]})
            return json_response(self, 200, {"ok": True, "added": True, "message": f"已加入 {code}，請按更新資料抓取行情"})

        if code not in current_codes():
            return json_response(self, 404, {"ok": False, "error": f"{code} 尚未加入追蹤清單"})
        try:
            result = subprocess.run(
                [sys.executable, "scripts/fetch_data.py", "--only", code], cwd=ROOT,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900,
            )
        except subprocess.TimeoutExpired:
            return json_response(self, 504, {"ok": False, "error": "抓取時間超過 15 分鐘，請查看命令視窗或稍後重新整理"})
        if result.returncode != 0:
            return json_response(self, 500, {"ok": False, "error": result.stderr[-1500:] or result.stdout[-1500:]})
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

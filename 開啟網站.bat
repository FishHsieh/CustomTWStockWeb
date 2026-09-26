@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在啟動本機網頁伺服器...
start "" http://localhost:8765/index.html
python server.py

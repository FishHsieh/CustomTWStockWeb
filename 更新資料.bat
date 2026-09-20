@echo off
chcp 65001 >nul
cd /d "%~dp0"
python scripts\fetch_data.py
echo.
echo 完成！按任意鍵關閉這個視窗。
pause >nul

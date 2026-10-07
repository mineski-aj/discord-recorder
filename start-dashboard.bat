@echo off
cd /d "%~dp0"
start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:3000"
node dashboard.js
pause

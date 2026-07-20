@echo off
echo Restarting elta-tracker...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
cd /d C:\Users\PC\elta-tracker
start "ELTA Tracker" cmd /c "node server.js"
echo Server started on http://localhost:3000
timeout /t 2 >nul

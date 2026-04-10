@echo off
setlocal

cd /d "%~dp0"

echo ===================================
echo Iniciando dashboard Next.js...
echo ===================================
start "Bitget Dashboard" cmd /k "cd /d %~dp0 && npm run dev"

timeout /t 2 /nobreak >nul

echo ===================================
echo Iniciando servicio WebSocket marketdata...
echo ===================================
start "Bitget Market Data WS" cmd /k "cd /d %~dp0 && npm run marketdata:start"

echo ===================================
echo Servicios lanzados.
echo - Dashboard: http://localhost:3000
echo - WS Market Data: http://127.0.0.1:8787/health
echo ===================================

endlocal

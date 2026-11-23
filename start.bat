@echo off
echo ===================================================
echo           Starting RealtyDesk CRM
echo ===================================================

echo [1/2] Starting RealtyDesk REST API Server (port 4000)...
start "RealtyDesk Server" cmd /k "cd server && npm run dev"

timeout /t 3 /nobreak >nul

echo [2/2] Starting RealtyDesk Desktop Client (port 1420)...
start "RealtyDesk Client" cmd /k "cd client && npm run dev"

timeout /t 3 /nobreak >nul

echo Opening RealtyDesk in your browser...
start http://localhost:1420

echo.
echo Both services are running:
echo - Client: http://localhost:1420
echo - Server: http://localhost:4000/health
echo.
pause


@echo off
REM Stellar Drift - local dev launcher (LAN-accessible on both localhost and LAN IP)
setlocal EnableDelayedExpansion

cd /d "%~dp0"

echo ============================================
echo   Stellar Drift - Local Dev Server
echo ============================================
echo.

REM Detect package manager
set "PM="
where bun >nul 2>nul && set "PM=bun"
if not defined PM (
    where npm >nul 2>nul && set "PM=npm"
)
if not defined PM (
    echo [ERROR] Neither bun nor npm found. Install Node.js or Bun first.
    echo   Node.js: https://nodejs.org
    echo   Bun:     https://bun.sh
    pause
    exit /b 1
)

echo Using package manager: %PM%
echo.

if not exist "node_modules" (
    echo Installing dependencies, this may take a minute...
    if "%PM%"=="bun" (
        call bun install
    ) else (
        call npm install
    )
)

REM Force Vite to bind on all interfaces (localhost + LAN IP)
set HOST=0.0.0.0
set PORT=8080

echo.
echo ============================================
echo   Open on this PC:    http://localhost:8080
echo   Open on LAN (phone / other PC) - try one of:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=* delims= " %%b in ("%%a") do (
        set "IP=%%b"
        echo     http://!IP!:8080
    )
)
echo ============================================
echo.
echo NOTE: First run will trigger a Windows Firewall prompt.
echo       Click "Allow access" on BOTH Private and Public networks
echo       so phones on the same Wi-Fi can connect.
echo.
echo Starting dev server (Ctrl+C to stop)...
echo.

if "%PM%"=="bun" (
    call bun run dev --host 0.0.0.0 --port 8080
) else (
    call npm run dev -- --host 0.0.0.0 --port 8080
)

pause
endlocal

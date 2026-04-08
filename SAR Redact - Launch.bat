@echo off
title SAR Redact
cd /d "%~dp0"

:: ── Check Python is installed ─────────────────────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo  SAR Redact needs Python 3.10 or later.
    echo  Download it free from: https://www.python.org/downloads/
    echo  Make sure to tick "Add Python to PATH" during installation.
    echo.
    pause
    exit /b 1
)

:: ── Create virtual environment if it doesn't exist ───────────────────────────
if not exist "venv\Scripts\python.exe" (
    echo Setting up SAR Redact for the first time — this takes about a minute...
    python -m venv venv
    if errorlevel 1 (
        echo Failed to create Python environment. Please check your Python installation.
        pause
        exit /b 1
    )
)

:: ── Install / update dependencies ────────────────────────────────────────────
echo Checking dependencies...
venv\Scripts\python -m pip install -q -r requirements.txt --upgrade
if errorlevel 1 (
    echo Failed to install dependencies. Check your internet connection and try again.
    pause
    exit /b 1
)

:: ── Create required folders ───────────────────────────────────────────────────
if not exist "data" mkdir data
if not exist "uploads" mkdir uploads
if not exist "output" mkdir output

:: ── Start the server and open browser ────────────────────────────────────────
echo.
echo  Starting SAR Redact...
echo  Opening http://localhost:5000 in your browser.
echo.
echo  To stop the server, close this window.
echo.

:: Open browser after a short delay
start "" /B cmd /c "timeout /t 2 >nul && start http://localhost:5000"

:: Start server
venv\Scripts\python serve.py

pause

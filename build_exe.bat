@echo off
title Building SAR Redact EXE
cd /d "%~dp0"
echo Installing PyInstaller...
venv\Scripts\pip install pyinstaller -q
echo Building executable (this takes a few minutes)...
venv\Scripts\pyinstaller SAR_Redact.spec --clean --noconfirm
echo.
echo Done! Find "SAR Redact.exe" in the dist\ folder.
pause

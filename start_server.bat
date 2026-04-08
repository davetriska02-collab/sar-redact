@echo off
title SAR Redact — Production Server
cd /d "%~dp0"
echo Starting SAR Redact server...
venv\Scripts\python serve.py
pause

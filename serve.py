"""
Production launcher — use this instead of app.py for deployment.
Runs the app on Waitress (multi-threaded, production-grade WSGI server).

Binds to localhost only (127.0.0.1) to avoid Windows Firewall prompts.
Each user runs their own instance on their own machine.
"""
import os
from waitress import serve
from app import app

HOST = "127.0.0.1"  # Localhost only — no firewall prompt
PORT = int(os.environ.get("PORT", 5000))

if __name__ == "__main__":
    print("=" * 55)
    print("  SAR Redact — Starting")
    print("=" * 55)
    print(f"  Open your browser at: http://localhost:{PORT}")
    print("=" * 55)
    print("  Press Ctrl+C or close this window to stop.\n")

    serve(app, host=HOST, port=PORT, threads=8)

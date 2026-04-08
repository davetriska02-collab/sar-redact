# SAR Redact

A desktop tool for NHS GP practices to process Subject Access Requests (SARs). Detects and redacts third-party PII from patient record PDFs, with a reviewer workflow and full audit log.

## Quick Start (Windows)

1. Install Python 3.10 or later from [python.org](https://www.python.org/downloads/) — tick **"Add Python to PATH"** during setup
2. Download this repository — click the green **Code** button → **Download ZIP** → extract the folder
3. Double-click **`SAR Redact - Launch.bat`**

The launcher sets up everything automatically on first run (creates a virtual environment, installs dependencies) and opens the app in your browser.

## What It Does

- Upload patient record PDFs (including RTF exports from clinical systems)
- Automatically detects names, NHS numbers, addresses, phone numbers, postcodes, emails, and more
- Review detected items page-by-page: approve, reject, or add manual redactions
- Finalise to generate redacted PDFs and a full audit log
- Export/import `.sarpack` files to hand SARs between colleagues

## Requirements

- Windows 10 or 11
- Python 3.10+ ([download here](https://www.python.org/downloads/))
- Internet connection on first launch (to download dependencies)

## Notes

- Runs entirely on your local machine — no data leaves your computer
- Data is stored in the `data/` folder within the app directory
- Default login: username `admin`, password `password` — change this on first use via Account settings

## Licence

Built for NHS general practice use. Not for commercial distribution.

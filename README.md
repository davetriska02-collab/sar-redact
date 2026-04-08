# SAR Redact

A desktop tool for NHS GP practices to process Subject Access Requests (SARs). Detects and redacts third-party PII from patient record PDFs, with a reviewer workflow and full audit log.

---

## ⬇️ Download

**[⬇️ Click here to download SAR Redact v1.0](https://github.com/davetriska02-collab/sar-redact/releases/latest/download/SAR.Redact.zip)**

Or visit the [Releases page](https://github.com/davetriska02-collab/sar-redact/releases) and download `SAR.Redact.zip`.

---

## Getting Started

### Step 1 — Install Python (one-time setup)

SAR Redact needs Python to run. If you have not installed it before:

1. Go to [python.org/downloads](https://www.python.org/downloads/) and click **Download Python**
2. Run the installer — **tick the box that says "Add Python to PATH"** before clicking Install
3. You only need to do this once

### Step 2 — Download and run SAR Redact

1. Download `SAR.Redact.zip` using the link above
2. Extract (unzip) the folder somewhere convenient — e.g. your Desktop
3. Double-click **`SAR Redact - Launch.bat`**

The launcher sets everything else up automatically on first run and opens the app in your browser.

---

## What It Does

- Upload patient record PDFs (including RTF exports from clinical systems)
- Automatically detects names, NHS numbers, addresses, phone numbers, postcodes, emails, safeguarding flags, and more
- Review detected items page-by-page: approve, reject, or draw manual redaction boxes
- Finalise to generate redacted PDFs and a full audit log
- Export/import `.sarpack` files to hand SARs between colleagues over NHSmail

---

## Requirements

- Windows 10 or 11
- Python 3.10 or later (free — see Step 1 above)
- Internet connection on first launch only (to download dependencies)

---

## Notes

- Runs entirely on your local machine — no data leaves your computer
- Data is stored in the `data/` folder within the app directory
- Default login: username `admin`, password `password` — change this on first use via Account settings
- Send `.sarpack` files via NHSmail only — they contain patient data

---

## Licence

Built for NHS general practice use. Not for commercial distribution.

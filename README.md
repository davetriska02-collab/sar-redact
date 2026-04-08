# SAR Redact

A desktop tool for NHS GP practices to process Subject Access Requests (SARs). Detects and redacts third-party PII from patient record PDFs, with a reviewer workflow and full audit log.

Built for use with **Medicus EPR** — handles PDF exports from the Medicus patient record directly.

---

## ⬇️ Download

**[⬇️ Click here to download SAR Redact v1.0](https://github.com/davetriska02-collab/sar-redact/releases/latest/download/SAR.Redact.exe)**

Or visit the [Releases page](https://github.com/davetriska02-collab/sar-redact/releases) and download `SAR.Redact.exe`.

---

## Getting Started

1. Download `SAR.Redact.exe` using the link above
2. Double-click it — the app opens in your browser automatically

No Python, no installation, no setup. Everything is bundled inside the single file.

---

## What It Does

- Upload patient record PDFs exported from Medicus (or any other clinical system)
- Automatically detects names, NHS numbers, addresses, phone numbers, postcodes, emails, safeguarding flags, and more
- Review detected items page-by-page: approve, reject, or draw manual redaction boxes
- Finalise to generate redacted PDFs and a full audit log
- Export/import `.sarpack` files to hand SARs between colleagues over NHSmail

---

## Requirements

- Windows 10 or 11
- No Python or other software needed — everything is bundled

---

## Notes

- Runs entirely on your local machine — no data leaves your computer
- Data is stored in the `data/` folder within the app directory
- Default login: username `admin`, password `password` — change this on first use via Account settings
- Send `.sarpack` files via NHSmail only — they contain patient data

---

## Licence

Built for NHS general practice use. Not for commercial distribution.

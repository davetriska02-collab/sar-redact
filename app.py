import io
import os
import re
import json
import shutil
import zipfile
import threading
from queue import Queue, Empty
from datetime import datetime, timedelta, timezone
from functools import wraps
from flask import (
    Flask, render_template, request, jsonify,
    send_file, Response, redirect, url_for, session, g,
)
from werkzeug.utils import secure_filename
from werkzeug.security import check_password_hash

APP_VERSION = "1.0"
SARPACK_FORMAT_VERSION = "1"

# ── PyInstaller frozen-path detection ────────────────────────────────────────
import sys as _sys
import os as _os
if getattr(_sys, 'frozen', False):
    # Running as a PyInstaller bundle — templates/static live in _MEIPASS temp dir
    _BASE_DIR = _sys._MEIPASS
    # Data directories (uploads, output, data) must live next to the .exe, not in temp
    _DATA_ROOT = _os.path.dirname(_sys.executable)
else:
    _BASE_DIR = _os.path.dirname(_os.path.abspath(__file__))
    _DATA_ROOT = _os.path.dirname(_os.path.abspath(__file__))

from sar.models import SARRequest, SubjectDetails, RedactionStatus, PIICategory, RedactionCandidate, DetectionSettings
from sar.pdf_parser import extract_text_spans, render_page_image, get_page_count, get_full_page_text
from sar.detector import detect_pii
from sar.redactor import apply_redactions
from sar.redaction_log import generate_redaction_log
from sar.staff_list import get_staff_list, add_staff_member, remove_staff_member
from sar.custom_words import get_custom_words, add_custom_word, remove_custom_word
from sar.risk_words import check_text_for_risk
from sar.date_extractor import extract_document_date, extract_date_from_filename
from sar.keyword_scanner import scan_keywords
from sar.users import (
    get_user_by_id, authenticate, create_user, get_all_users,
    get_gp_users, set_password, delete_user, users_file_exists,
    get_user_by_username,
)

app = Flask(__name__,
    template_folder=os.path.join(_BASE_DIR, 'templates'),
    static_folder=os.path.join(_BASE_DIR, 'static'))

# Persistent secret key so sessions survive app restarts
_SECRET_KEY_PATH = os.path.join(_DATA_ROOT, "data", ".secret_key")

def _get_or_create_secret_key() -> bytes:
    os.makedirs(os.path.dirname(_SECRET_KEY_PATH), exist_ok=True)
    if os.path.exists(_SECRET_KEY_PATH):
        with open(_SECRET_KEY_PATH, "rb") as f:
            return f.read()
    key = os.urandom(32)
    with open(_SECRET_KEY_PATH, "wb") as f:
        f.write(key)
    return key

app.secret_key = _get_or_create_secret_key()


@app.template_filter('fdate')
def format_date(value):
    """Format an ISO date string as '10 Mar 2024'."""
    if not value:
        return ''
    try:
        dt = datetime.fromisoformat(str(value)[:10])
        # Use platform-safe day formatting (no leading zero)
        import platform
        fmt = '%#d %b %Y' if platform.system() == 'Windows' else '%-d %b %Y'
        return dt.strftime(fmt)
    except (ValueError, AttributeError):
        return str(value)[:10]

# ── Background job progress tracking ─────────────────────────────────────────
# Maps job_id → Queue of progress dicts. Each dict is one SSE event.
# Cleared when the terminal event (done/error) is dequeued by the stream endpoint.
_job_queues: dict[str, Queue] = {}

def _new_job() -> tuple[str, Queue]:
    """Create a new background job, returning (job_id, queue)."""
    import uuid as _uuid
    job_id = str(_uuid.uuid4())[:12]
    q: Queue = Queue()
    _job_queues[job_id] = q
    return job_id, q

def _emit(q: Queue, progress: float, step: str) -> None:
    """Push a progress event onto the job queue."""
    q.put({"progress": round(progress, 3), "step": step})

UPLOAD_DIR = os.path.join(_DATA_ROOT, "uploads")
OUTPUT_DIR = os.path.join(_DATA_ROOT, "output")
SAR_DATA_DIR = os.path.join(_DATA_ROOT, "data", "sars")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(SAR_DATA_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {"pdf", "tif", "tiff", "rtf", "txt", "zip", "png", "jpg", "jpeg", "html", "htm", "cdax"}


def _convert_tif_to_pdf(tif_path: str) -> str:
    """Convert a TIF/TIFF file to PDF in the same directory. Returns the PDF path."""
    import fitz as _fitz
    doc = _fitz.open(tif_path)
    pdf_bytes = doc.convert_to_pdf()
    doc.close()
    pdf_path = os.path.splitext(tif_path)[0] + ".pdf"
    with open(pdf_path, "wb") as f:
        f.write(pdf_bytes)
    os.remove(tif_path)
    return pdf_path


def _convert_txt_to_pdf(txt_path: str) -> str:
    """Convert a TXT file to PDF using PyMuPDF. Returns the PDF path."""
    import fitz as _fitz
    with open(txt_path, "r", encoding="utf-8", errors="replace") as f:
        text_content = f.read()

    doc = _fitz.open()
    fontsize = 10
    margin = 50
    line_height = fontsize * 1.4
    page_width, page_height = 595, 842  # A4

    page = None
    y_pos = page_height  # Force first page creation

    for line in text_content.split('\n'):
        if y_pos + line_height > page_height - margin:
            page = doc.new_page(width=page_width, height=page_height)
            y_pos = margin + fontsize
        page.insert_text(
            _fitz.Point(margin, y_pos),
            line[:300],
            fontsize=fontsize,
            fontname="helv",
        )
        y_pos += line_height

    if len(doc) == 0:
        doc.new_page()

    pdf_path = os.path.splitext(txt_path)[0] + ".pdf"
    doc.save(pdf_path)
    doc.close()
    os.remove(txt_path)
    return pdf_path


def _convert_rtf_to_pdf(rtf_path: str) -> str:
    """Convert an RTF file to PDF by stripping formatting and rendering as text. Returns the PDF path."""
    from striprtf.striprtf import rtf_to_text
    with open(rtf_path, "r", encoding="utf-8", errors="replace") as f:
        rtf_content = f.read()
    plain_text = rtf_to_text(rtf_content)
    # Write as temp TXT then convert
    txt_path = os.path.splitext(rtf_path)[0] + ".txt"
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(plain_text)
    os.remove(rtf_path)
    return _convert_txt_to_pdf(txt_path)


def _convert_image_to_pdf(img_path: str) -> str:
    """Convert a PNG/JPG image to PDF using PyMuPDF. Returns the PDF path."""
    import fitz as _fitz
    doc = _fitz.open(img_path)
    pdf_bytes = doc.convert_to_pdf()
    doc.close()
    pdf_path = os.path.splitext(img_path)[0] + ".pdf"
    with open(pdf_path, "wb") as f:
        f.write(pdf_bytes)
    os.remove(img_path)
    return pdf_path


def _convert_html_to_pdf(html_path: str) -> str:
    """Convert an HTML file to PDF by extracting text and rendering. Returns the PDF path."""
    from html.parser import HTMLParser

    class _TextExtractor(HTMLParser):
        def __init__(self):
            super().__init__()
            self.parts: list[str] = []
            self._skip = False

        def handle_starttag(self, tag, attrs):
            if tag in ("style", "script"):
                self._skip = True
            elif tag in ("br", "p", "div", "tr", "h1", "h2", "h3", "h4", "li", "th", "td"):
                self.parts.append("\n")

        def handle_endtag(self, tag):
            if tag in ("style", "script"):
                self._skip = False

        def handle_data(self, data):
            if not self._skip:
                self.parts.append(data)

    with open(html_path, "r", encoding="utf-8", errors="replace") as f:
        html_content = f.read()

    parser = _TextExtractor()
    parser.feed(html_content)
    plain_text = "".join(parser.parts)

    txt_path = os.path.splitext(html_path)[0] + ".txt"
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(plain_text)
    os.remove(html_path)
    return _convert_txt_to_pdf(txt_path)


def _convert_cdax_to_pdf(cdax_path: str) -> str:
    """Convert an NHS CDAX (HL7 CDA XML) file to PDF by extracting clinical text. Returns the PDF path."""
    import xml.etree.ElementTree as ET

    with open(cdax_path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    lines: list[str] = []
    try:
        # Strip XML namespaces for easier parsing
        content_clean = re.sub(r'\sxmlns[^"]*"[^"]*"', "", content)
        root = ET.fromstring(content_clean)

        # Title
        title = root.findtext(".//title") or "NHS Clinical Document"
        lines.append(title)
        lines.append("=" * len(title))
        lines.append("")

        # Effective time
        eff = root.find(".//effectiveTime")
        if eff is not None and eff.get("value"):
            val = eff.get("value", "")
            if len(val) >= 8:
                lines.append(f"Date: {val[6:8]}/{val[4:6]}/{val[:4]}")
                lines.append("")

        # Patient info
        patient = root.find(".//patientRole")
        if patient is not None:
            name_el = patient.find(".//patient//name")
            if name_el is not None:
                given = name_el.findtext("given", "")
                family = name_el.findtext("family", "")
                lines.append(f"Patient: {given} {family}")
            dob = patient.find(".//patient//birthTime")
            if dob is not None and dob.get("value"):
                val = dob.get("value", "")
                if len(val) >= 8:
                    lines.append(f"DOB: {val[6:8]}/{val[4:6]}/{val[:4]}")
            nhs_id = patient.find('.//id[@root="2.16.840.1.113883.2.1.4.1"]')
            if nhs_id is not None:
                lines.append(f"NHS Number: {nhs_id.get('extension', '')}")
            addr = patient.find(".//addr")
            if addr is not None:
                addr_parts = [el.text for el in addr if el.text]
                if addr_parts:
                    lines.append(f"Address: {', '.join(addr_parts)}")
            lines.append("")

        # Extract all readable text from the document body
        for el in root.iter():
            if el.tag == "title" and el.text and el != root.find(".//title"):
                lines.append(f"\n{el.text}")
                lines.append("-" * len(el.text))
            if el.tag in ("paragraph", "content", "item"):
                text = "".join(el.itertext()).strip()
                if text:
                    lines.append(text)

    except ET.ParseError:
        # Fallback: strip XML tags and render as plain text
        lines.append(re.sub(r"<[^>]+>", " ", content))

    txt_path = os.path.splitext(cdax_path)[0] + ".txt"
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    os.remove(cdax_path)
    return _convert_txt_to_pdf(txt_path)


def _convert_single_file(filepath: str, ext: str) -> str:
    """Convert a single file to PDF based on extension. Returns the PDF path."""
    if ext in ("tif", "tiff"):
        return _convert_tif_to_pdf(filepath)
    elif ext == "rtf":
        return _convert_rtf_to_pdf(filepath)
    elif ext == "txt":
        return _convert_txt_to_pdf(filepath)
    elif ext in ("png", "jpg", "jpeg"):
        return _convert_image_to_pdf(filepath)
    elif ext in ("html", "htm"):
        return _convert_html_to_pdf(filepath)
    elif ext == "cdax":
        return _convert_cdax_to_pdf(filepath)
    else:
        return filepath  # PDF — no conversion needed


def _extract_zip_to_pdfs(zip_path: str, sar_dir: str, emit_fn=None) -> list[str]:
    """Unpack a ZIP file, convert all supported files to PDF in parallel.
    Returns list of PDF paths. Optional emit_fn(done_count, total) for progress."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    SUPPORTED = {"pdf", "tif", "tiff", "rtf", "txt", "png", "jpg", "jpeg", "html", "htm", "cdax"}
    extracted: list[tuple[str, str]] = []  # (filepath, ext)

    # Phase 1: extract all files from ZIP to disk
    with zipfile.ZipFile(zip_path, "r") as zf:
        for member in zf.infolist():
            if member.is_dir() or member.file_size == 0:
                continue
            basename = os.path.basename(member.filename)
            if not basename or basename.startswith('.'):
                continue
            ext = basename.rsplit(".", 1)[-1].lower() if "." in basename else ""
            if ext not in SUPPORTED:
                continue

            safe_name = secure_filename(basename)
            if not safe_name:
                continue
            # Handle name collisions from different subdirectories
            dest = os.path.join(sar_dir, safe_name)
            counter = 1
            name_part, ext_part = os.path.splitext(safe_name)
            while os.path.exists(dest):
                dest = os.path.join(sar_dir, f"{name_part}_{counter}{ext_part}")
                counter += 1

            with zf.open(member) as src, open(dest, "wb") as dst:
                dst.write(src.read())
            extracted.append((dest, ext))

    os.remove(zip_path)

    # Phase 2: convert to PDF in parallel, preserving original ZIP entry order
    n = len(extracted)
    results: dict[int, str] = {}   # original_index → converted pdf path
    completed = 0

    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(_convert_single_file, fp, ext): i
            for i, (fp, ext) in enumerate(extracted)
        }
        for future in as_completed(futures):
            i = futures[future]
            try:
                results[i] = future.result()
            except Exception as e:
                print(f"Warning: conversion failed for file #{i}: {e}")
            completed += 1
            if emit_fn:
                emit_fn(completed, n)

    # Return in original ZIP order (preserves NHS record chronology from the export)
    return [results[i] for i in sorted(results.keys())]


# ─── Persistence ─────────────────────────────────────────────────────────────

def _save_sar(sar: SARRequest) -> None:
    """Persist a SAR to disk as JSON."""
    sar.last_modified = datetime.now(timezone.utc).isoformat()
    data = {
        "id": sar.id,
        "created_at": sar.created_at,
        "last_modified": sar.last_modified,
        "status": sar.status,
        "due_date": sar.due_date,
        "notes": sar.notes,
        "workflow_status": sar.workflow_status,
        "allocated_to": sar.allocated_to,
        "allocated_to_name": sar.allocated_to_name,
        "clock_paused": sar.clock_paused,
        "paused_at": sar.paused_at,
        "total_paused_days": sar.total_paused_days,
        "pause_log": sar.pause_log,
        "subject": {
            "full_name": sar.subject.full_name,
            "first_name": sar.subject.first_name,
            "last_name": sar.subject.last_name,
            "nhs_number": sar.subject.nhs_number,
            "date_of_birth": sar.subject.date_of_birth,
            "address": sar.subject.address,
            "phone": sar.subject.phone,
            "email": sar.subject.email,
            "aliases": sar.subject.aliases,
        },
        "detection_settings": {
            "auto_redact_threshold": sar.detection_settings.auto_redact_threshold,
            "flag_threshold": sar.detection_settings.flag_threshold,
            "enabled_categories": sar.detection_settings.enabled_categories,
        },
        "document_dates": sar.document_dates,
        "file_order": sar.file_order,
        "main_record_file": sar.main_record_file,
        "pdf_files": sar.pdf_files,
        "candidates": [
            {
                "id": c.id,
                "text": c.text,
                "category": c.category.value,
                "status": c.status.value,
                "confidence": c.confidence,
                "page_num": c.page_num,
                "x0": c.x0, "y0": c.y0, "x1": c.x1, "y1": c.y1,
                "reason": c.reason,
                "exemption_code": c.exemption_code,
                "risk_flags": c.risk_flags,
                "source_file": c.source_file,
            }
            for c in sar.candidates
        ],
    }
    path = os.path.join(SAR_DATA_DIR, f"{sar.id}.json")
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def _load_all_sars() -> None:
    """Load all persisted SARs into active_requests on startup."""
    for fname in os.listdir(SAR_DATA_DIR):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(SAR_DATA_DIR, fname)) as f:
                data = json.load(f)
            subject = SubjectDetails(**data["subject"])
            candidates = [
                RedactionCandidate(
                    id=c["id"],
                    text=c["text"],
                    category=PIICategory(c["category"]),
                    status=RedactionStatus(c["status"]),
                    confidence=c["confidence"],
                    page_num=c["page_num"],
                    x0=c["x0"], y0=c["y0"], x1=c["x1"], y1=c["y1"],
                    reason=c["reason"],
                    exemption_code=c.get("exemption_code", ""),
                    risk_flags=c.get("risk_flags", []),
                    source_file=c["source_file"],
                )
                for c in data["candidates"]
            ]
            sar = SARRequest(
                id=data["id"],
                created_at=data.get("created_at", ""),
                last_modified=data.get("last_modified", data.get("created_at", "")),
                subject=subject,
                pdf_files=data["pdf_files"],
                candidates=candidates,
                status=data["status"],
                due_date=data.get("due_date", ""),
                notes=data.get("notes", ""),
                workflow_status=data.get("workflow_status", "new"),
                allocated_to=data.get("allocated_to", ""),
                allocated_to_name=data.get("allocated_to_name", ""),
                document_dates=data.get("document_dates", {}),
                file_order=data.get("file_order", []),
                main_record_file=data.get("main_record_file", ""),
                clock_paused=data.get("clock_paused", False),
                paused_at=data.get("paused_at", ""),
                total_paused_days=data.get("total_paused_days", 0),
                pause_log=data.get("pause_log", []),
            )
            # Load detection settings if present
            ds = data.get("detection_settings")
            if ds:
                sar.detection_settings = DetectionSettings(
                    auto_redact_threshold=ds.get("auto_redact_threshold", 0.80),
                    flag_threshold=ds.get("flag_threshold", 0.50),
                    enabled_categories=ds.get("enabled_categories",
                        DetectionSettings().enabled_categories),
                )
            if not sar.due_date:
                sar.compute_due_date()
            # Retroactively compute risk flags for existing candidates
            for cand in candidates:
                if not cand.risk_flags and cand.text:
                    cand.risk_flags = check_text_for_risk(cand.text)
            active_requests[sar.id] = sar
        except Exception as e:
            print(f"Warning: could not load SAR {fname}: {e}")


# In-memory store for active SAR requests
active_requests: dict[str, SARRequest] = {}
_load_all_sars()


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ─── Auth Infrastructure ─────────────────────────────────────────────────────

@app.before_request
def load_current_user():
    """Set g.current_user on every request from the session."""
    g.current_user = None
    user_id = session.get("user_id")
    if user_id:
        g.current_user = get_user_by_id(user_id)
    # If no users exist yet, redirect everything to setup (except setup/static itself)
    PUBLIC_ENDPOINTS = {"login", "setup", "static"}
    if not users_file_exists() and request.endpoint not in PUBLIC_ENDPOINTS:
        return redirect(url_for("setup"))


@app.context_processor
def inject_user():
    return {"current_user": g.current_user}


def require_login(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if g.current_user is None:
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated


def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if g.current_user is None:
            return redirect(url_for("login"))
        if g.current_user.role != "admin":
            return render_template("403.html"), 403
        return f(*args, **kwargs)
    return decorated


# ─── Auth Routes ─────────────────────────────────────────────────────────────

@app.route("/login", methods=["GET", "POST"])
def login():
    if not users_file_exists():
        return redirect(url_for("setup"))
    if g.current_user:
        return redirect(url_for("dashboard"))
    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = authenticate(username, password)
        if user:
            session["user_id"] = user.id
            return redirect(url_for("dashboard"))
        error = "Invalid username or password."
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.pop("user_id", None)
    return redirect(url_for("login"))


@app.route("/setup", methods=["GET", "POST"])
def setup():
    """First-run setup: create the initial admin account."""
    if users_file_exists():
        return redirect(url_for("login"))
    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        display_name = request.form.get("display_name", "").strip()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm_password", "")
        if not username or not display_name or not password:
            error = "All fields are required."
        elif password != confirm:
            error = "Passwords do not match."
        elif len(password) < 8:
            error = "Password must be at least 8 characters."
        else:
            create_user(username, display_name, "admin", password, is_superuser=True)
            return redirect(url_for("login"))
    return render_template("setup.html", error=error)


# ─── Account Routes ───────────────────────────────────────────────────────────

@app.route("/help")
@require_login
def help_page():
    return render_template("help.html")


@app.route("/account")
@require_login
def account():
    return render_template("account.html")


@app.route("/account/change-password", methods=["POST"])
@require_login
def change_password():
    current_pw = request.form.get("current_password", "")
    new_pw = request.form.get("new_password", "")
    confirm_pw = request.form.get("confirm_password", "")
    if not check_password_hash(g.current_user.password_hash, current_pw):
        return render_template("account.html", error="Current password is incorrect.")
    if new_pw != confirm_pw:
        return render_template("account.html", error="New passwords do not match.")
    if len(new_pw) < 8:
        return render_template("account.html", error="Password must be at least 8 characters.")
    set_password(g.current_user.id, new_pw)
    return render_template("account.html", success="Password updated successfully.")


# ─── Admin User Management ────────────────────────────────────────────────────

@app.route("/admin/users")
@require_admin
def admin_users():
    users = [
        {
            "id": u.id,
            "username": u.username,
            "display_name": u.display_name,
            "role": u.role,
            "is_superuser": u.is_superuser,
        }
        for u in get_all_users()
    ]
    return render_template("admin/users.html", users=users)


@app.route("/admin/users/create", methods=["POST"])
@require_admin
def admin_create_user():
    username = request.form.get("username", "").strip()
    display_name = request.form.get("display_name", "").strip()
    role = request.form.get("role", "gp")
    password = request.form.get("password", "")
    is_superuser = request.form.get("is_superuser") == "on"
    errors = []
    if not username:
        errors.append("Username is required.")
    if not display_name:
        errors.append("Display name is required.")
    if not password or len(password) < 8:
        errors.append("Password must be at least 8 characters.")
    if get_user_by_username(username):
        errors.append("Username already exists.")
    if errors:
        users = [
            {"id": u.id, "username": u.username, "display_name": u.display_name,
             "role": u.role, "is_superuser": u.is_superuser}
            for u in get_all_users()
        ]
        return render_template("admin/users.html", users=users, errors=errors)
    create_user(username, display_name, role, password, is_superuser)
    return redirect(url_for("admin_users"))


@app.route("/admin/users/<user_id>/reset-password", methods=["POST"])
@require_admin
def admin_reset_password(user_id):
    data = request.json or {}
    new_pw = data.get("new_password", "")
    if len(new_pw) < 8:
        return jsonify({"error": "Password must be at least 8 characters."}), 400
    if not set_password(user_id, new_pw):
        return jsonify({"error": "User not found."}), 404
    return jsonify({"ok": True})


@app.route("/admin/users/<user_id>/delete", methods=["POST"])
@require_admin
def admin_delete_user(user_id):
    if user_id == g.current_user.id:
        return jsonify({"error": "You cannot delete your own account."}), 400
    if not delete_user(user_id):
        return jsonify({"error": "User not found."}), 404
    return redirect(url_for("admin_users"))


# ─── Page Routes ────────────────────────────────────────────────────────────

@app.route("/")
@require_login
def dashboard():
    sars = sorted(active_requests.values(), key=lambda s: s.created_at, reverse=True)
    # Build summary stats for each SAR
    sar_summaries = []
    for sar in sars:
        auto = sum(1 for c in sar.candidates if c.status == RedactionStatus.AUTO_REDACT)
        flagged = sum(1 for c in sar.candidates if c.status == RedactionStatus.FLAGGED)
        approved = sum(1 for c in sar.candidates if c.status == RedactionStatus.APPROVED)
        total = len(sar.candidates)
        reviewed = sum(1 for c in sar.candidates if c.status in (
            RedactionStatus.AUTO_REDACT, RedactionStatus.APPROVED,
            RedactionStatus.REJECTED, RedactionStatus.EXCLUDED_SUBJECT,
            RedactionStatus.EXCLUDED_STAFF,
        ))
        sar_summaries.append({
            "sar": sar,
            "auto": auto,
            "flagged": flagged,
            "approved": approved,
            "file_count": len(sar.pdf_files),
            "total_candidates": total,
            "reviewed": reviewed,
            "days_remaining": sar.days_remaining,
        })
    # Aggregate stats for hero
    total_requests = len(sar_summaries)
    reviewing_count = sum(1 for s in sar_summaries if s["sar"].status == "reviewing")
    complete_count = sum(1 for s in sar_summaries if s["sar"].status == "complete")
    overdue_count = sum(1 for s in sar_summaries if s["days_remaining"] < 0 and s["sar"].status != "complete")
    return render_template("dashboard.html",
                           sar_summaries=sar_summaries,
                           gp_users=get_gp_users(),
                           total_requests=total_requests,
                           reviewing_count=reviewing_count,
                           complete_count=complete_count,
                           overdue_count=overdue_count)


@app.route("/new")
@require_login
def new_sar_page():
    return render_template("index.html")


@app.route("/review/<sar_id>")
@require_login
def review(sar_id):
    sar = active_requests.get(sar_id)
    if not sar:
        return "SAR request not found", 404

    def _file_info(basename):
        full = next((p for p in sar.pdf_files if os.path.basename(p) == basename), None)
        return {
            "name": basename,
            "pages": get_page_count(full) if full else 1,
            "date": sar.document_dates.get(basename),
        }

    # Date order (current pdf_files list is already date-sorted after creation)
    files_info_date = [_file_info(os.path.basename(f)) for f in sar.pdf_files]

    # File order (original extraction order; fall back to date order for legacy SARs)
    if sar.file_order:
        file_order_names = sar.file_order
    else:
        file_order_names = [os.path.basename(f) for f in sar.pdf_files]
    date_map = {fi["name"]: fi for fi in files_info_date}
    files_info_file = [date_map[bn] for bn in file_order_names if bn in date_map]

    main_record_file = sar.main_record_file or (file_order_names[0] if file_order_names else "")

    return render_template(
        "review.html",
        sar=sar,
        files_info=files_info_date,          # kept for backwards compat (initial <select>)
        files_info_date=files_info_date,
        files_info_file=files_info_file,
        main_record_file=main_record_file,
    )


@app.route("/complete/<sar_id>")
@require_login
def complete(sar_id):
    sar = active_requests.get(sar_id)
    if not sar:
        return "SAR request not found", 404
    # Count summary stats for the complete page
    redacted_count = sum(1 for c in sar.candidates
                         if c.status in (RedactionStatus.AUTO_REDACT, RedactionStatus.APPROVED))
    kept_count = sum(1 for c in sar.candidates if c.status == RedactionStatus.REJECTED)
    excluded_count = sum(1 for c in sar.candidates
                         if c.status in (RedactionStatus.EXCLUDED_SUBJECT, RedactionStatus.EXCLUDED_STAFF))
    return render_template("complete.html", sar=sar,
                           redacted_count=redacted_count,
                           kept_count=kept_count,
                           excluded_count=excluded_count)


@app.route("/staff")
@require_login
def staff_page():
    return render_template("staff.html")


# ─── SAR API Routes ────────────────────────────────────────────────────────

@app.route("/api/job/<job_id>/stream")
@require_login
def job_stream(job_id):
    """SSE endpoint: stream progress events for a background job."""
    q = _job_queues.get(job_id)
    if not q:
        return jsonify({"error": "Job not found"}), 404

    def generate():
        while True:
            try:
                event = q.get(timeout=60)
            except Empty:
                # Send a keepalive comment so the connection stays open
                yield ": keepalive\n\n"
                continue
            yield f"data: {json.dumps(event)}\n\n"
            if event.get("done") or event.get("error"):
                _job_queues.pop(job_id, None)
                break

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/sar/create", methods=["POST"])
@require_login
def create_sar():
    """Create a new SAR request. Returns {job_id} immediately; poll /api/job/<id>/stream for progress."""
    subject = SubjectDetails(
        full_name=request.form.get("full_name", "").strip(),
        first_name=request.form.get("first_name", "").strip(),
        last_name=request.form.get("last_name", "").strip(),
        nhs_number=request.form.get("nhs_number", "").strip(),
        date_of_birth=request.form.get("date_of_birth", "").strip(),
        address=request.form.get("address", "").strip(),
        phone=request.form.get("phone", "").strip(),
        email=request.form.get("email", "").strip(),
        aliases=json.loads(request.form.get("aliases", "[]")),
    )

    if not subject.full_name:
        return jsonify({"error": "Subject full name is required"}), 400

    files = request.files.getlist("pdf_files")
    if not files or all(f.filename == "" for f in files):
        return jsonify({"error": "At least one file is required"}), 400

    sar = SARRequest(subject=subject)
    sar.compute_due_date()

    # ── Phase 1 (in request context): save raw uploads to disk ───────────────
    sar_dir = os.path.join(UPLOAD_DIR, sar.id)
    os.makedirs(sar_dir, exist_ok=True)

    saved = []   # list of (filepath, ext)
    for f in files:
        if f.filename and allowed_file(f.filename):
            filename = secure_filename(f.filename)
            filepath = os.path.join(sar_dir, filename)
            f.save(filepath)
            saved.append((filepath, filename.rsplit(".", 1)[-1].lower()))

    if not saved:
        return jsonify({"error": "No valid files uploaded (PDF, TIF, RTF, TXT, or ZIP)"}), 400

    # ── Phase 2 (background thread): convert, detect, save ───────────────────
    job_id, q = _new_job()

    def _process():
        try:
            n_files = len(saved)

            # Convert / extract
            for i, (filepath, ext) in enumerate(saved):
                name = os.path.basename(filepath)
                _emit(q, 0.05 + 0.20 * i / n_files, f"Preparing {name}…")
                if ext == "zip":
                    def _zip_progress(done, total):
                        frac = 0.05 + 0.20 * (i + done / max(total, 1)) / n_files
                        _emit(q, frac, f"Converting file {done}/{total}…")
                    extracted = _extract_zip_to_pdfs(filepath, sar_dir, emit_fn=_zip_progress)
                    sar.pdf_files.extend(extracted)
                else:
                    sar.pdf_files.append(_convert_single_file(filepath, ext))

            if not sar.pdf_files:
                q.put({"error": "No valid files after conversion"})
                return

            n_pdfs = len(sar.pdf_files)

            # Date extraction + sort
            _emit(q, 0.25, "Reading document dates…")
            for pdf_path in sar.pdf_files:
                basename = os.path.basename(pdf_path)
                # Try filename-embedded date first (e.g. "2024-04-23_hash_desc.pdf")
                doc_date = extract_date_from_filename(basename)
                if not doc_date:
                    try:
                        page_text = get_full_page_text(pdf_path, 0)
                        doc_date = extract_document_date(page_text)
                    except Exception:
                        doc_date = None
                sar.document_dates[basename] = doc_date

            # Capture original extraction order before date-sort
            sar.file_order = [os.path.basename(p) for p in sar.pdf_files]
            # Default main record to the first file in extraction order
            if not sar.main_record_file and sar.file_order:
                sar.main_record_file = sar.file_order[0]

            sar.pdf_files.sort(
                key=lambda p: sar.document_dates.get(os.path.basename(p)) or "9999-99-99"
            )

            # PII detection
            all_candidates = []
            for i, pdf_path in enumerate(sar.pdf_files):
                name = os.path.basename(pdf_path)
                _emit(q, 0.30 + 0.65 * i / n_pdfs, f"Analysing {name}… ({i+1}/{n_pdfs})")
                spans = extract_text_spans(pdf_path)
                candidates = detect_pii(
                    pdf_path, spans, subject, name,
                    settings=sar.detection_settings,
                )
                all_candidates.extend(candidates)

            sar.candidates = all_candidates
            sar.status = "reviewing"
            active_requests[sar.id] = sar
            _save_sar(sar)

            q.put({
                "done": True,
                "sar_id": sar.id,
                "total_candidates": len(all_candidates),
                "auto_redact": sum(1 for c in all_candidates if c.status == RedactionStatus.AUTO_REDACT),
                "flagged": sum(1 for c in all_candidates if c.status == RedactionStatus.FLAGGED),
            })

        except Exception as exc:
            q.put({"error": str(exc)})

    threading.Thread(target=_process, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/api/sar/<sar_id>/candidates")
@require_login
def get_candidates(sar_id):
    """Return all redaction candidates for review."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    return jsonify({
        "candidates": [
            {
                "id": c.id,
                "text": c.text,
                "category": c.category.value,
                "status": c.status.value,
                "confidence": c.confidence,
                "page_num": c.page_num,
                "x0": c.x0, "y0": c.y0,
                "x1": c.x1, "y1": c.y1,
                "reason": c.reason,
                "exemption_code": c.exemption_code,
                "risk_flags": c.risk_flags,
                "source_file": c.source_file,
            }
            for c in sar.candidates
        ],
    })


@app.route("/api/sar/<sar_id>/main_record", methods=["POST"])
@require_login
def set_main_record(sar_id):
    """Set the main record file that is always pinned first in both view orderings."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404
    data = request.get_json(silent=True) or {}
    filename = data.get("filename", "")
    valid_names = [os.path.basename(p) for p in sar.pdf_files]
    if filename not in valid_names:
        return jsonify({"error": "File not in SAR"}), 400
    sar.main_record_file = filename
    _save_sar(sar)
    return jsonify({"ok": True, "main_record_file": filename})


@app.route("/api/sar/<sar_id>/page-image/<filename>/<int:page_num>")
@require_login
def page_image(sar_id, filename, page_num):
    """Render a PDF page as a PNG image for the review UI."""
    sar = active_requests.get(sar_id)
    if not sar:
        return "Not found", 404

    pdf_path = next(
        (p for p in sar.pdf_files if os.path.basename(p) == filename), None
    )
    if not pdf_path:
        return "File not found", 404

    img_bytes = render_page_image(pdf_path, page_num, zoom=2.0)
    return Response(img_bytes, mimetype="image/png")


@app.route("/api/sar/<sar_id>/page-count/<filename>")
@require_login
def page_count_route(sar_id, filename):
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404
    pdf_path = next(
        (p for p in sar.pdf_files if os.path.basename(p) == filename), None
    )
    if not pdf_path:
        return jsonify({"error": "File not found"}), 404
    return jsonify({"count": get_page_count(pdf_path)})


@app.route("/api/sar/<sar_id>/candidate/<candidate_id>/update", methods=["POST"])
@require_login
def update_candidate(sar_id, candidate_id):
    """Update a single candidate's status."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    candidate = next((c for c in sar.candidates if c.id == candidate_id), None)
    if not candidate:
        return jsonify({"error": "Candidate not found"}), 404

    data = request.json
    if "status" in data:
        candidate.status = RedactionStatus(data["status"])
    if "category" in data:
        candidate.category = PIICategory(data["category"])
    if "reason" in data:
        candidate.reason = data["reason"]
    if "exemption_code" in data:
        candidate.exemption_code = data["exemption_code"]

    _save_sar(sar)
    return jsonify({"ok": True})


@app.route("/api/sar/<sar_id>/batch-update", methods=["POST"])
@require_login
def batch_update(sar_id):
    """Batch update candidate statuses. Supports scope='page' with source_file+page_num."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    data = request.json
    action = data.get("action")
    target = data.get("target", "flagged")
    scope = data.get("scope", "all")          # "all" or "page"
    source_file = data.get("source_file")
    page_num = data.get("page_num")

    def in_scope(c):
        if scope == "page":
            return c.source_file == source_file and c.page_num == page_num
        return True

    if action == "approve_all":
        for c in sar.candidates:
            if not in_scope(c):
                continue
            if target == "flagged" and c.status == RedactionStatus.FLAGGED:
                c.status = RedactionStatus.APPROVED
    elif action == "reject_all":
        for c in sar.candidates:
            if not in_scope(c):
                continue
            if target == "flagged" and c.status == RedactionStatus.FLAGGED:
                c.status = RedactionStatus.REJECTED

    _save_sar(sar)
    return jsonify({"ok": True})


@app.route("/api/sar/<sar_id>/batch-by-text", methods=["POST"])
@require_login
def batch_by_text(sar_id):
    """Set all candidates matching a text value to approved or rejected."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    data = request.json
    text = data.get("text", "").strip()
    action = data.get("action")  # "redact_all" or "keep_all"

    if not text or action not in ("redact_all", "keep_all"):
        return jsonify({"error": "Invalid parameters"}), 400

    new_status = RedactionStatus.APPROVED if action == "redact_all" else RedactionStatus.REJECTED
    count = 0
    for c in sar.candidates:
        if (c.text.strip().lower() == text.lower()
                and c.status not in (RedactionStatus.EXCLUDED_SUBJECT, RedactionStatus.EXCLUDED_STAFF)):
            c.status = new_status
            count += 1

    _save_sar(sar)
    return jsonify({"ok": True, "updated": count})


# ─── Detection Settings ──────────────────────────────────────────────────────

@app.route("/api/sar/<sar_id>/detection-settings", methods=["GET"])
@require_login
def get_detection_settings(sar_id):
    """Get the current detection settings for a SAR."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404
    ds = sar.detection_settings
    return jsonify({
        "auto_redact_threshold": ds.auto_redact_threshold,
        "flag_threshold": ds.flag_threshold,
        "enabled_categories": ds.enabled_categories,
    })


@app.route("/api/sar/<sar_id>/detection-settings", methods=["PUT"])
@require_admin
def update_detection_settings(sar_id):
    """Update detection settings for a SAR."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    data = request.get_json(silent=True) or {}
    if "auto_redact_threshold" in data:
        sar.detection_settings.auto_redact_threshold = float(data["auto_redact_threshold"])
    if "flag_threshold" in data:
        sar.detection_settings.flag_threshold = float(data["flag_threshold"])
    if "enabled_categories" in data:
        sar.detection_settings.enabled_categories = data["enabled_categories"]

    _save_sar(sar)
    return jsonify({"ok": True})


# ─── Stop-the-Clock ─────────────────────────────────────────────────────────

@app.route("/api/sar/<sar_id>/pause-clock", methods=["POST"])
@require_admin
def pause_clock(sar_id):
    """Pause the statutory clock for a SAR (e.g. awaiting ID verification)."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404
    if sar.clock_paused:
        return jsonify({"error": "Clock is already paused"}), 400

    data = request.get_json(silent=True) or {}
    reason = data.get("reason", "").strip()
    if not reason:
        return jsonify({"error": "A reason is required to pause the clock"}), 400

    sar.clock_paused = True
    sar.paused_at = datetime.now(timezone.utc).isoformat()
    _save_sar(sar)

    return jsonify({"ok": True, "paused_at": sar.paused_at})


@app.route("/api/sar/<sar_id>/resume-clock", methods=["POST"])
@require_admin
def resume_clock(sar_id):
    """Resume the statutory clock for a SAR."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404
    if not sar.clock_paused:
        return jsonify({"error": "Clock is not paused"}), 400

    data = request.get_json(silent=True) or {}

    # Calculate paused duration
    try:
        paused_dt = datetime.fromisoformat(sar.paused_at).date()
        paused_days = max(0, (datetime.now().date() - paused_dt).days)
    except (ValueError, TypeError):
        paused_days = 0

    sar.total_paused_days += paused_days
    sar.pause_log.append({
        "paused_at": sar.paused_at,
        "resumed_at": datetime.now(timezone.utc).isoformat(),
        "reason": data.get("reason", ""),
        "days": paused_days,
    })
    sar.clock_paused = False
    sar.paused_at = ""
    _save_sar(sar)

    return jsonify({"ok": True, "paused_days": paused_days, "total_paused_days": sar.total_paused_days})


@app.route("/api/sar/<sar_id>/finalise", methods=["POST"])
@require_login
def finalise_sar(sar_id):
    """Apply all confirmed redactions and generate output files."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    output_dir = os.path.join(OUTPUT_DIR, sar.id)
    os.makedirs(output_dir, exist_ok=True)

    try:
        redacted_files = []
        for pdf_path in sar.pdf_files:
            output_path = apply_redactions(pdf_path, sar.candidates, output_dir)
            redacted_files.append(os.path.basename(output_path))

        log_path = generate_redaction_log(sar.candidates, output_dir, sar.id)
    except Exception as e:
        print(f"Finalise error for {sar_id}: {e}")
        import traceback; traceback.print_exc()
        return jsonify({"error": f"Redaction failed: {str(e)}"}), 500

    sar.status = "complete"
    sar.workflow_status = "complete"
    _save_sar(sar)

    return jsonify({
        "redacted_files": redacted_files,
        "log_file": os.path.basename(log_path),
    })


@app.route("/api/sar/<sar_id>/outputs")
@require_login
def list_outputs(sar_id):
    """List available output files for a completed SAR."""
    output_dir = os.path.join(OUTPUT_DIR, sar_id)
    if not os.path.isdir(output_dir):
        return jsonify({"error": "No output files found"}), 404

    files = os.listdir(output_dir)
    redacted = [f for f in files if f.endswith("_redacted.pdf")]
    logs = [f for f in files if f.startswith("redaction_log_")]

    return jsonify({
        "redacted_files": redacted,
        "log_file": logs[0] if logs else None,
    })


@app.route("/api/sar/<sar_id>/download/<filename>")
@require_login
def download_file(sar_id, filename):
    output_dir = os.path.join(OUTPUT_DIR, sar_id)
    filepath = os.path.join(output_dir, secure_filename(filename))
    if not os.path.exists(filepath):
        return "File not found", 404
    return send_file(filepath, as_attachment=True)


@app.route("/api/sar/<sar_id>/download-all")
@require_login
def download_all(sar_id):
    """Stream all redacted PDFs and the audit log as a single ZIP download."""
    output_dir = os.path.join(OUTPUT_DIR, sar_id)
    if not os.path.isdir(output_dir):
        return "No output files found", 404

    sar = active_requests.get(sar_id)
    subject_name = (
        (sar.subject.full_name or f"{sar.subject.first_name} {sar.subject.last_name}").strip()
        if sar else sar_id
    )
    safe_subject = secure_filename(subject_name) or sar_id
    zip_name = f"{safe_subject}_redacted.zip"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname in sorted(os.listdir(output_dir)):
            fpath = os.path.join(output_dir, fname)
            if os.path.isfile(fpath):
                zf.write(fpath, fname)
    buf.seek(0)

    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name=zip_name,
    )


# ─── Export / Import ─────────────────────────────────────────────────────────

@app.route("/api/sar/<sar_id>/export")
@require_login
def export_sar(sar_id):
    """Bundle a SAR (JSON + PDFs) into a .sarpack zip for handover."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # Manifest
        manifest = {
            "format_version": SARPACK_FORMAT_VERSION,
            "app_version": APP_VERSION,
            "sar_id": sar.id,
            "export_timestamp": datetime.now(timezone.utc).isoformat(),
            "last_modified": sar.last_modified,
            "subject_name": sar.subject.full_name or f"{sar.subject.first_name} {sar.subject.last_name}".strip(),
            "workflow_status": sar.workflow_status,
        }
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))

        # SAR data (re-use same structure as _save_sar but inline)
        sar_data = {
            "id": sar.id,
            "created_at": sar.created_at,
            "last_modified": sar.last_modified,
            "status": sar.status,
            "due_date": sar.due_date,
            "notes": sar.notes,
            "workflow_status": sar.workflow_status,
            "allocated_to": sar.allocated_to,
            "allocated_to_name": sar.allocated_to_name,
            "subject": {
                "full_name": sar.subject.full_name,
                "first_name": sar.subject.first_name,
                "last_name": sar.subject.last_name,
                "nhs_number": sar.subject.nhs_number,
                "date_of_birth": sar.subject.date_of_birth,
                "address": sar.subject.address,
                "phone": sar.subject.phone,
                "email": sar.subject.email,
                "aliases": sar.subject.aliases,
            },
            "document_dates": sar.document_dates,
            "pdf_files": [os.path.basename(p) for p in sar.pdf_files],
            "candidates": [
                {
                    "id": c.id, "text": c.text, "category": c.category.value,
                    "status": c.status.value, "confidence": c.confidence,
                    "page_num": c.page_num, "x0": c.x0, "y0": c.y0,
                    "x1": c.x1, "y1": c.y1, "reason": c.reason,
                    "source_file": c.source_file,
                    "exemption_code": c.exemption_code,
                    "risk_flags": c.risk_flags,
                }
                for c in sar.candidates
            ],
        }
        zf.writestr("sar.json", json.dumps(sar_data, indent=2))

        # PDFs
        for pdf_path in sar.pdf_files:
            if os.path.exists(pdf_path):
                zf.write(pdf_path, f"pdfs/{os.path.basename(pdf_path)}")

    buf.seek(0)
    safe_name = secure_filename(
        f"SAR_{sar.subject.full_name or sar.id}_{sar.id}.sarpack"
    ).replace(" ", "_")
    return send_file(
        buf,
        mimetype="application/zip",
        as_attachment=True,
        download_name=safe_name,
    )


@app.route("/api/sar/import", methods=["POST"])
@require_admin
def import_sar():
    """Import a .sarpack file. Returns conflict info if SAR already exists."""
    f = request.files.get("sarpack")
    if not f:
        return jsonify({"error": "No file provided"}), 400

    try:
        buf = io.BytesIO(f.read())
        with zipfile.ZipFile(buf, "r") as zf:
            names = zf.namelist()
            if "manifest.json" not in names or "sar.json" not in names:
                return jsonify({"error": "Invalid .sarpack file"}), 400

            manifest = json.loads(zf.read("manifest.json"))
            sar_data = json.loads(zf.read("sar.json"))

            # Version conflict check
            sar_id = sar_data["id"]
            incoming_modified = manifest.get("last_modified", "")
            existing = active_requests.get(sar_id)
            if existing:
                existing_modified = existing.last_modified or ""
                if incoming_modified and existing_modified:
                    if incoming_modified < existing_modified:
                        return jsonify({
                            "conflict": "older",
                            "sar_id": sar_id,
                            "subject_name": manifest.get("subject_name", ""),
                            "incoming_modified": incoming_modified,
                            "existing_modified": existing_modified,
                        }), 409
                    if incoming_modified == existing_modified:
                        return jsonify({
                            "conflict": "same",
                            "sar_id": sar_id,
                            "subject_name": manifest.get("subject_name", ""),
                            "incoming_modified": incoming_modified,
                            "existing_modified": existing_modified,
                        }), 409

            # Extract PDFs
            sar_dir = os.path.join(UPLOAD_DIR, sar_id)
            os.makedirs(sar_dir, exist_ok=True)
            pdf_map = {}
            for name in names:
                if name.startswith("pdfs/") and name != "pdfs/":
                    basename = os.path.basename(name)
                    dest = os.path.join(sar_dir, basename)
                    with zf.open(name) as src, open(dest, "wb") as dst:
                        dst.write(src.read())
                    pdf_map[basename] = dest

            # Rebuild SAR object with correct full paths
            subject = SubjectDetails(**sar_data["subject"])
            candidates = [
                RedactionCandidate(
                    id=c["id"], text=c["text"],
                    category=PIICategory(c["category"]),
                    status=RedactionStatus(c["status"]),
                    confidence=c["confidence"], page_num=c["page_num"],
                    x0=c["x0"], y0=c["y0"], x1=c["x1"], y1=c["y1"],
                    reason=c["reason"], source_file=c["source_file"],
                )
                for c in sar_data["candidates"]
            ]
            full_pdf_paths = [
                os.path.join(sar_dir, fn) for fn in sar_data["pdf_files"]
                if os.path.exists(os.path.join(sar_dir, fn))
            ]
            sar = SARRequest(
                id=sar_data["id"],
                created_at=sar_data.get("created_at", ""),
                last_modified=sar_data.get("last_modified", ""),
                subject=subject,
                pdf_files=full_pdf_paths,
                candidates=candidates,
                status=sar_data.get("status", "reviewing"),
                due_date=sar_data.get("due_date", ""),
                notes=sar_data.get("notes", ""),
                workflow_status=sar_data.get("workflow_status", "new"),
                allocated_to=sar_data.get("allocated_to", ""),
                allocated_to_name=sar_data.get("allocated_to_name", ""),
                document_dates=sar_data.get("document_dates", {}),
            )
            if not sar.due_date:
                sar.compute_due_date()

            active_requests[sar.id] = sar
            # Write JSON without updating last_modified (preserve the imported timestamp)
            path = os.path.join(SAR_DATA_DIR, f"{sar.id}.json")
            with open(path, "w") as jf:
                json.dump({
                    "id": sar.id, "created_at": sar.created_at,
                    "last_modified": sar.last_modified,
                    "status": sar.status, "due_date": sar.due_date,
                    "notes": sar.notes, "workflow_status": sar.workflow_status,
                    "allocated_to": sar.allocated_to,
                    "allocated_to_name": sar.allocated_to_name,
                    "subject": sar_data["subject"],
                    "document_dates": sar_data.get("document_dates", {}),
                    "pdf_files": full_pdf_paths,
                    "candidates": sar_data["candidates"],
                }, jf, indent=2)

    except zipfile.BadZipFile:
        return jsonify({"error": "File is not a valid .sarpack"}), 400
    except Exception as e:
        return jsonify({"error": f"Import failed: {str(e)}"}), 500

    return jsonify({"ok": True, "sar_id": sar.id, "subject_name": manifest.get("subject_name", "")})


@app.route("/api/sar/import/force", methods=["POST"])
@require_admin
def import_sar_force():
    """Force-import a .sarpack even if a conflict was detected."""
    f = request.files.get("sarpack")
    if not f:
        return jsonify({"error": "No file provided"}), 400
    # Re-use the same logic but delete the existing SAR first
    buf = io.BytesIO(f.read())
    try:
        with zipfile.ZipFile(buf, "r") as zf:
            sar_data = json.loads(zf.read("sar.json"))
            sar_id = sar_data["id"]
            if sar_id in active_requests:
                for path in [os.path.join(UPLOAD_DIR, sar_id), os.path.join(OUTPUT_DIR, sar_id)]:
                    if os.path.isdir(path):
                        shutil.rmtree(path)
                sar_json = os.path.join(SAR_DATA_DIR, f"{sar_id}.json")
                if os.path.exists(sar_json):
                    os.remove(sar_json)
                del active_requests[sar_id]
    except Exception:
        pass

    buf.seek(0)
    # Reuse main import logic by re-posting internally via a fake request
    # Simpler: just re-run the same extraction inline
    try:
        buf.seek(0)
        with zipfile.ZipFile(buf, "r") as zf:
            manifest = json.loads(zf.read("manifest.json"))
            sar_data = json.loads(zf.read("sar.json"))
            sar_id = sar_data["id"]
            sar_dir = os.path.join(UPLOAD_DIR, sar_id)
            os.makedirs(sar_dir, exist_ok=True)
            for name in zf.namelist():
                if name.startswith("pdfs/") and name != "pdfs/":
                    basename = os.path.basename(name)
                    dest = os.path.join(sar_dir, basename)
                    with zf.open(name) as src, open(dest, "wb") as dst:
                        dst.write(src.read())
            subject = SubjectDetails(**sar_data["subject"])
            candidates = [
                RedactionCandidate(
                    id=c["id"], text=c["text"],
                    category=PIICategory(c["category"]),
                    status=RedactionStatus(c["status"]),
                    confidence=c["confidence"], page_num=c["page_num"],
                    x0=c["x0"], y0=c["y0"], x1=c["x1"], y1=c["y1"],
                    reason=c["reason"], source_file=c["source_file"],
                )
                for c in sar_data["candidates"]
            ]
            full_pdf_paths = [
                os.path.join(sar_dir, fn) for fn in sar_data["pdf_files"]
                if os.path.exists(os.path.join(sar_dir, fn))
            ]
            sar = SARRequest(
                id=sar_data["id"], created_at=sar_data.get("created_at", ""),
                last_modified=sar_data.get("last_modified", ""),
                subject=subject, pdf_files=full_pdf_paths, candidates=candidates,
                status=sar_data.get("status", "reviewing"),
                due_date=sar_data.get("due_date", ""), notes=sar_data.get("notes", ""),
                workflow_status=sar_data.get("workflow_status", "new"),
                allocated_to=sar_data.get("allocated_to", ""),
                allocated_to_name=sar_data.get("allocated_to_name", ""),
                document_dates=sar_data.get("document_dates", {}),
            )
            if not sar.due_date:
                sar.compute_due_date()
            active_requests[sar.id] = sar
            path = os.path.join(SAR_DATA_DIR, f"{sar.id}.json")
            with open(path, "w") as jf:
                json.dump({
                    "id": sar.id, "created_at": sar.created_at,
                    "last_modified": sar.last_modified, "status": sar.status,
                    "due_date": sar.due_date, "notes": sar.notes,
                    "workflow_status": sar.workflow_status,
                    "allocated_to": sar.allocated_to,
                    "allocated_to_name": sar.allocated_to_name,
                    "document_dates": sar_data.get("document_dates", {}),
                    "subject": sar_data["subject"], "pdf_files": full_pdf_paths,
                    "candidates": sar_data["candidates"],
                }, jf, indent=2)
    except Exception as e:
        return jsonify({"error": f"Force import failed: {str(e)}"}), 500

    return jsonify({"ok": True, "sar_id": sar.id})


@app.route("/api/sar/<sar_id>/manual-redact", methods=["POST"])
@require_login
def manual_redact(sar_id):
    """Add a manually drawn redaction box to a SAR."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    data = request.json
    candidate = RedactionCandidate(
        text="[Manual redaction]",
        category=PIICategory.MANUAL,
        status=RedactionStatus.APPROVED,
        confidence=1.0,
        page_num=data["page_num"],
        x0=data["x0"],
        y0=data["y0"],
        x1=data["x1"],
        y1=data["y1"],
        reason="Manually drawn redaction",
        source_file=data["source_file"],
    )
    sar.candidates.append(candidate)
    _save_sar(sar)

    return jsonify({
        "id": candidate.id,
        "text": candidate.text,
        "category": candidate.category.value,
        "status": candidate.status.value,
        "confidence": candidate.confidence,
        "page_num": candidate.page_num,
        "x0": candidate.x0,
        "y0": candidate.y0,
        "x1": candidate.x1,
        "y1": candidate.y1,
        "reason": candidate.reason,
        "source_file": candidate.source_file,
    })


# ─── Delete SAR ──────────────────────────────────────────────────────────────

@app.route("/api/sar/<sar_id>/delete", methods=["POST"])
@require_admin
def delete_sar(sar_id):
    """Permanently delete a SAR and all associated files."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    for path in [
        os.path.join(UPLOAD_DIR, sar_id),
        os.path.join(OUTPUT_DIR, sar_id),
    ]:
        if os.path.isdir(path):
            shutil.rmtree(path)

    sar_json = os.path.join(SAR_DATA_DIR, f"{sar_id}.json")
    if os.path.exists(sar_json):
        os.remove(sar_json)

    del active_requests[sar_id]
    return jsonify({"ok": True})


@app.route("/api/sar/<sar_id>/delete-page", methods=["POST"])
@require_admin
def delete_page(sar_id):
    """Remove a single page from an uploaded PDF and drop its candidates."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    data = request.json or {}
    filename = data.get("filename")
    page_num = data.get("page_num")  # 0-indexed

    pdf_path = next((p for p in sar.pdf_files if os.path.basename(p) == filename), None)
    if not pdf_path:
        return jsonify({"error": "File not found"}), 404

    import fitz
    doc = fitz.open(pdf_path)
    total = len(doc)
    if page_num is None or page_num < 0 or page_num >= total:
        doc.close()
        return jsonify({"error": "Invalid page number"}), 400

    doc.delete_page(page_num)
    doc.save(pdf_path, incremental=False)
    new_page_count = len(doc)
    doc.close()

    # Drop candidates on the deleted page; shift later pages down
    sar.candidates = [
        c for c in sar.candidates
        if not (c.source_file == filename and c.page_num == page_num)
    ]
    for c in sar.candidates:
        if c.source_file == filename and c.page_num > page_num:
            c.page_num -= 1

    _save_sar(sar)
    return jsonify({"ok": True, "new_page_count": new_page_count})


# ─── Notes API ───────────────────────────────────────────────────────────────

@app.route("/api/sar/<sar_id>/notes", methods=["GET"])
@require_login
def get_notes(sar_id):
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404
    return jsonify({"notes": sar.notes})


@app.route("/api/sar/<sar_id>/notes", methods=["PUT"])
@require_login
def update_notes(sar_id):
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404
    data = request.json
    sar.notes = data.get("notes", "")
    _save_sar(sar)
    return jsonify({"ok": True})


# ─── Custom Words API ────────────────────────────────────────────────────────

@app.route("/api/custom-words", methods=["GET"])
@require_login
def list_custom_words():
    return jsonify(get_custom_words())


@app.route("/api/custom-words", methods=["POST"])
@require_login
def add_custom_word_route():
    data = request.json
    phrase = data.get("phrase", "").strip()
    if not phrase:
        return jsonify({"error": "Phrase is required"}), 400
    add_custom_word(phrase, bool(data.get("case_sensitive", False)))
    return jsonify({"ok": True})


@app.route("/api/custom-words/<path:phrase>", methods=["DELETE"])
@require_login
def delete_custom_word(phrase):
    remove_custom_word(phrase)
    return jsonify({"ok": True})


# ─── Reparse API ─────────────────────────────────────────────────────────────

@app.route("/api/sar/<sar_id>/reparse", methods=["POST"])
@require_login
def reparse_sar(sar_id):
    """Re-run PII detection and merge new candidates, preserving existing decisions."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    subject = sar.subject

    # Build a set of existing candidate keys to avoid duplicates
    existing_keys = {
        (c.source_file, c.page_num, round(c.x0, 1), round(c.y0, 1), c.text.lower())
        for c in sar.candidates
    }

    new_candidates = []
    for pdf_path in sar.pdf_files:
        if not os.path.exists(pdf_path):
            continue
        spans = extract_text_spans(pdf_path)
        detected = detect_pii(pdf_path, spans, subject, os.path.basename(pdf_path),
                              settings=sar.detection_settings)
        for c in detected:
            key = (c.source_file, c.page_num, round(c.x0, 1), round(c.y0, 1), c.text.lower())
            if key not in existing_keys:
                existing_keys.add(key)
                new_candidates.append(c)

    sar.candidates.extend(new_candidates)
    _save_sar(sar)

    return jsonify({"ok": True, "new_found": len(new_candidates)})


@app.route("/api/sar/<sar_id>/document-date", methods=["POST"])
@require_login
def set_document_date(sar_id):
    """Set or clear the document date for a file, then re-sort."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404

    data = request.get_json()
    filename = data.get("filename", "")
    date_str = data.get("date")  # "YYYY-MM-DD" or null

    basenames = [os.path.basename(f) for f in sar.pdf_files]
    if filename not in basenames:
        return jsonify({"error": "File not found in this SAR"}), 400

    sar.document_dates[filename] = date_str

    # Re-sort pdf_files by date
    def _sort_key(pdf_path):
        bn = os.path.basename(pdf_path)
        d = sar.document_dates.get(bn)
        return d if d else "9999-99-99"
    sar.pdf_files.sort(key=_sort_key)

    _save_sar(sar)
    return jsonify({"ok": True})


# ─── Staff List API ─────────────────────────────────────────────────────────

@app.route("/api/staff", methods=["GET"])
@require_login
def list_staff():
    return jsonify(get_staff_list())


@app.route("/api/staff", methods=["POST"])
@require_login
def add_staff():
    data = request.json
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400
    add_staff_member(name, data.get("role", ""))
    return jsonify({"ok": True})


@app.route("/api/staff/<name>", methods=["DELETE"])
@require_login
def delete_staff(name):
    remove_staff_member(name)
    return jsonify({"ok": True})


# ─── Workflow & Allocation API ───────────────────────────────────────────────

@app.route("/api/sar/<sar_id>/allocate", methods=["POST"])
@require_admin
def allocate_sar(sar_id):
    """Admin-only: allocate a SAR to a GP user."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404
    data = request.json or {}
    gp_id = data.get("user_id", "")
    if not gp_id:
        sar.allocated_to = ""
        sar.allocated_to_name = ""
        sar.workflow_status = "new"
    else:
        gp = get_user_by_id(gp_id)
        if not gp:
            return jsonify({"error": "User not found"}), 404
        sar.allocated_to = gp.id
        sar.allocated_to_name = gp.display_name
        sar.workflow_status = "in_review"
    _save_sar(sar)
    return jsonify({"ok": True, "workflow_status": sar.workflow_status})


@app.route("/api/sar/<sar_id>/workflow", methods=["POST"])
@require_login
def update_workflow(sar_id):
    """Update workflow status. GPs may only submit their own SARs for sign-off."""
    sar = active_requests.get(sar_id)
    if not sar:
        return jsonify({"error": "Not found"}), 404
    data = request.json or {}
    new_status = data.get("status")
    VALID = {"ready_for_signoff", "in_review"}
    if new_status not in VALID:
        return jsonify({"error": "Invalid status"}), 400
    if g.current_user.role == "gp":
        if sar.allocated_to != g.current_user.id:
            return jsonify({"error": "Not authorised — SAR is not allocated to you"}), 403
        if new_status != "ready_for_signoff":
            return jsonify({"error": "GPs may only submit for sign-off"}), 403
    sar.workflow_status = new_status
    _save_sar(sar)
    return jsonify({"ok": True, "workflow_status": sar.workflow_status})


# ─── Medical Reports ─────────────────────────────────────────────────────────

from sar.report_templates import (
    get_all_templates, get_template, save_custom_template,
    delete_custom_template,
)
from sar.report_store import (
    save_report, load_report, load_all_reports, delete_report,
)
from sar.evidence_extractor import extract_evidence
from sar.report_generator import generate_report_pdf

REPORT_UPLOAD_DIR = os.path.join(_DATA_ROOT, "uploads", "reports")
REPORT_OUTPUT_DIR = os.path.join(_DATA_ROOT, "output", "reports")
os.makedirs(REPORT_UPLOAD_DIR, exist_ok=True)
os.makedirs(REPORT_OUTPUT_DIR, exist_ok=True)


@app.route("/reports")
@require_login
def reports_dashboard():
    reports = load_all_reports()
    reports.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    templates = get_all_templates()
    return render_template("reports_dashboard.html", reports=reports, templates=templates)


@app.route("/reports/new")
@require_login
def new_report_page():
    templates = get_all_templates()
    return render_template("reports_new.html", templates=templates)


@app.route("/reports/<report_id>")
@require_login
def report_review(report_id):
    report = load_report(report_id)
    if not report:
        return "Report not found", 404
    template = get_template(report["template_id"])
    files_info = []
    for f in report.get("pdf_files", []):
        if os.path.exists(f):
            files_info.append({
                "name": os.path.basename(f),
                "pages": get_page_count(f),
                "date": report.get("document_dates", {}).get(os.path.basename(f)),
            })
    return render_template("reports_review.html",
                           report=report, template=template, files_info=files_info)


@app.route("/api/reports/create", methods=["POST"])
@require_login
def create_report():
    """Create a new medical report. Returns {job_id} immediately; poll /api/job/<id>/stream."""
    template_id = request.form.get("template_id", "")
    template = get_template(template_id)
    if not template:
        return jsonify({"error": "Template not found"}), 400

    patient = {
        "full_name": request.form.get("full_name", "").strip(),
        "date_of_birth": request.form.get("date_of_birth", "").strip(),
        "nhs_number": request.form.get("nhs_number", "").strip(),
        "address": request.form.get("address", "").strip(),
        "gp_name": request.form.get("gp_name", "").strip(),
        "gp_practice": request.form.get("gp_practice", "").strip(),
    }

    if not patient["full_name"]:
        return jsonify({"error": "Patient name is required"}), 400

    files = request.files.getlist("pdf_files")
    if not files or all(f.filename == "" for f in files):
        return jsonify({"error": "At least one file is required"}), 400

    import uuid as _uuid
    report_id = str(_uuid.uuid4())[:12]
    report_dir = os.path.join(REPORT_UPLOAD_DIR, report_id)
    os.makedirs(report_dir, exist_ok=True)

    # ── Phase 1 (in request context): save raw uploads ────────────────────────
    saved = []
    for f in files:
        if f.filename and allowed_file(f.filename):
            filename = secure_filename(f.filename)
            filepath = os.path.join(report_dir, filename)
            f.save(filepath)
            saved.append((filepath, filename.rsplit(".", 1)[-1].lower()))

    if not saved:
        return jsonify({"error": "No valid files uploaded"}), 400

    # Capture user info before leaving request context
    created_by = g.current_user.id
    created_by_name = g.current_user.display_name
    created_at = datetime.now(timezone.utc).isoformat()

    # ── Phase 2 (background thread): convert, extract evidence, save ──────────
    job_id, jq = _new_job()

    def _process():
        try:
            n_files = len(saved)
            pdf_files = []

            # Convert / extract
            for i, (filepath, ext) in enumerate(saved):
                name = os.path.basename(filepath)
                _emit(jq, 0.05 + 0.20 * i / n_files, f"Preparing {name}…")
                if ext == "zip":
                    def _zip_progress(done, total):
                        frac = 0.05 + 0.20 * (i + done / max(total, 1)) / n_files
                        _emit(jq, frac, f"Converting file {done}/{total}…")
                    pdf_files.extend(_extract_zip_to_pdfs(filepath, report_dir, emit_fn=_zip_progress))
                else:
                    pdf_files.append(_convert_single_file(filepath, ext))

            if not pdf_files:
                jq.put({"error": "No valid files after conversion"})
                return

            # Date extraction + sort
            _emit(jq, 0.27, "Reading document dates…")
            doc_dates = {}
            for pdf_path in pdf_files:
                basename = os.path.basename(pdf_path)
                # Try filename-embedded date first (e.g. "2024-04-23_hash_desc.pdf")
                doc_date = extract_date_from_filename(basename)
                if not doc_date:
                    try:
                        page_text = get_full_page_text(pdf_path, 0)
                        doc_date = extract_document_date(page_text)
                    except Exception:
                        doc_date = None
                doc_dates[basename] = doc_date
            pdf_files.sort(
                key=lambda p: doc_dates.get(os.path.basename(p)) or "9999-99-99"
            )

            # Evidence extraction per question
            questions = sorted(template.get("questions", []), key=lambda x: x.get("order", 0))
            n_q = len(questions)
            answers = []
            for i, q in enumerate(questions):
                short = q["text"][:50] + "…" if len(q["text"]) > 50 else q["text"]
                _emit(jq, 0.30 + 0.65 * i / max(n_q, 1), f"Question {i+1}/{n_q}: {short}")
                evidence = extract_evidence(pdf_files, q)
                answers.append({
                    "question_id": q["id"],
                    "question_text": q["text"],
                    "question_type": q.get("question_type", "free_text"),
                    "options": q.get("options", []),
                    "answer": "",
                    "evidence": evidence,
                    "reviewed": False,
                })

            # Keyword flag scan (uses same page text already read by evidence extractor)
            _emit(jq, 0.96, "Scanning for flagged keywords…")
            keyword_flags = scan_keywords(pdf_files, questions)

            report_data = {
                "id": report_id,
                "created_at": created_at,
                "last_modified": created_at,
                "template_id": template_id,
                "template_name": template["name"],
                "patient": patient,
                "pdf_files": pdf_files,
                "document_dates": doc_dates,
                "answers": answers,
                "keyword_flags": keyword_flags,
                "status": "in_progress",
                "created_by": created_by,
                "created_by_name": created_by_name,
            }
            save_report(report_data)

            jq.put({"done": True, "report_id": report_id, "total_questions": len(answers)})

        except Exception as exc:
            jq.put({"error": str(exc)})

    threading.Thread(target=_process, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/api/reports/<report_id>/answer", methods=["POST"])
@require_login
def save_report_answer(report_id):
    """Save an answer to a question."""
    report = load_report(report_id)
    if not report:
        return jsonify({"error": "Not found"}), 404

    data = request.get_json()
    question_id = data.get("question_id", "")
    answer_text = data.get("answer", "")
    reviewed = data.get("reviewed", False)

    for a in report.get("answers", []):
        if a["question_id"] == question_id:
            a["answer"] = answer_text
            a["reviewed"] = reviewed
            break

    save_report(report)
    return jsonify({"ok": True})


@app.route("/api/reports/<report_id>/evidence/<question_id>")
@require_login
def get_report_evidence(report_id, question_id):
    """Get evidence snippets for a specific question."""
    report = load_report(report_id)
    if not report:
        return jsonify({"error": "Not found"}), 404

    for a in report.get("answers", []):
        if a["question_id"] == question_id:
            return jsonify({"evidence": a.get("evidence", [])})

    return jsonify({"error": "Question not found"}), 404


@app.route("/api/reports/<report_id>/re-extract", methods=["POST"])
@require_login
def re_extract_evidence(report_id):
    """Re-run evidence extraction for all questions (e.g. after uploading more files)."""
    report = load_report(report_id)
    if not report:
        return jsonify({"error": "Not found"}), 404

    template = get_template(report["template_id"])
    if not template:
        return jsonify({"error": "Template not found"}), 400

    questions = template.get("questions", [])
    questions_by_id = {q["id"]: q for q in questions}
    for a in report.get("answers", []):
        q = questions_by_id.get(a["question_id"])
        if q:
            a["evidence"] = extract_evidence(report["pdf_files"], q)

    # Also refresh keyword flags
    report["keyword_flags"] = scan_keywords(report["pdf_files"], questions)

    save_report(report)
    return jsonify({"ok": True})


@app.route("/api/reports/<report_id>/generate", methods=["POST"])
@require_login
def generate_report(report_id):
    """Generate the final PDF report."""
    report = load_report(report_id)
    if not report:
        return jsonify({"error": "Not found"}), 404

    output_dir = os.path.join(REPORT_OUTPUT_DIR, report_id)
    output_path = generate_report_pdf(report, output_dir)

    report["status"] = "complete"
    save_report(report)

    return jsonify({"ok": True, "filename": os.path.basename(output_path)})


@app.route("/api/reports/<report_id>/download/<filename>")
@require_login
def download_report(report_id, filename):
    output_dir = os.path.join(REPORT_OUTPUT_DIR, report_id)
    filepath = os.path.join(output_dir, secure_filename(filename))
    if not os.path.exists(filepath):
        return "File not found", 404
    return send_file(filepath, as_attachment=True)


@app.route("/api/reports/<report_id>/page-image/<filename>/<int:page_num>")
@require_login
def report_page_image(report_id, filename, page_num):
    """Render a page from an uploaded record file as PNG for the review UI."""
    report = load_report(report_id)
    if not report:
        return "Not found", 404
    safe = secure_filename(filename)
    report_dir = os.path.join(REPORT_UPLOAD_DIR, report_id)
    pdf_path = os.path.join(report_dir, safe)
    if not os.path.exists(pdf_path):
        return "File not found", 404
    img = render_page_image(pdf_path, page_num)
    return Response(img, mimetype="image/png")


@app.route("/api/reports/<report_id>/delete", methods=["POST"])
@require_admin
def delete_report_route(report_id):
    """Delete a medical report and its files."""
    deleted = delete_report(report_id)
    # Clean up uploaded files
    report_dir = os.path.join(REPORT_UPLOAD_DIR, report_id)
    if os.path.isdir(report_dir):
        shutil.rmtree(report_dir)
    output_dir = os.path.join(REPORT_OUTPUT_DIR, report_id)
    if os.path.isdir(output_dir):
        shutil.rmtree(output_dir)
    if not deleted:
        return jsonify({"error": "Not found"}), 404
    return jsonify({"ok": True})


# ─── Template Management API ────────────────────────────────────────────────

@app.route("/api/templates")
@require_login
def list_templates():
    return jsonify(get_all_templates())


@app.route("/api/templates", methods=["POST"])
@require_admin
def create_template():
    data = request.get_json()
    if not data.get("name"):
        return jsonify({"error": "Template name is required"}), 400
    import uuid as _uuid
    template = {
        "id": f"tpl_{str(_uuid.uuid4())[:8]}",
        "name": data["name"],
        "category": data.get("category", "custom"),
        "description": data.get("description", ""),
        "is_builtin": False,
        "questions": data.get("questions", []),
    }
    save_custom_template(template)
    return jsonify({"ok": True, "template_id": template["id"]})


@app.route("/api/templates/<template_id>", methods=["DELETE"])
@require_admin
def delete_template_route(template_id):
    # Prevent deleting built-ins
    t = get_template(template_id)
    if t and t.get("is_builtin"):
        return jsonify({"error": "Cannot delete built-in templates"}), 400
    if not delete_custom_template(template_id):
        return jsonify({"error": "Not found or is built-in"}), 404
    return jsonify({"ok": True})


# ─── Main ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=True, port=port)

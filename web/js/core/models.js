// models.js — Ported from sar/models.py
// Attach all exports to window.SARCore namespace.

window.SARCore = window.SARCore || {};

// ── UUID helpers ──────────────────────────────────────────────────────────────

function _uuid4() {
    // RFC4122 v4 UUID
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        var v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/** Generate an 8-character random hex id (like uuid4[:8]). */
function generateId8() {
    return _uuid4().replace(/-/g, '').slice(0, 8);
}

/** Generate a 12-character random hex id (like uuid4[:12]). */
function generateId12() {
    return _uuid4().replace(/-/g, '').slice(0, 12);
}

// ── PIICategory ───────────────────────────────────────────────────────────────

const PIICategory = Object.freeze({
    PERSON_NAME:   'person_name',
    NHS_NUMBER:    'nhs_number',
    DATE_OF_BIRTH: 'date_of_birth',
    ADDRESS:       'address',
    PHONE_NUMBER:  'phone_number',
    POSTCODE:      'postcode',
    EMAIL:         'email',
    SAFEGUARDING:  'safeguarding',
    SEXUAL_HEALTH: 'sexual_health',
    CUSTOM_WORD:   'custom_word',
    MANUAL:        'manual',
});

// ── RedactionStatus ───────────────────────────────────────────────────────────

const RedactionStatus = Object.freeze({
    AUTO_REDACT:      'auto_redact',
    FLAGGED:          'flagged',
    APPROVED:         'approved',
    REJECTED:         'rejected',
    EXCLUDED_SUBJECT: 'excluded_subject',
    EXCLUDED_STAFF:   'excluded_staff',
});

// ── Factory: TextSpan ─────────────────────────────────────────────────────────

/**
 * Create a TextSpan — a piece of text with its position on a PDF page.
 * @param {object} opts
 * @returns {object}
 */
function createTextSpan(opts) {
    return {
        text:     opts.text     || '',
        page_num: opts.page_num !== undefined ? opts.page_num : 0,
        x0:       opts.x0       !== undefined ? opts.x0 : 0,
        y0:       opts.y0       !== undefined ? opts.y0 : 0,
        x1:       opts.x1       !== undefined ? opts.x1 : 0,
        y1:       opts.y1       !== undefined ? opts.y1 : 0,
        block_no: opts.block_no !== undefined ? opts.block_no : 0,
        line_no:  opts.line_no  !== undefined ? opts.line_no  : 0,
        span_no:  opts.span_no  !== undefined ? opts.span_no  : 0,
    };
}

// ── Factory: RedactionCandidate ───────────────────────────────────────────────

/**
 * Create a RedactionCandidate — a detected piece of PII that may need redacting.
 * @param {object} opts
 * @returns {object}
 */
function createRedactionCandidate(opts) {
    opts = opts || {};
    return {
        id:            opts.id            !== undefined ? opts.id            : generateId8(),
        text:          opts.text          !== undefined ? opts.text          : '',
        category:      opts.category      !== undefined ? opts.category      : PIICategory.PERSON_NAME,
        status:        opts.status        !== undefined ? opts.status        : RedactionStatus.FLAGGED,
        confidence:    opts.confidence    !== undefined ? opts.confidence    : 0.0,
        page_num:      opts.page_num      !== undefined ? opts.page_num      : 0,
        x0:            opts.x0            !== undefined ? opts.x0            : 0.0,
        y0:            opts.y0            !== undefined ? opts.y0            : 0.0,
        x1:            opts.x1            !== undefined ? opts.x1            : 0.0,
        y1:            opts.y1            !== undefined ? opts.y1            : 0.0,
        reason:        opts.reason        !== undefined ? opts.reason        : '',
        exemption_code:opts.exemption_code !== undefined ? opts.exemption_code : '',
        risk_flags:    opts.risk_flags    !== undefined ? opts.risk_flags    : [],
        source_file:   opts.source_file   !== undefined ? opts.source_file   : '',
    };
}

// ── Factory: SubjectDetails ───────────────────────────────────────────────────

/**
 * Create a SubjectDetails object.
 * @param {object} opts
 * @returns {object}
 */
function createSubjectDetails(opts) {
    opts = opts || {};
    return {
        full_name:   opts.full_name   !== undefined ? opts.full_name   : '',
        first_name:  opts.first_name  !== undefined ? opts.first_name  : '',
        last_name:   opts.last_name   !== undefined ? opts.last_name   : '',
        nhs_number:  opts.nhs_number  !== undefined ? opts.nhs_number  : '',
        date_of_birth: opts.date_of_birth !== undefined ? opts.date_of_birth : '',
        address:     opts.address     !== undefined ? opts.address     : '',
        phone:       opts.phone       !== undefined ? opts.phone       : '',
        email:       opts.email       !== undefined ? opts.email       : '',
        aliases:     opts.aliases     !== undefined ? opts.aliases     : [],
    };
}

// ── Factory: DetectionSettings ────────────────────────────────────────────────

/**
 * Create a DetectionSettings object with sensible defaults.
 * @param {object} opts
 * @returns {object}
 */
function createDetectionSettings(opts) {
    opts = opts || {};
    return {
        auto_redact_threshold: opts.auto_redact_threshold !== undefined
            ? opts.auto_redact_threshold
            : 0.80,
        flag_threshold: opts.flag_threshold !== undefined
            ? opts.flag_threshold
            : 0.50,
        // Note: date_of_birth excluded by default (matches Python)
        enabled_categories: opts.enabled_categories !== undefined
            ? opts.enabled_categories
            : [
                'person_name', 'nhs_number', 'address', 'phone_number',
                'postcode', 'email', 'safeguarding', 'sexual_health',
                'custom_word', 'manual',
            ],
    };
}

// ── Factory: SARRequest ───────────────────────────────────────────────────────

/**
 * Create a SARRequest object representing a single SAR processing job.
 * @param {object} opts
 * @returns {object}
 */
function createSARRequest(opts) {
    opts = opts || {};
    var now = new Date().toISOString();
    var sar = {
        id:              opts.id              !== undefined ? opts.id              : generateId12(),
        created_at:      opts.created_at      !== undefined ? opts.created_at      : now,
        subject:         opts.subject         !== undefined ? opts.subject         : createSubjectDetails(),
        pdf_files:       opts.pdf_files       !== undefined ? opts.pdf_files       : [],
        candidates:      opts.candidates      !== undefined ? opts.candidates      : [],
        detection_settings: opts.detection_settings !== undefined
            ? opts.detection_settings
            : createDetectionSettings(),
        status:          opts.status          !== undefined ? opts.status          : 'pending',
        due_date:        opts.due_date        !== undefined ? opts.due_date        : '',
        notes:           opts.notes           !== undefined ? opts.notes           : '',
        workflow_status: opts.workflow_status !== undefined ? opts.workflow_status : 'new',
        allocated_to:    opts.allocated_to    !== undefined ? opts.allocated_to    : '',
        allocated_to_name: opts.allocated_to_name !== undefined ? opts.allocated_to_name : '',
        last_modified:   opts.last_modified   !== undefined ? opts.last_modified   : now,
        document_dates:  opts.document_dates  !== undefined ? opts.document_dates  : {},
        file_order:      opts.file_order      !== undefined ? opts.file_order      : [],
        main_record_file: opts.main_record_file !== undefined ? opts.main_record_file : '',
        clock_paused:    opts.clock_paused    !== undefined ? opts.clock_paused    : false,
        paused_at:       opts.paused_at       !== undefined ? opts.paused_at       : '',
        total_paused_days: opts.total_paused_days !== undefined ? opts.total_paused_days : 0,
        pause_log:       opts.pause_log       !== undefined ? opts.pause_log       : [],
    };

    // Auto-compute due_date (30 calendar days from created_at) if not provided
    if (!sar.due_date) {
        try {
            var created = new Date(sar.created_at);
            created.setDate(created.getDate() + 30);
            sar.due_date = created.toISOString().slice(0, 10);
        } catch (e) {
            // ignore
        }
    }

    return sar;
}

/**
 * Compute days remaining for a SAR, accounting for paused time.
 * @param {object} sar
 * @returns {number}
 */
function sarDaysRemaining(sar) {
    if (!sar.due_date) return 99;
    try {
        var due = new Date(sar.due_date);
        var livePausedDays = 0;
        if (sar.clock_paused && sar.paused_at) {
            var paused = new Date(sar.paused_at);
            var msPerDay = 86400000;
            livePausedDays = Math.max(0, Math.floor((Date.now() - paused.getTime()) / msPerDay));
        }
        var effectiveDue = new Date(due.getTime() +
            (sar.total_paused_days + livePausedDays) * 86400000);
        var today = new Date();
        today.setHours(0, 0, 0, 0);
        effectiveDue.setHours(0, 0, 0, 0);
        return Math.round((effectiveDue.getTime() - today.getTime()) / 86400000);
    } catch (e) {
        return 99;
    }
}

// ── Exports ───────────────────────────────────────────────────────────────────

window.SARCore.PIICategory             = PIICategory;
window.SARCore.RedactionStatus         = RedactionStatus;
window.SARCore.createTextSpan          = createTextSpan;
window.SARCore.createRedactionCandidate = createRedactionCandidate;
window.SARCore.createSubjectDetails    = createSubjectDetails;
window.SARCore.createDetectionSettings = createDetectionSettings;
window.SARCore.createSARRequest        = createSARRequest;
window.SARCore.sarDaysRemaining        = sarDaysRemaining;
window.SARCore.generateId8             = generateId8;
window.SARCore.generateId12            = generateId12;

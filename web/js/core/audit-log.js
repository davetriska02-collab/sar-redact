// audit-log.js — PDF audit log generation, ported from sar/redaction_log.py
// Uses pdf-lib (PDFLib global) to create a multi-page audit log PDF.
// Attaches all exports to window.SARCore namespace.

window.SARCore = window.SARCore || {};

// ── Exemption code labels ─────────────────────────────────────────────────────
// Mirrors EXEMPTION_LABELS in redaction_log.py

var EXEMPTION_LABELS = {
    'third_party':         'Third-party data (s.16(4))',
    'serious_harm':        'Serious harm (Sch 3, Para 2)',
    'crime_prevention':    'Crime prevention (Sch 2, Para 2)',
    'legal_privilege':     'Legal privilege (Sch 2, Para 19)',
    'management_forecast': 'Management forecasting (Sch 2, Para 22)',
    'confidential_ref':    'Confidential reference (Sch 2, Para 24)',
    'child_abuse':         'Child abuse data (Sch 3, Para 3)',
    'regulatory':          'Regulatory functions (Sch 2, Para 7)',
    'national_security':   'National security (s.26)',
    'other':               'Other (see notes)',
};

// ── generateAuditLog ──────────────────────────────────────────────────────────

/**
 * Generate a PDF audit log for the given SAR redaction candidates.
 * Returns the PDF as a Uint8Array.
 *
 * @param {Array}  candidates  Array of RedactionCandidate objects
 * @param {string} sarId       SAR reference ID
 * @returns {Promise<Uint8Array>}
 */
async function generateAuditLog(candidates, sarId) {
    var RedactionStatus = window.SARCore.RedactionStatus;
    var { PDFDocument, rgb, StandardFonts } = PDFLib;

    // Partition candidates
    var redacted         = candidates.filter(function(c) {
        return c.status === RedactionStatus.AUTO_REDACT || c.status === RedactionStatus.APPROVED;
    });
    var excludedSubject  = candidates.filter(function(c) {
        return c.status === RedactionStatus.EXCLUDED_SUBJECT;
    });
    var excludedStaff    = candidates.filter(function(c) {
        return c.status === RedactionStatus.EXCLUDED_STAFF;
    });
    var rejected         = candidates.filter(function(c) {
        return c.status === RedactionStatus.REJECTED;
    });
    var flagged          = candidates.filter(function(c) {
        return c.status === RedactionStatus.FLAGGED;
    });

    // Build the lines array (mirrors the Python logic)
    var now = new Date();
    var dateStr = now.toLocaleDateString('en-GB') + ' ' + now.toLocaleTimeString('en-GB');

    var lines = [
        { text: 'SUBJECT ACCESS REQUEST - REDACTION LOG', header: true },
        { text: 'SAR Reference: ' + (sarId || ''), header: false },
        { text: 'Generated: ' + dateStr, header: false },
        { text: '', header: false },
        { text: 'SUMMARY', header: true },
        { text: '-'.repeat(50), header: false },
        { text: 'Total detections: ' + candidates.length, header: false },
        { text: 'Redactions applied: ' + redacted.length, header: false },
        { text: 'Excluded (data subject): ' + excludedSubject.length, header: false },
        { text: 'Excluded (staff): ' + excludedStaff.length, header: false },
        { text: 'Rejected by reviewer: ' + rejected.length, header: false },
        { text: 'Unreviewed (not redacted): ' + flagged.length, header: false },
        { text: '', header: false },
        { text: '='.repeat(60), header: false },
        { text: 'REDACTIONS APPLIED', header: true },
        { text: '='.repeat(60), header: false },
    ];

    for (var i = 0; i < redacted.length; i++) {
        var c = redacted[i];
        var method = (c.status === RedactionStatus.AUTO_REDACT) ? 'Auto-redacted' : 'Manually approved';
        lines.push({ text: '', header: false });
        lines.push({ text: (i + 1) + '. [' + (c.category || '').toUpperCase() + ']', header: false });
        lines.push({ text: '   Text: "' + (c.text || '') + '"', header: false });
        lines.push({ text: '   File: ' + (c.source_file || ''), header: false });
        lines.push({ text: '   Page: ' + ((c.page_num || 0) + 1), header: false });
        lines.push({ text: '   Confidence: ' + Math.round((c.confidence || 0) * 100) + '%', header: false });
        lines.push({ text: '   Reason: ' + (c.reason || ''), header: false });
        lines.push({ text: '   Method: ' + method, header: false });
        if (c.exemption_code) {
            var exemptionLabel = EXEMPTION_LABELS[c.exemption_code] || c.exemption_code;
            lines.push({ text: '   Exemption: ' + exemptionLabel, header: false });
        }
        if (c.risk_flags && c.risk_flags.length > 0) {
            var flagsStr = c.risk_flags.map(function(f) {
                return (f.category || '') + ': ' + (f.phrase || '');
            }).join(', ');
            lines.push({ text: '   Risk flags: ' + flagsStr, header: false });
        }
    }

    if (rejected.length > 0) {
        lines.push({ text: '', header: false });
        lines.push({ text: '='.repeat(60), header: false });
        lines.push({ text: 'REJECTED (NOT REDACTED)', header: true });
        lines.push({ text: '='.repeat(60), header: false });
        for (var ri = 0; ri < rejected.length; ri++) {
            var rc = rejected[ri];
            lines.push({ text: '', header: false });
            lines.push({ text: (ri + 1) + '. [' + (rc.category || '').toUpperCase() + ']', header: false });
            lines.push({ text: '   Text: "' + (rc.text || '') + '"', header: false });
            lines.push({ text: '   File: ' + (rc.source_file || ''), header: false });
            lines.push({ text: '   Page: ' + ((rc.page_num || 0) + 1), header: false });
            lines.push({ text: '   Reason for detection: ' + (rc.reason || ''), header: false });
        }
    }

    if (flagged.length > 0) {
        lines.push({ text: '', header: false });
        lines.push({ text: '='.repeat(60), header: false });
        lines.push({ text: 'UNREVIEWED (NOT REDACTED)', header: true });
        lines.push({ text: '='.repeat(60), header: false });
        for (var fi = 0; fi < flagged.length; fi++) {
            var fc = flagged[fi];
            lines.push({ text: '', header: false });
            lines.push({ text: (fi + 1) + '. [' + (fc.category || '').toUpperCase() + ']', header: false });
            lines.push({ text: '   Text: "' + (fc.text || '') + '"', header: false });
            lines.push({ text: '   File: ' + (fc.source_file || ''), header: false });
            lines.push({ text: '   Page: ' + ((fc.page_num || 0) + 1), header: false });
            lines.push({ text: '   Confidence: ' + Math.round((fc.confidence || 0) * 100) + '%', header: false });
        }
    }

    // ── Write to PDF ──────────────────────────────────────────────────────────
    var pdfDoc = await PDFDocument.create();
    var helvetica     = await pdfDoc.embedFont(StandardFonts.Helvetica);
    var helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    var PAGE_WIDTH  = 595;  // A4 portrait
    var PAGE_HEIGHT = 842;
    var MARGIN      = 50;
    var FONT_SIZE   = 9;
    var HEADER_FONT_SIZE = 11;
    var LINE_HEIGHT = FONT_SIZE * 1.5;

    var currentPage = null;
    var yPos = 0;

    function ensurePage() {
        if (currentPage === null || yPos > PAGE_HEIGHT - MARGIN) {
            currentPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
            yPos = PAGE_HEIGHT - MARGIN;
        }
    }

    for (var li = 0; li < lines.length; li++) {
        var lineObj = lines[li];
        ensurePage();

        if (lineObj.text !== '') {
            var font = lineObj.header ? helveticaBold : helvetica;
            var fSize = lineObj.header ? HEADER_FONT_SIZE : FONT_SIZE;

            // Clamp text to page width
            var maxWidth = PAGE_WIDTH - MARGIN * 2;
            var lineText = lineObj.text;

            // Simple truncation if too wide (pdf-lib doesn't auto-wrap)
            while (lineText.length > 1) {
                try {
                    var w = font.widthOfTextAtSize(lineText, fSize);
                    if (w <= maxWidth) break;
                } catch (e) {
                    break;
                }
                lineText = lineText.slice(0, -1);
            }

            currentPage.drawText(lineText, {
                x:        MARGIN,
                y:        yPos,
                size:     fSize,
                font:     font,
                color:    rgb(0, 0, 0),
                maxWidth: maxWidth,
            });
        }

        yPos -= LINE_HEIGHT;
    }

    var pdfBytes = await pdfDoc.save();
    return pdfBytes;
}


// ── Exports ───────────────────────────────────────────────────────────────────

window.SARCore.EXEMPTION_LABELS = EXEMPTION_LABELS;
window.SARCore.generateAuditLog = generateAuditLog;

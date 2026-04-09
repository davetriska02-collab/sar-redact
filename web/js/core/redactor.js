// redactor.js — Client-side PDF redaction using rasterize-then-redact approach.
// Uses pdf.js for rendering and pdf-lib for creating the output PDF.
// Attaches all exports to window.SARCore namespace.

window.SARCore = window.SARCore || {};

// Scale factor for 200 DPI rendering (PDF points = 72 DPI)
var REDACT_SCALE = 200 / 72; // ≈ 2.778

/**
 * Apply redactions to a single PDF and return the redacted PDF as Uint8Array.
 *
 * Strategy (rasterize-then-redact):
 *  1. Load the PDF with pdf.js
 *  2. For each page, render to canvas at 200 DPI
 *  3. Draw black rectangles over each approved/auto_redact candidate on that page
 *  4. Draw "[REDACTED]" text in white inside each black box
 *  5. Add a diagonal "REDACTED" watermark (gray, 30% opacity)
 *  6. Add footer stamp with date
 *  7. Create a new PDF with pdf-lib, embedding each canvas as a JPEG image page
 *  8. Return the PDF as Uint8Array
 *
 * @param {ArrayBuffer} pdfArrayBuffer   Source PDF data
 * @param {Array}       candidates       RedactionCandidate objects
 * @param {string}      sourceFilename   Original filename (used in stamp)
 * @returns {Promise<Uint8Array>}
 */
async function applyRedactions(pdfArrayBuffer, candidates, sourceFilename) {
    var RedactionStatus = window.SARCore.RedactionStatus;
    var loadPdf         = window.SARCore.loadPdf;
    var renderPageToCanvas = window.SARCore.renderPageToCanvas;

    // Statuses that should be physically redacted
    var toRedact = new Set([RedactionStatus.AUTO_REDACT, RedactionStatus.APPROVED]);

    // Group candidates by page (0-based)
    var byPage = {};
    for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (!toRedact.has(c.status)) continue;
        var pn = c.page_num;
        if (!byPage[pn]) byPage[pn] = [];
        byPage[pn].push(c);
    }

    // Load the source PDF with pdf.js
    var loaded = await loadPdf(pdfArrayBuffer.slice(0));
    var doc = loaded.doc;
    var pageCount = loaded.pageCount;

    // Create a new pdf-lib document
    var { PDFDocument } = PDFLib;
    var outDoc = await PDFDocument.create();

    var stampDate = new Date().toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric'
    });

    for (var pageNum = 1; pageNum <= pageCount; pageNum++) {
        // Render the page to canvas at 200 DPI
        var canvas = await renderPageToCanvas(doc, pageNum, REDACT_SCALE);
        var ctx = canvas.getContext('2d');

        var pageIdx = pageNum - 1; // 0-based for candidates
        var pageCandidates = byPage[pageIdx] || [];

        // Get the original page dimensions (at scale=1) to compute scaling
        var page = await doc.getPage(pageNum);
        var viewport1 = page.getViewport({ scale: 1.0 });
        var origWidth  = viewport1.width;
        var origHeight = viewport1.height;
        var scaleX = canvas.width  / origWidth;
        var scaleY = canvas.height / origHeight;

        // ── Draw redaction boxes ──────────────────────────────────────────────
        for (var ci = 0; ci < pageCandidates.length; ci++) {
            var cand = pageCandidates[ci];

            // Candidates have coordinates in pdf.js top-down space (y0 < y1)
            var cx0 = cand.x0 * scaleX;
            var cy0 = cand.y0 * scaleY;
            var cx1 = cand.x1 * scaleX;
            var cy1 = cand.y1 * scaleY;
            var cw  = cx1 - cx0;
            var ch  = cy1 - cy0;

            if (cw <= 0 || ch <= 0) {
                // Zero-size box — use a default height
                ch = 14 * scaleY;
                cy1 = cy0 + ch;
            }

            // Black fill
            ctx.fillStyle = '#000000';
            ctx.fillRect(cx0, cy0, cw, ch);

            // White "[REDACTED]" label inside the box
            var fontSize = Math.max(7, Math.min(ch * 0.65, 11));
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold ' + fontSize + 'px Arial, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.textAlign = 'center';
            ctx.fillText('[REDACTED]', cx0 + cw / 2, cy0 + ch / 2);
        }

        // ── Diagonal "REDACTED" watermark ─────────────────────────────────────
        ctx.save();
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = '#880000';
        var wFontSize = Math.floor(canvas.width / 8);
        ctx.font = 'bold ' + wFontSize + 'px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(-Math.PI / 4);
        ctx.fillText('REDACTED', 0, 0);
        ctx.restore();

        // ── Footer stamp ──────────────────────────────────────────────────────
        var footerH = Math.max(16, canvas.height * 0.025);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, canvas.height - footerH, canvas.width, footerH);
        ctx.fillStyle = '#ffffff';
        var footerFontSize = Math.floor(footerH * 0.55);
        ctx.font = footerFontSize + 'px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        var stampText = 'Redacted ' + stampDate;
        if (sourceFilename) stampText += ' \u2022 ' + sourceFilename;
        ctx.fillText(stampText, 8, canvas.height - footerH / 2);

        // ── Embed canvas as JPEG in pdf-lib page ──────────────────────────────
        var jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
        var jpegBase64 = jpegDataUrl.split(',')[1];
        var jpegBytes = _base64ToUint8Array(jpegBase64);

        var embeddedImage = await outDoc.embedJpg(jpegBytes);

        // Create a page the same size as the original PDF page (in points)
        var pdfPage = outDoc.addPage([origWidth, origHeight]);
        pdfPage.drawImage(embeddedImage, {
            x:      0,
            y:      0,
            width:  origWidth,
            height: origHeight,
        });
    }

    var pdfBytes = await outDoc.save();
    return pdfBytes;
}

// ── Helper: base64 to Uint8Array ──────────────────────────────────────────────

function _base64ToUint8Array(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// ── Exports ───────────────────────────────────────────────────────────────────

window.SARCore.applyRedactions = applyRedactions;
window.SARCore.REDACT_SCALE    = REDACT_SCALE;

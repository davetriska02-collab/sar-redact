// pdf-engine.js — PDF processing using pdf.js (pdfjsLib global)
// Handles PDF loading, text extraction, page rendering.
// Attaches all exports to window.SARCore namespace.

window.SARCore = window.SARCore || {};

// Configure pdf.js worker (must be set before any operations)
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ── loadPdf ───────────────────────────────────────────────────────────────────

/**
 * Load a PDF from an ArrayBuffer.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<{doc: PDFDocumentProxy, pageCount: number}>}
 */
async function loadPdf(arrayBuffer) {
    var loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    var doc = await loadingTask.promise;
    return { doc: doc, pageCount: doc.numPages };
}

// ── getPageDimensions ─────────────────────────────────────────────────────────

/**
 * Get dimensions of a page (1-based page number).
 * @param {PDFDocumentProxy} doc
 * @param {number} pageNum  1-based
 * @returns {Promise<{width: number, height: number}>}
 */
async function getPageDimensions(doc, pageNum) {
    var page = await doc.getPage(pageNum);
    var viewport = page.getViewport({ scale: 1.0 });
    return { width: viewport.width, height: viewport.height };
}

// ── extractTextSpans ──────────────────────────────────────────────────────────

/**
 * Extract text with positions from all pages.
 * Maps pdf.js text items to TextSpan objects.
 *
 * pdf.js transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
 * The y-axis in pdf.js is bottom-up, so:
 *   y0 = pageHeight - translateY - height
 *   y1 = pageHeight - translateY
 *
 * @param {PDFDocumentProxy} doc
 * @returns {Promise<Array>}  Array of TextSpan objects (all pages)
 */
async function extractTextSpans(doc) {
    var createTextSpan = window.SARCore.createTextSpan;
    var allSpans = [];

    for (var pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        var page = await doc.getPage(pageNum);
        var viewport = page.getViewport({ scale: 1.0 });
        var pageHeight = viewport.height;

        var content = await page.getTextContent();
        var items = content.items;

        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item.str || item.str.trim() === '') continue;

            var transform = item.transform;
            // transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
            var scaleX    = transform[0];
            var scaleY    = transform[3];
            var translateX = transform[4];
            var translateY = transform[5];

            var width  = item.width  || Math.abs(scaleX * item.str.length * 0.5);
            var height = item.height || Math.abs(scaleY);

            // Convert bottom-up pdf.js coordinates to top-down (as used in PyMuPDF)
            var y0 = pageHeight - translateY - height;
            var y1 = pageHeight - translateY;
            var x0 = translateX;
            var x1 = translateX + width;

            allSpans.push(createTextSpan({
                text:     item.str,
                page_num: pageNum - 1, // Convert to 0-based (matching Python)
                x0:       x0,
                y0:       y0,
                x1:       x1,
                y1:       y1,
            }));
        }
    }

    return allSpans;
}

// ── getFullPageText ───────────────────────────────────────────────────────────

/**
 * Get the plain concatenated text of a single page.
 * @param {PDFDocumentProxy} doc
 * @param {number} pageNum  1-based page number
 * @returns {Promise<string>}
 */
async function getFullPageText(doc, pageNum) {
    var page = await doc.getPage(pageNum);
    var content = await page.getTextContent();
    var lines = [];
    var lastY = null;
    var line = '';

    for (var i = 0; i < content.items.length; i++) {
        var item = content.items[i];
        if (!item.str) continue;

        // Use the Y position to detect line breaks
        var y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 2) {
            lines.push(line);
            line = item.str;
        } else {
            line += item.str;
        }
        lastY = y;
    }
    if (line) lines.push(line);

    return lines.join('\n');
}

// ── renderPageToCanvas ────────────────────────────────────────────────────────

/**
 * Render a PDF page to a new canvas element.
 * @param {PDFDocumentProxy} doc
 * @param {number} pageNum  1-based page number
 * @param {number} scale    Rendering scale (200 DPI = 200/72 ≈ 2.78)
 * @returns {Promise<HTMLCanvasElement>}
 */
async function renderPageToCanvas(doc, pageNum, scale) {
    scale = scale || 1.0;
    var page = await doc.getPage(pageNum);
    var viewport = page.getViewport({ scale: scale });

    var canvas = document.createElement('canvas');
    canvas.width  = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    var ctx = canvas.getContext('2d');
    var renderContext = {
        canvasContext: ctx,
        viewport:      viewport,
    };

    await page.render(renderContext).promise;
    return canvas;
}

// ── Exports ───────────────────────────────────────────────────────────────────

window.SARCore.loadPdf             = loadPdf;
window.SARCore.getPageDimensions   = getPageDimensions;
window.SARCore.extractTextSpans    = extractTextSpans;
window.SARCore.getFullPageText     = getFullPageText;
window.SARCore.renderPageToCanvas  = renderPageToCanvas;

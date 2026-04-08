// review.js - Review page: highlight overlays, candidate list, approve/reject

const state = {
    sarId: SAR_ID,
    filesInfo: FILES_INFO,
    filesInfoDate: typeof FILES_INFO_DATE !== 'undefined' ? FILES_INFO_DATE : FILES_INFO,
    filesInfoFile: typeof FILES_INFO_FILE !== 'undefined' ? FILES_INFO_FILE : FILES_INFO,
    mainRecordFile: typeof MAIN_RECORD_FILE !== 'undefined' ? MAIN_RECORD_FILE : '',
    viewOrder: 'date',   // 'date' | 'file'
    currentFile: null,
    currentPage: 0,
    pageCount: 0,
    candidates: [],
    filter: 'all',
    zoom: 2.0,          // Must match server-side zoom in render_page_image
    displayScale: 1.0,  // CSS scale applied to image (clientWidth / naturalWidth)
    displayZoom: null,   // null = fit to panel; number = explicit multiplier of natural width
    drawMode: false,
    _drag: null,
    selectedIndex: -1,   // Currently keyboard-selected candidate index
    viewMode: 'page',    // 'page' = per-page view, 'grouped' = grouped by text
    redactedPagesOnly: false,  // when true, Prev/Next skip pages with no approved/auto_redact candidates
};

// UK GDPR / DPA 2018 exemption codes for redaction justification
const EXEMPTION_CODES = {
    '': '-- No exemption --',
    'third_party': 'Third-party data (s.16(4))',
    'serious_harm': 'Serious harm (Sch 3, Para 2)',
    'crime_prevention': 'Crime prevention (Sch 2, Para 2)',
    'legal_privilege': 'Legal privilege (Sch 2, Para 19)',
    'management_forecast': 'Management forecasting (Sch 2, Para 22)',
    'confidential_ref': 'Confidential reference (Sch 2, Para 24)',
    'child_abuse': 'Child abuse data (Sch 3, Para 3)',
    'regulatory': 'Regulatory functions (Sch 2, Para 7)',
    'national_security': 'National security (s.26)',
    'other': 'Other (see notes)',
};

// Category priority tiers for visual emphasis
const PRIORITY_MAP = {
    'person_name': 'high',
    'nhs_number': 'high',
    'date_of_birth': 'high',
    'address': 'medium',
    'phone_number': 'medium',
    'email': 'medium',
    'postcode': 'low',
    'safeguarding': 'high',
    'sexual_health': 'high',
    'custom_word': 'medium',
    'manual': 'medium',
};

document.addEventListener('DOMContentLoaded', async () => {
    // Apply initial ordering (date order, main record pinned first)
    state.filesInfo = _buildOrderedFilesInfo('date');
    _rebuildFileSelector();

    if (state.filesInfo.length > 0) {
        state.currentFile = state.filesInfo[0].name;
        state.pageCount = state.filesInfo[0].pages;
        document.getElementById('file-selector').value = state.currentFile;
    }
    await loadCandidates();
    await loadNotes();
    renderPage();
    initDrawEvents();
    initKeyboardShortcuts();
    initNotesAutosave();
    initReasonAutosave();
    initSearch();
});

window.addEventListener('resize', () => {
    _applyDisplayZoom();
    renderHighlights();
});


// ─── Data Loading ──────────────────────────────────────────────────────────

async function loadCandidates() {
    const resp = await fetch(`/api/sar/${state.sarId}/candidates`);
    const data = await resp.json();
    state.candidates = data.candidates;
    updateStats();
    updateProgress();
}


// ─── Navigation ────────────────────────────────────────────────────────────

function switchFile(filename) {
    state.currentFile = filename;
    const info = state.filesInfo.find(f => f.name === filename);
    state.pageCount = info ? info.pages : 1;
    state.currentPage = 0;
    state.displayZoom = null;
    state.selectedIndex = -1;
    renderPage();
}


// ─── View Ordering ──────────────────────────────────────────────────────────

/**
 * Build the ordered filesInfo list: main record always first, then the
 * rest in either date or file order.
 */
function _buildOrderedFilesInfo(order) {
    const base = order === 'file' ? state.filesInfoFile : state.filesInfoDate;
    if (!state.mainRecordFile) return base;

    const main = base.find(f => f.name === state.mainRecordFile);
    const rest = base.filter(f => f.name !== state.mainRecordFile);
    return main ? [main, ...rest] : base;
}

/** Rebuild the file selector <select> to reflect current order + main record. */
function _rebuildFileSelector() {
    const sel = document.getElementById('file-selector');
    if (!sel) return;
    const current = sel.value || state.currentFile;
    sel.innerHTML = '';
    state.filesInfo.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f.name;
        const dateLabel = f.date ? `${_formatDate(f.date)} — ` : '';
        const mainLabel = (f.name === state.mainRecordFile) ? ' ★' : '';
        opt.textContent = `${dateLabel}${f.name} (${f.pages}p)${mainLabel}`;
        if (f.name === current) opt.selected = true;
        sel.appendChild(opt);
    });
    // If previous selection no longer present, snap to first
    if (!state.filesInfo.find(f => f.name === current) && state.filesInfo.length > 0) {
        switchFile(state.filesInfo[0].name);
    }
}

function _formatDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${parseInt(d)} ${months[parseInt(m)-1]} ${y}`;
}

function setViewOrder(order) {
    state.viewOrder = order;
    state.filesInfo = _buildOrderedFilesInfo(order);

    // Update toggle button styles
    document.getElementById('btn-order-date').classList.toggle('active', order === 'date');
    document.getElementById('btn-order-file').classList.toggle('active', order === 'file');

    _rebuildFileSelector();

    // If current file still in list, keep it selected; otherwise go to first
    if (!state.filesInfo.find(f => f.name === state.currentFile)) {
        if (state.filesInfo.length > 0) switchFile(state.filesInfo[0].name);
    }
}

/** Pin the currently viewed file as the main record (persisted to server). */
async function pinCurrentFile() {
    const filename = state.currentFile;
    if (!filename) return;

    try {
        const resp = await fetch(`/api/sar/${state.sarId}/main_record`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename }),
        });
        if (!resp.ok) throw new Error('Server error');
        state.mainRecordFile = filename;
        // Refresh order with new main record pinned
        setViewOrder(state.viewOrder);
        // Brief visual feedback on the button
        const btn = document.getElementById('btn-pin-main');
        if (btn) { btn.textContent = '✓ Pinned'; setTimeout(() => { btn.innerHTML = '&#x1F4CC; Pin'; }, 1500); }
    } catch {
        alert('Could not set main record.');
    }
}


/** Returns true if the given 0-indexed page (in the current file) has at least one
 *  approved or auto_redact candidate. Used by redactedPagesOnly mode. */
function _pageHasRedactions(pageNum) {
    return state.candidates.some(c =>
        c.source_file === state.currentFile &&
        c.page_num === pageNum &&
        (c.status === 'approved' || c.status === 'auto_redact')
    );
}

function prevPage() {
    if (state.redactedPagesOnly) {
        let p = state.currentPage - 1;
        while (p >= 0 && !_pageHasRedactions(p)) p--;
        if (p >= 0) {
            state.currentPage = p;
            state.selectedIndex = -1;
            renderPage();
        }
    } else {
        if (state.currentPage > 0) {
            state.currentPage--;
            state.selectedIndex = -1;
            renderPage();
        }
    }
}

function nextPage() {
    if (state.redactedPagesOnly) {
        let p = state.currentPage + 1;
        while (p < state.pageCount && !_pageHasRedactions(p)) p++;
        if (p < state.pageCount) {
            state.currentPage = p;
            state.selectedIndex = -1;
            renderPage();
        }
    } else {
        if (state.currentPage < state.pageCount - 1) {
            state.currentPage++;
            state.selectedIndex = -1;
            renderPage();
        }
    }
}

/** Toggle the "Redacted pages only" navigation mode. */
function toggleRedactedPagesOnly() {
    state.redactedPagesOnly = !state.redactedPagesOnly;
    const btn = document.getElementById('btn-redacted-only');
    if (btn) btn.classList.toggle('active', state.redactedPagesOnly);
    // If activating, jump to the nearest redacted page (including current)
    if (state.redactedPagesOnly && !_pageHasRedactions(state.currentPage)) {
        let p = state.currentPage + 1;
        while (p < state.pageCount && !_pageHasRedactions(p)) p++;
        if (p < state.pageCount) {
            state.currentPage = p;
            state.selectedIndex = -1;
            renderPage();
        }
    }
}

function applyFilter(value) {
    state.filter = value;
    state.selectedIndex = -1;
    renderCandidateList();
    renderHighlights();
}


// ─── Page Rendering ────────────────────────────────────────────────────────

function renderPage() {
    const img = document.getElementById('page-image');

    // Update nav buttons
    document.getElementById('btn-prev').disabled = state.currentPage === 0;
    document.getElementById('btn-next').disabled = state.currentPage >= state.pageCount - 1;
    document.getElementById('page-indicator').textContent =
        `Page ${state.currentPage + 1} / ${state.pageCount}`;

    // Load page image
    img.src = `/api/sar/${state.sarId}/page-image/${encodeURIComponent(state.currentFile)}/${state.currentPage}`;

    img.onload = () => {
        _applyDisplayZoom(img);
        renderHighlights();
        renderCandidateList();
        renderPageNavigator();
    };
}

function _applyDisplayZoom(img) {
    if (!img) img = document.getElementById('page-image');
    if (!img.naturalWidth) return;

    let factor;
    if (state.displayZoom === null) {
        // Fit to panel width
        const panel = document.querySelector('.review-pdf-panel');
        const available = panel.clientWidth - 32; // subtract padding
        factor = Math.min(1.0, available / img.naturalWidth);
        document.getElementById('zoom-level').textContent = 'Fit';
    } else {
        factor = state.displayZoom;
        document.getElementById('zoom-level').textContent = Math.round(factor * 100) + '%';
    }

    img.style.width = (img.naturalWidth * factor) + 'px';
    img.style.height = 'auto';
    state.displayScale = factor;
}

function zoomIn() {
    const img = document.getElementById('page-image');
    const current = state.displayZoom ?? state.displayScale;
    state.displayZoom = Math.min(3.0, parseFloat((current + 0.25).toFixed(2)));
    _applyDisplayZoom(img);
    renderHighlights();
}

function zoomOut() {
    const img = document.getElementById('page-image');
    const current = state.displayZoom ?? state.displayScale;
    state.displayZoom = Math.max(0.25, parseFloat((current - 0.25).toFixed(2)));
    _applyDisplayZoom(img);
    renderHighlights();
}

function zoomFit() {
    state.displayZoom = null;
    _applyDisplayZoom();
    renderHighlights();
}

function renderHighlights() {
    const container = document.getElementById('page-container');
    const img = document.getElementById('page-image');

    // Keep displayScale in sync with actual rendered size
    if (img.naturalWidth > 0 && img.clientWidth > 0) {
        state.displayScale = img.clientWidth / img.naturalWidth;
    }

    // Clear existing highlights (but keep the drag box)
    container.querySelectorAll('.highlight').forEach(el => el.remove());

    const pageCandidates = getFilteredPageCandidates();
    const scale = state.zoom * state.displayScale;

    pageCandidates.forEach(c => {
        if (c.x0 === 0 && c.y0 === 0 && c.x1 === 0 && c.y1 === 0) return;

        const div = document.createElement('div');
        div.className = `highlight highlight-${c.status} highlight-cat-${c.category}`;
        div.dataset.candidateId = c.id;
        div.title = `${formatCategory(c.category)}: "${c.text}" (${(c.confidence * 100).toFixed(0)}%)`;

        // Map PDF coordinates to CSS pixel coordinates
        div.style.left = `${c.x0 * scale}px`;
        div.style.top = `${c.y0 * scale}px`;
        div.style.width = `${(c.x1 - c.x0) * scale}px`;
        div.style.height = `${(c.y1 - c.y0) * scale}px`;

        div.addEventListener('click', () => {
            if (!state.drawMode) scrollToCard(c.id);
        });
        container.appendChild(div);
    });
}


// ─── Candidate List ────────────────────────────────────────────────────────

function getFilteredPageCandidates() {
    return state.candidates.filter(c => {
        if (c.source_file !== state.currentFile) return false;
        if (c.page_num !== state.currentPage) return false;
        return matchesFilter(c);
    });
}

function matchesFilter(c) {
    switch (state.filter) {
        case 'flagged':
            return c.status === 'flagged';
        case 'auto_redact':
            return c.status === 'auto_redact';
        case 'redacting':
            return c.status === 'auto_redact' || c.status === 'approved';
        case 'excluded':
            return c.status === 'excluded_subject' || c.status === 'excluded_staff';
        case 'risk_flagged':
            return c.risk_flags && c.risk_flags.length > 0;
        default:
            return true;
    }
}

function renderCandidateList() {
    if (state.viewMode === 'grouped') {
        renderGroupedList();
        return;
    }

    const list = document.getElementById('candidate-list');

    // Preserve in-progress reason input if user is typing
    let focusedReasonId = null;
    let focusedReasonValue = null;
    let focusedReasonCursor = null;
    const activeEl = document.activeElement;
    if (activeEl && activeEl.classList.contains('candidate-reason-input')) {
        focusedReasonId = activeEl.dataset.candidateId;
        focusedReasonValue = activeEl.value;
        focusedReasonCursor = activeEl.selectionStart;
    }

    list.innerHTML = '';

    const pageCandidates = getFilteredPageCandidates();

    if (pageCandidates.length === 0) {
        list.innerHTML = '<div class="empty-candidates">No items on this page matching the current filter.</div>';
        return;
    }

    pageCandidates.forEach((c, idx) => {
        const card = document.createElement('div');
        const priority = PRIORITY_MAP[c.category] || 'medium';
        card.className = `candidate-card status-${c.status} priority-${priority}`;
        card.id = `card-${c.id}`;
        card.dataset.idx = idx;

        if (idx === state.selectedIndex) {
            card.classList.add('card-highlight');
        }

        const confidenceClass = c.confidence >= 0.8 ? 'high' : c.confidence >= 0.5 ? 'medium' : 'low';
        const categoryLabel = formatCategory(c.category);
        const statusLabel = formatStatus(c.status);

        // Count all-document instances for bulk-action buttons
        const textMatches = state.candidates.filter(x =>
            x.text.trim().toLowerCase() === c.text.trim().toLowerCase() &&
            x.status !== 'excluded_subject' && x.status !== 'excluded_staff'
        ).length;
        const showBulk = textMatches > 1;

        let exemptionHtml = '';
        if (c.status !== 'excluded_subject' && c.status !== 'excluded_staff') {
            const exemptionOptions = Object.entries(EXEMPTION_CODES).map(([val, label]) =>
                `<option value="${val}" ${(c.exemption_code || '') === val ? 'selected' : ''}>${escapeHtml(label)}</option>`
            ).join('');
            exemptionHtml = `
                <div class="candidate-exemption">
                    <select class="exemption-select" data-candidate-id="${c.id}">
                        ${exemptionOptions}
                    </select>
                </div>
            `;
        }

        let actionsHtml = '';
        if (c.status !== 'excluded_subject' && c.status !== 'excluded_staff') {
            const isRedacting = c.status === 'auto_redact' || c.status === 'approved';
            const isKept = c.status === 'rejected';
            actionsHtml = `
                <div class="candidate-actions">
                    <button class="btn-sm ${isRedacting ? 'btn-sm-primary' : 'btn-sm-approve'}"
                            onclick="updateCandidate('${c.id}', ${isRedacting ? "'flagged'" : "'approved'"})">
                        ${isRedacting ? 'Redacting' : 'Redact'}<span class="kbd-hint">A</span>
                    </button>
                    <button class="btn-sm ${isKept ? '' : 'btn-sm-reject'}"
                            onclick="updateCandidate('${c.id}', ${isKept ? "'flagged'" : "'rejected'"})">
                        ${isKept ? 'Kept' : 'Keep'}<span class="kbd-hint">K</span>
                    </button>
                </div>
            `;
            if (showBulk) {
                actionsHtml += `
                <div class="candidate-bulk-actions">
                    <button class="btn-bulk btn-bulk-redact" data-text="${escapeHtml(c.text)}" data-action="redact_all">
                        Redact all&nbsp;(${textMatches})
                    </button>
                    <button class="btn-bulk btn-bulk-keep" data-text="${escapeHtml(c.text)}" data-action="keep_all">
                        Keep all&nbsp;(${textMatches})
                    </button>
                </div>`;
            }
        } else {
            actionsHtml = `<div class="excluded-label">Excluded (${c.status.replace('excluded_', '')})</div>`;
        }

        let riskHtml = '';
        if (c.risk_flags && c.risk_flags.length > 0) {
            const riskTooltip = c.risk_flags.map(f => `${f.category}: "${f.phrase}"`).join(', ');
            riskHtml = `<span class="risk-flag" title="${escapeHtml(riskTooltip)}">&#9888;</span>`;
            card.classList.add('has-risk-flag');
        }

        card.innerHTML = `
            <div class="candidate-header">
                <span class="category-badge badge-${c.category}">${categoryLabel}</span>
                <span class="confidence confidence-${confidenceClass}">${(c.confidence * 100).toFixed(0)}%</span>
                <span class="status-badge status-badge-${c.status}">${statusLabel}</span>
                ${riskHtml}
            </div>
            <div class="candidate-text">"${escapeHtml(c.text)}"</div>
            <div class="candidate-reason-wrap">
                <input type="text" class="candidate-reason-input"
                       value="${escapeHtml(c.reason)}"
                       placeholder="Add reason for redaction..."
                       data-candidate-id="${c.id}" />
            </div>
            ${exemptionHtml}
            ${actionsHtml}
        `;

        card.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SELECT'
                && !e.target.classList.contains('candidate-reason-input')) {
                state.selectedIndex = idx;
                renderCandidateList();
                scrollToHighlight(c.id);
            }
        });

        // Wire up bulk-action buttons via event listeners to avoid HTML escaping issues
        card.querySelectorAll('.btn-bulk').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                batchByText(btn.dataset.text, btn.dataset.action);
            });
        });

        list.appendChild(card);
    });

    // Restore focus to reason input if user was typing
    if (focusedReasonId) {
        const input = list.querySelector(`.candidate-reason-input[data-candidate-id="${focusedReasonId}"]`);
        if (input) {
            input.value = focusedReasonValue;
            input.focus();
            if (focusedReasonCursor !== null) {
                input.setSelectionRange(focusedReasonCursor, focusedReasonCursor);
            }
        }
    }
}


// ─── Grouped View ──────────────────────────────────────────────────────────

function buildGroups() {
    const groups = {};
    const filtered = state.candidates.filter(c => matchesFilter(c));

    filtered.forEach(c => {
        const key = c.text.trim().toLowerCase() + '||' + c.category;
        if (!groups[key]) {
            groups[key] = {
                text: c.text.trim(),
                category: c.category,
                instances: [],
                pages: new Set(),
                files: new Set(),
            };
        }
        groups[key].instances.push(c);
        groups[key].pages.add(c.page_num);
        groups[key].files.add(c.source_file);
    });

    // Sort by instance count descending, then alphabetically
    return Object.values(groups).sort((a, b) =>
        b.instances.length - a.instances.length || a.text.localeCompare(b.text)
    );
}

function renderGroupedList() {
    const list = document.getElementById('candidate-list');
    list.innerHTML = '';

    const groups = buildGroups();

    if (groups.length === 0) {
        list.innerHTML = '<div class="empty-candidates">No items matching the current filter.</div>';
        return;
    }

    groups.forEach(group => {
        const card = document.createElement('div');
        card.className = 'group-card';

        const statusCounts = {};
        group.instances.forEach(c => {
            statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
        });

        const isExcluded = group.instances.every(c =>
            c.status === 'excluded_subject' || c.status === 'excluded_staff');

        const eligible = group.instances.filter(c =>
            c.status !== 'excluded_subject' && c.status !== 'excluded_staff');
        const allRedacted = eligible.length > 0 && eligible.every(c =>
            c.status === 'auto_redact' || c.status === 'approved');
        const allKept = eligible.length > 0 && eligible.every(c =>
            c.status === 'rejected');

        const categoryLabel = formatCategory(group.category);
        const pageList = [...group.pages].sort((a, b) => a - b);
        const pageDisplay = pageList.length <= 5
            ? pageList.map(p => p + 1).join(', ')
            : `${pageList.length} pages`;

        let statusSummary = Object.entries(statusCounts)
            .map(([s, n]) => `<span class="group-status-chip status-badge-${s}">${n} ${formatStatus(s)}</span>`)
            .join(' ');

        let actionsHtml = '';
        if (!isExcluded && eligible.length > 0) {
            actionsHtml = `
                <div class="group-actions">
                    <button class="btn-bulk btn-bulk-redact ${allRedacted ? 'btn-active' : ''}"
                            data-text="${escapeHtml(group.text)}" data-action="redact_all">
                        ${allRedacted ? 'All Redacted' : `Redact All (${eligible.length})`}
                    </button>
                    <button class="btn-bulk btn-bulk-keep ${allKept ? 'btn-active' : ''}"
                            data-text="${escapeHtml(group.text)}" data-action="keep_all">
                        ${allKept ? 'All Kept' : `Keep All (${eligible.length})`}
                    </button>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="group-header">
                <span class="category-badge badge-${group.category}">${categoryLabel}</span>
                <span class="group-count">${group.instances.length} instance${group.instances.length > 1 ? 's' : ''}</span>
            </div>
            <div class="candidate-text">"${escapeHtml(group.text)}"</div>
            <div class="group-meta">
                <span class="group-pages">Pages: ${pageDisplay}</span>
            </div>
            <div class="group-status-summary">${statusSummary}</div>
            ${actionsHtml}
            <div class="group-instance-list hidden"></div>
            <button class="btn-sm group-toggle-instances">Show instances</button>
        `;

        // Toggle instance list
        const toggleBtn = card.querySelector('.group-toggle-instances');
        const instanceList = card.querySelector('.group-instance-list');
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const showing = !instanceList.classList.contains('hidden');
            instanceList.classList.toggle('hidden');
            toggleBtn.textContent = showing ? 'Show instances' : 'Hide instances';
            if (!showing) return; // was already showing, now hiding
            // Populate instance list
            instanceList.innerHTML = '';
            group.instances.forEach(inst => {
                const item = document.createElement('div');
                item.className = `group-instance-item status-${inst.status}`;
                item.innerHTML = `
                    <span class="group-instance-page">p.${inst.page_num + 1}</span>
                    <span class="group-instance-file">${escapeHtml(inst.source_file)}</span>
                    <span class="status-badge status-badge-${inst.status}">${formatStatus(inst.status)}</span>
                `;
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Navigate to this instance
                    if (inst.source_file !== state.currentFile) {
                        document.getElementById('file-selector').value = inst.source_file;
                        switchFile(inst.source_file);
                    }
                    // Switch to page view temporarily to see this instance
                    state.viewMode = 'page';
                    state.currentPage = inst.page_num;
                    document.getElementById('btn-view-mode').textContent = 'Grouped';
                    document.getElementById('btn-view-mode').classList.remove('btn-active');
                    renderPage();
                });
                instanceList.appendChild(item);
            });
        });

        // Wire up bulk-action buttons
        card.querySelectorAll('.btn-bulk').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                batchByText(btn.dataset.text, btn.dataset.action);
            });
        });

        list.appendChild(card);
    });
}

function toggleViewMode() {
    state.viewMode = state.viewMode === 'page' ? 'grouped' : 'page';
    const btn = document.getElementById('btn-view-mode');
    if (state.viewMode === 'grouped') {
        btn.textContent = 'Per Page';
        btn.classList.add('btn-active');
    } else {
        btn.textContent = 'Grouped';
        btn.classList.remove('btn-active');
    }
    state.selectedIndex = -1;
    renderCandidateList();
}


function formatCategory(cat) {
    const labels = {
        'person_name': 'Name',
        'nhs_number': 'NHS No.',
        'date_of_birth': 'DOB',
        'address': 'Address',
        'phone_number': 'Phone',
        'postcode': 'Postcode',
        'email': 'Email',
        'safeguarding': 'Safeguarding',
        'sexual_health': 'Sexual Health',
        'custom_word': 'Custom',
        'manual': 'Manual',
    };
    return labels[cat] || cat;
}

function formatStatus(status) {
    const labels = {
        'auto_redact': 'Auto',
        'flagged': 'Review',
        'approved': 'Approved',
        'rejected': 'Kept',
        'excluded_subject': 'Subject',
        'excluded_staff': 'Staff',
    };
    return labels[status] || status;
}


// ─── Reason Autosave ──────────────────────────────────────────────────────

function initReasonAutosave() {
    const list = document.getElementById('candidate-list');
    list.addEventListener('blur', async (e) => {
        if (!e.target.classList.contains('candidate-reason-input')) return;
        const cid = e.target.dataset.candidateId;
        const newReason = e.target.value.trim();
        const c = state.candidates.find(x => x.id === cid);
        if (!c || c.reason === newReason) return;
        c.reason = newReason;
        await fetch(`/api/sar/${state.sarId}/candidate/${cid}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: newReason }),
        });
    }, true); // useCapture for blur

    // Exemption code change handler
    list.addEventListener('change', async (e) => {
        if (!e.target.classList.contains('exemption-select')) return;
        const cid = e.target.dataset.candidateId;
        const code = e.target.value;
        const c = state.candidates.find(x => x.id === cid);
        if (c) c.exemption_code = code;
        await fetch(`/api/sar/${state.sarId}/candidate/${cid}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ exemption_code: code }),
        });
    });
}


// ─── Updates ───────────────────────────────────────────────────────────────

async function updateCandidate(candidateId, newStatus) {
    await fetch(`/api/sar/${state.sarId}/candidate/${candidateId}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
    });

    // Update local state
    const c = state.candidates.find(x => x.id === candidateId);
    if (c) c.status = newStatus;

    renderHighlights();
    renderCandidateList();
    renderPageNavigator();
    updateStats();
    updateProgress();
}

async function batchAction(action, target) {
    const count = state.candidates.filter(c => c.status === target).length;
    if (count === 0) {
        alert(`No ${target} items to update.`);
        return;
    }

    const verb = action === 'approve_all' ? 'approve (redact)' : 'reject (keep)';
    if (!confirm(`${verb} all ${count} ${target} items across all pages?`)) return;

    await fetch(`/api/sar/${state.sarId}/batch-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, target }),
    });

    await loadCandidates();
    renderHighlights();
    renderCandidateList();
    renderPageNavigator();
}

async function approveAllOnPage() {
    const pageFlagged = state.candidates.filter(c =>
        c.source_file === state.currentFile &&
        c.page_num === state.currentPage &&
        c.status === 'flagged'
    );
    if (pageFlagged.length === 0) {
        alert('No flagged items on this page.');
        return;
    }
    if (!confirm(`Approve (redact) all ${pageFlagged.length} flagged item(s) on this page?`)) return;

    await fetch(`/api/sar/${state.sarId}/batch-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: 'approve_all',
            target: 'flagged',
            scope: 'page',
            source_file: state.currentFile,
            page_num: state.currentPage,
        }),
    });

    await loadCandidates();
    renderHighlights();
    renderCandidateList();
    renderPageNavigator();
}

async function batchByText(text, action) {
    const eligible = state.candidates.filter(c =>
        c.text.trim().toLowerCase() === text.trim().toLowerCase() &&
        c.status !== 'excluded_subject' && c.status !== 'excluded_staff'
    );
    if (eligible.length === 0) return;

    const verb = action === 'redact_all' ? 'Redact' : 'Keep';
    if (!confirm(`${verb} all ${eligible.length} instance(s) of "${text}"?`)) return;

    await fetch(`/api/sar/${state.sarId}/batch-by-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, action }),
    });

    await loadCandidates();
    renderHighlights();
    renderCandidateList();
    renderPageNavigator();
}


// ─── Stats & Progress ──────────────────────────────────────────────────────

function updateStats() {
    const stats = document.getElementById('sidebar-stats');
    const auto = state.candidates.filter(c => c.status === 'auto_redact').length;
    const flagged = state.candidates.filter(c => c.status === 'flagged').length;
    const approved = state.candidates.filter(c => c.status === 'approved').length;
    const rejected = state.candidates.filter(c => c.status === 'rejected').length;
    const excluded = state.candidates.filter(c =>
        c.status === 'excluded_subject' || c.status === 'excluded_staff'
    ).length;

    stats.innerHTML = `
        <span class="stat stat-redact">${auto + approved} redacting</span>
        <span class="stat stat-flagged">${flagged} to review</span>
        <span class="stat stat-rejected">${rejected} kept</span>
        <span class="stat stat-excluded">${excluded} excluded</span>
    `;
}

function updateProgress() {
    const total = state.candidates.length;
    const reviewed = state.candidates.filter(c =>
        c.status !== 'flagged'
    ).length;
    const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;

    document.getElementById('progress-label').textContent = `${reviewed} of ${total} reviewed`;
    document.getElementById('progress-pct').textContent = `${pct}%`;
    document.getElementById('progress-fill').style.width = `${pct}%`;
}


// ─── Scroll Linking ────────────────────────────────────────────────────────

function scrollToCard(candidateId) {
    const card = document.getElementById(`card-${candidateId}`);
    if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('card-highlight');
        setTimeout(() => card.classList.remove('card-highlight'), 1500);
    }
}

function scrollToHighlight(candidateId) {
    const hl = document.querySelector(`.highlight[data-candidate-id="${candidateId}"]`);
    if (hl) {
        hl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        hl.classList.add('highlight-pulse');
        setTimeout(() => hl.classList.remove('highlight-pulse'), 1500);
    }
}


// ─── Colour Legend ─────────────────────────────────────────────────────────

function toggleLegend() {
    document.getElementById('colour-legend').classList.toggle('hidden');
}


// ─── Page Navigator ────────────────────────────────────────────────────────

function computePageStats() {
    const stats = {};
    // Initialise all pages with empty counts
    for (let i = 0; i < state.pageCount; i++) {
        stats[i] = { total: 0, flagged: 0, reviewed: 0 };
    }
    state.candidates.forEach(c => {
        if (c.source_file !== state.currentFile) return;
        if (c.status === 'excluded_subject' || c.status === 'excluded_staff') return;
        const s = stats[c.page_num];
        if (!s) return;
        s.total++;
        if (c.status === 'flagged') {
            s.flagged++;
        } else {
            s.reviewed++;
        }
    });
    return stats;
}

function renderPageNavigator() {
    const grid = document.getElementById('page-nav-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const stats = computePageStats();

    for (let i = 0; i < state.pageCount; i++) {
        const badge = document.createElement('button');
        badge.className = 'page-nav-badge';
        badge.textContent = i + 1;

        const s = stats[i];
        if (i === state.currentPage) {
            badge.classList.add('page-nav-current');
        }
        if (s.total === 0) {
            badge.classList.add('page-nav-empty');
        } else if (s.flagged > 0) {
            badge.classList.add('page-nav-flagged');
        } else {
            badge.classList.add('page-nav-done');
        }

        badge.title = s.total === 0
            ? `Page ${i + 1}: no candidates`
            : `Page ${i + 1}: ${s.reviewed}/${s.total} reviewed`;

        badge.addEventListener('click', () => goToPage(i));
        grid.appendChild(badge);
    }
}

function goToPage(n) {
    if (n < 0 || n >= state.pageCount || n === state.currentPage) return;
    state.currentPage = n;
    state.selectedIndex = -1;
    renderPage();
}

function togglePageNavigator() {
    document.getElementById('page-navigator').classList.toggle('hidden');
}


// ─── Draw Mode (drag-to-redact) ────────────────────────────────────────────

function toggleDrawMode() {
    state.drawMode = !state.drawMode;
    const btn = document.getElementById('btn-draw-mode');
    const container = document.getElementById('page-container');
    btn.classList.toggle('btn-active', state.drawMode);
    btn.textContent = state.drawMode ? 'Drawing…' : 'Draw';
    container.classList.toggle('draw-mode', state.drawMode);
    // Cancel any in-progress drag when toggling off
    if (!state.drawMode) {
        state._drag = null;
        const box = document.getElementById('drag-box');
        if (box) box.classList.add('hidden');
    }
}

function initDrawEvents() {
    const container = document.getElementById('page-container');

    // Create persistent drag-box element inside the container
    const dragBox = document.createElement('div');
    dragBox.id = 'drag-box';
    dragBox.className = 'drag-box hidden';
    container.appendChild(dragBox);

    container.addEventListener('mousedown', (e) => {
        if (!state.drawMode) return;
        // Only respond to left button
        if (e.button !== 0) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        state._drag = {
            startX: e.clientX - rect.left,
            startY: e.clientY - rect.top,
            curX: e.clientX - rect.left,
            curY: e.clientY - rect.top,
        };
        const box = document.getElementById('drag-box');
        box.style.left = `${state._drag.startX}px`;
        box.style.top = `${state._drag.startY}px`;
        box.style.width = '0px';
        box.style.height = '0px';
        box.classList.remove('hidden');
    });

    document.addEventListener('mousemove', (e) => {
        if (!state.drawMode || !state._drag) return;
        const rect = container.getBoundingClientRect();
        const curX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const curY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        state._drag.curX = curX;
        state._drag.curY = curY;

        const x = Math.min(curX, state._drag.startX);
        const y = Math.min(curY, state._drag.startY);
        const w = Math.abs(curX - state._drag.startX);
        const h = Math.abs(curY - state._drag.startY);

        const box = document.getElementById('drag-box');
        box.style.left = `${x}px`;
        box.style.top = `${y}px`;
        box.style.width = `${w}px`;
        box.style.height = `${h}px`;
    });

    document.addEventListener('mouseup', async (e) => {
        if (!state.drawMode || !state._drag) return;
        if (e.button !== 0) return;

        const drag = state._drag;
        state._drag = null;
        document.getElementById('drag-box').classList.add('hidden');

        const cssX0 = Math.min(drag.startX, drag.curX);
        const cssY0 = Math.min(drag.startY, drag.curY);
        const cssX1 = Math.max(drag.startX, drag.curX);
        const cssY1 = Math.max(drag.startY, drag.curY);

        // Ignore tiny boxes (accidental clicks)
        if (cssX1 - cssX0 < 5 || cssY1 - cssY0 < 5) return;

        // Convert CSS pixel coords → PDF point coords
        const scale = state.zoom * state.displayScale;
        const x0 = cssX0 / scale;
        const y0 = cssY0 / scale;
        const x1 = cssX1 / scale;
        const y1 = cssY1 / scale;

        await submitManualRedaction(x0, y0, x1, y1);
    });
}

async function submitManualRedaction(x0, y0, x1, y1) {
    const resp = await fetch(`/api/sar/${state.sarId}/manual-redact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            page_num: state.currentPage,
            source_file: state.currentFile,
            x0, y0, x1, y1,
        }),
    });
    if (!resp.ok) {
        alert('Failed to add manual redaction.');
        return;
    }
    const candidate = await resp.json();
    state.candidates.push(candidate);
    renderHighlights();
    renderCandidateList();
    updateStats();
    updateProgress();
}


// ─── Notes ─────────────────────────────────────────────────────────────────

async function loadNotes() {
    try {
        const resp = await fetch(`/api/sar/${state.sarId}/notes`);
        const data = await resp.json();
        document.getElementById('notes-textarea').value = data.notes || '';
    } catch (e) { /* ignore */ }
}

function initNotesAutosave() {
    let timeout;
    const textarea = document.getElementById('notes-textarea');
    const saved = document.getElementById('notes-saved');

    textarea.addEventListener('input', () => {
        clearTimeout(timeout);
        saved.classList.remove('visible');
        timeout = setTimeout(async () => {
            await fetch(`/api/sar/${state.sarId}/notes`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notes: textarea.value }),
            });
            saved.classList.add('visible');
            setTimeout(() => saved.classList.remove('visible'), 2000);
        }, 800);
    });
}


// ─── Confirmation Modal ────────────────────────────────────────────────────

function showConfirmModal() {
    const auto = state.candidates.filter(c => c.status === 'auto_redact').length;
    const approved = state.candidates.filter(c => c.status === 'approved').length;
    const rejected = state.candidates.filter(c => c.status === 'rejected').length;
    const flagged = state.candidates.filter(c => c.status === 'flagged').length;
    const excluded = state.candidates.filter(c =>
        c.status === 'excluded_subject' || c.status === 'excluded_staff'
    ).length;

    const summary = document.getElementById('confirm-summary');
    summary.innerHTML = `
        <div class="confirm-stat confirm-stat-redact">
            <span class="confirm-stat-value">${auto + approved}</span>
            <span class="confirm-stat-label">Will be redacted</span>
        </div>
        <div class="confirm-stat confirm-stat-keep">
            <span class="confirm-stat-value">${rejected}</span>
            <span class="confirm-stat-label">Kept visible</span>
        </div>
        <div class="confirm-stat confirm-stat-excl">
            <span class="confirm-stat-value">${excluded}</span>
            <span class="confirm-stat-label">Excluded</span>
        </div>
        <div class="confirm-stat confirm-stat-flag">
            <span class="confirm-stat-value">${flagged}</span>
            <span class="confirm-stat-label">Still flagged</span>
        </div>
    `;

    const warning = document.getElementById('confirm-warning');
    if (flagged > 0) {
        warning.innerHTML = `<div class="confirm-warning">${flagged} item(s) still flagged — these will NOT be redacted.</div>`;
    } else {
        warning.innerHTML = '';
    }

    document.getElementById('confirm-overlay').classList.remove('hidden');
}

function hideConfirmModal() {
    document.getElementById('confirm-overlay').classList.add('hidden');
}

async function proceedFinalise() {
    hideConfirmModal();
    document.getElementById('finalise-overlay').classList.remove('hidden');

    try {
        const resp = await fetch(`/api/sar/${state.sarId}/finalise`, { method: 'POST' });
        if (!resp.ok) {
            let msg = 'Finalisation failed';
            try {
                const err = await resp.json();
                msg = err.error || msg;
            } catch (_) {
                msg = `Server error (${resp.status})`;
            }
            throw new Error(msg);
        }

        window.location.href = `/complete/${state.sarId}`;
    } catch (err) {
        document.getElementById('finalise-overlay').classList.add('hidden');
        alert(`Error: ${err.message}`);
    }
}


// ─── Keyboard Shortcuts ────────────────────────────────────────────────────

const EXEMPTION_KEYS = ['', 'third_party', 'serious_harm', 'crime_prevention',
    'legal_privilege', 'management_forecast', 'confidential_ref',
    'child_abuse', 'regulatory', 'national_security'];

function toggleShortcutsOverlay() {
    document.getElementById('shortcuts-overlay').classList.toggle('hidden');
}

function cycleFilter() {
    const sel = document.getElementById('filter-select');
    const opts = Array.from(sel.options).map(o => o.value);
    const idx = opts.indexOf(sel.value);
    const next = opts[(idx + 1) % opts.length];
    sel.value = next;
    applyFilter(next);
}

async function setExemptionCode(candidateId, code) {
    await fetch(`/api/sar/${state.sarId}/candidate/${candidateId}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exemption_code: code }),
    });
    const cand = state.candidates.find(c => c.id === candidateId);
    if (cand) cand.exemption_code = code;
    renderCandidateList();
}

function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        const shortcutsVisible = !document.getElementById('shortcuts-overlay').classList.contains('hidden');

        // Escape works globally — priority chain
        if (e.key === 'Escape') {
            if (shortcutsVisible) {
                toggleShortcutsOverlay();
                return;
            }
            const searchInput = document.getElementById('search-input');
            if (document.activeElement === searchInput) {
                searchInput.value = '';
                performSearch('');
                searchInput.blur();
                return;
            }
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') {
                document.activeElement.blur();
                return;
            }
            if (state.drawMode) {
                toggleDrawMode();
                return;
            }
            state.selectedIndex = -1;
            renderCandidateList();
            return;
        }

        // ? works globally (toggle help)
        if (e.key === '?' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
            toggleShortcutsOverlay();
            return;
        }

        // If shortcuts overlay is visible, suppress all other keys
        if (shortcutsVisible) return;

        // / to focus search — works outside inputs
        if (e.key === '/' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
            e.preventDefault();
            document.getElementById('search-input').focus();
            return;
        }

        // Don't intercept when typing in inputs
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

        const pageCandidates = getFilteredPageCandidates();

        switch (e.key) {
            case 'ArrowDown':
            case 'j':
                e.preventDefault();
                if (pageCandidates.length > 0) {
                    state.selectedIndex = Math.min(state.selectedIndex + 1, pageCandidates.length - 1);
                    renderCandidateList();
                    const c = pageCandidates[state.selectedIndex];
                    if (c) {
                        scrollToCard(c.id);
                        scrollToHighlight(c.id);
                    }
                }
                break;

            case 'ArrowUp':
            case 'k':
                e.preventDefault();
                if (pageCandidates.length > 0) {
                    state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
                    renderCandidateList();
                    const c2 = pageCandidates[state.selectedIndex];
                    if (c2) {
                        scrollToCard(c2.id);
                        scrollToHighlight(c2.id);
                    }
                }
                break;

            case 'a':
            case 'A':
                if (state.selectedIndex >= 0 && state.selectedIndex < pageCandidates.length) {
                    const c3 = pageCandidates[state.selectedIndex];
                    if (c3.status !== 'excluded_subject' && c3.status !== 'excluded_staff') {
                        const isRedacting = c3.status === 'auto_redact' || c3.status === 'approved';
                        updateCandidate(c3.id, isRedacting ? 'flagged' : 'approved');
                    }
                }
                break;

            case 'x':
            case 'X':
                if (state.selectedIndex >= 0 && state.selectedIndex < pageCandidates.length) {
                    const c4 = pageCandidates[state.selectedIndex];
                    if (c4.status !== 'excluded_subject' && c4.status !== 'excluded_staff') {
                        const isKept = c4.status === 'rejected';
                        updateCandidate(c4.id, isKept ? 'flagged' : 'rejected');
                    }
                }
                break;

            case 'ArrowRight':
                if (!e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    nextPage();
                }
                break;

            case 'ArrowLeft':
                if (!e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    prevPage();
                }
                break;

            case 'd':
                toggleDrawMode();
                break;

            case 'f':
                cycleFilter();
                break;

            case 'g':
                toggleViewMode();
                break;

            case 'm':
                togglePageNavigator();
                break;

            case 'l':
                toggleLegend();
                break;

            case 'n':
                e.preventDefault();
                document.getElementById('notes-textarea').focus();
                break;

            case '1': case '2': case '3': case '4': case '5':
            case '6': case '7': case '8': case '9':
                if (state.selectedIndex >= 0 && state.selectedIndex < pageCandidates.length) {
                    const c5 = pageCandidates[state.selectedIndex];
                    if (c5.status !== 'excluded_subject' && c5.status !== 'excluded_staff') {
                        const codeIdx = parseInt(e.key);
                        if (codeIdx < EXEMPTION_KEYS.length) {
                            setExemptionCode(c5.id, EXEMPTION_KEYS[codeIdx]);
                        }
                    }
                }
                break;

            case '0':
                if (state.selectedIndex >= 0 && state.selectedIndex < pageCandidates.length) {
                    const c6 = pageCandidates[state.selectedIndex];
                    if (c6.status !== 'excluded_subject' && c6.status !== 'excluded_staff') {
                        setExemptionCode(c6.id, '');
                    }
                }
                break;
        }
    });
}


// ─── Utility ───────────────────────────────────────────────────────────────

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}


// ─── Search Across All Pages ────────────────────────────────────────────────

function initSearch() {
    const input = document.getElementById('search-input');
    if (!input) return;

    let debounceTimer;
    input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            performSearch(input.value.trim());
        }, 200);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            input.value = '';
            performSearch('');
            input.blur();
        }
    });
}

function performSearch(query) {
    const resultsDiv = document.getElementById('search-results');
    if (!query) {
        resultsDiv.classList.add('hidden');
        resultsDiv.innerHTML = '';
        // Remove search highlights
        document.querySelectorAll('.highlight-search-match').forEach(el =>
            el.classList.remove('highlight-search-match')
        );
        return;
    }

    const q = query.toLowerCase();
    const matches = state.candidates.filter(c =>
        c.text.toLowerCase().includes(q) &&
        c.status !== 'excluded_subject' && c.status !== 'excluded_staff'
    );

    renderSearchResults(matches, query);

    // Highlight matching candidates on current page
    document.querySelectorAll('.highlight').forEach(el => {
        const cid = el.dataset.candidateId;
        const cand = matches.find(m => m.id === cid);
        if (cand) {
            el.classList.add('highlight-search-match');
        } else {
            el.classList.remove('highlight-search-match');
        }
    });
}

function renderSearchResults(matches, query) {
    const resultsDiv = document.getElementById('search-results');
    if (matches.length === 0) {
        resultsDiv.classList.remove('hidden');
        resultsDiv.innerHTML = '<div class="search-no-results">No matches found</div>';
        return;
    }

    // Group unique text values for "Redact All"
    const uniqueTexts = [...new Set(matches.map(m => m.text.trim().toLowerCase()))];

    let html = `
        <div class="search-results-header">
            <span>${matches.length} match${matches.length !== 1 ? 'es' : ''} across ${uniqueTexts.length} term${uniqueTexts.length !== 1 ? 's' : ''}</span>
            <button class="btn-sm btn-sm-approve search-redact-all" onclick="redactAllSearchMatches()">Redact All</button>
        </div>
        <div class="search-results-list">
    `;

    // Show up to 50 results
    const shown = matches.slice(0, 50);
    for (const m of shown) {
        const statusLabel = {
            'flagged': 'Flagged', 'auto_redact': 'Auto', 'approved': 'Approved', 'rejected': 'Kept'
        }[m.status] || m.status;
        html += `
            <div class="search-result-item" onclick="navigateToCandidate('${m.id}', '${escapeHtml(m.source_file)}', ${m.page_num})">
                <span class="search-result-text">"${escapeHtml(m.text)}"</span>
                <span class="search-result-meta">${escapeHtml(m.source_file)} p${m.page_num + 1}</span>
                <span class="status-badge status-badge-${m.status}">${statusLabel}</span>
            </div>
        `;
    }
    if (matches.length > 50) {
        html += `<div class="search-more">...and ${matches.length - 50} more</div>`;
    }
    html += '</div>';
    resultsDiv.innerHTML = html;
    resultsDiv.classList.remove('hidden');
}

function navigateToCandidate(candidateId, sourceFile, pageNum) {
    // Switch file if needed
    if (state.currentFile !== sourceFile) {
        const selector = document.getElementById('file-selector');
        selector.value = sourceFile;
        state.currentFile = sourceFile;
        const info = state.filesInfo.find(f => f.name === sourceFile);
        state.pageCount = info ? info.pages : 1;
    }

    // Switch page if needed
    state.currentPage = pageNum;
    state.selectedIndex = -1;

    // Render and scroll after image loads
    const img = document.getElementById('page-image');
    img.src = `/api/sar/${state.sarId}/page-image/${encodeURIComponent(state.currentFile)}/${state.currentPage}`;

    // Update page indicator
    document.getElementById('btn-prev').disabled = state.currentPage === 0;
    document.getElementById('btn-next').disabled = state.currentPage >= state.pageCount - 1;
    document.getElementById('page-indicator').textContent =
        `Page ${state.currentPage + 1} / ${state.pageCount}`;

    img.onload = () => {
        _applyDisplayZoom(img);
        renderHighlights();
        renderCandidateList();

        // Find index and scroll
        const pageCandidates = getFilteredPageCandidates();
        const idx = pageCandidates.findIndex(c => c.id === candidateId);
        if (idx >= 0) {
            state.selectedIndex = idx;
            renderCandidateList();
            scrollToCard(candidateId);
            scrollToHighlight(candidateId);
        }

        // Re-apply search highlighting
        const searchInput = document.getElementById('search-input');
        if (searchInput && searchInput.value.trim()) {
            performSearch(searchInput.value.trim());
        }
    };
}

async function redactAllSearchMatches() {
    const searchInput = document.getElementById('search-input');
    const query = searchInput ? searchInput.value.trim() : '';
    if (!query) return;

    const q = query.toLowerCase();
    const matches = state.candidates.filter(c =>
        c.text.toLowerCase().includes(q) &&
        c.status !== 'excluded_subject' && c.status !== 'excluded_staff'
    );
    if (matches.length === 0) return;

    if (!confirm(`Redact all ${matches.length} match(es) for "${query}"?`)) return;

    // Group by unique text values and batch-redact each
    const uniqueTexts = [...new Set(matches.map(m => m.text.trim()))];
    for (const text of uniqueTexts) {
        await fetch(`/api/sar/${state.sarId}/batch-by-text`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, action: 'redact_all' }),
        });
    }

    await loadCandidates();
    renderHighlights();
    renderCandidateList();
    performSearch(query);
}

// ── Detection Settings ───────────────────────────────────────────────
async function showDetectionSettings() {
    try {
        const resp = await fetch(`/api/sar/${state.sarId}/detection-settings`);
        if (!resp.ok) throw new Error('Failed to load settings');
        const s = await resp.json();
        document.getElementById('auto-thresh-slider').value = s.auto_redact_threshold;
        document.getElementById('auto-thresh-val').textContent = s.auto_redact_threshold.toFixed(2);
        document.getElementById('flag-thresh-slider').value = s.flag_threshold;
        document.getElementById('flag-thresh-val').textContent = s.flag_threshold.toFixed(2);
        const boxes = document.querySelectorAll('#settings-categories input[type=checkbox]');
        boxes.forEach(cb => {
            cb.checked = s.enabled_categories.includes(cb.value);
        });
    } catch (e) {
        console.error(e);
    }
    document.getElementById('settings-overlay').classList.remove('hidden');
}

function hideDetectionSettings() {
    document.getElementById('settings-overlay').classList.add('hidden');
}

async function saveDetectionSettings() {
    const autoThresh = parseFloat(document.getElementById('auto-thresh-slider').value);
    const flagThresh = parseFloat(document.getElementById('flag-thresh-slider').value);
    const boxes = document.querySelectorAll('#settings-categories input[type=checkbox]');
    const enabled = [];
    boxes.forEach(cb => { if (cb.checked) enabled.push(cb.value); });

    if (flagThresh >= autoThresh) {
        alert('Flag threshold must be lower than auto-redact threshold.');
        return;
    }

    hideDetectionSettings();

    const resp = await fetch(`/api/sar/${state.sarId}/detection-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            auto_redact_threshold: autoThresh,
            flag_threshold: flagThresh,
            enabled_categories: enabled,
        }),
    });
    if (!resp.ok) {
        alert('Failed to save settings.');
        return;
    }

    if (!confirm('Settings saved. Re-scan documents now to apply changes?')) return;

    const reparseResp = await fetch(`/api/sar/${state.sarId}/reparse`, { method: 'POST' });
    if (!reparseResp.ok) {
        alert('Re-scan failed.');
        return;
    }
    const data = await reparseResp.json();
    const msg = data.new_found > 0
        ? `Re-scan complete. Found ${data.new_found} new match${data.new_found === 1 ? '' : 'es'}.`
        : 'Re-scan complete. No new matches found.';
    alert(msg);
    window.location.reload();
}

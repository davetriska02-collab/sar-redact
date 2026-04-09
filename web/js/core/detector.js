// detector.js — Ported from sar/detector.py
// Main PII detection orchestrator.
// Attaches all exports to window.SARCore namespace.

window.SARCore = window.SARCore || {};

// ── Staff label patterns ──────────────────────────────────────────────────────
// Used to detect names that appear in staff-labelled positions (Practitioner:,
// Record author:, etc.) so they can be excluded as staff rather than redacted.

// Matches the label prefix (case-insensitive), used to look back before a name.
var _STAFF_LABEL_RE = /(?:Practitioner|Record\s+author|Filed\s+by|Requested\s+by|Authorised\s+by|Discontinued\s+by|Performed\s+by|Cancellation\s+reason):\s*(?:(?:Mr|Mrs|Ms|Miss|Dr|Prof|Sister|Nurse|Rev|Mx)\.?\s+)*/i;

// Name component: [A-Z][a-z']+(?:-[A-Z][a-z']*)? (handles Smith-Jones)
var _NAME_COMPONENT = "[A-Z][a-z']+(?:-[A-Z][a-z']*)?";

// Extracts the staff name that follows a staff label field.
// Stops at § (field separator), newline, "at " (org separator), or end of string.
var _STAFF_NAME_EXTRACT_RE = new RegExp(
    '(?:Practitioner|Record\\s+author|Filed\\s+by|Requested\\s+by|' +
    'Authorised\\s+by|Discontinued\\s+by|Performed\\s+by)\\s*:\\s*' +
    '((?:(?:Mr|Mrs|Ms|Miss|Dr|Prof|Sister|Nurse|Rev|Mx)\\.?\\s+)?' +
    '(?:' + _NAME_COMPONENT + ')(?:[ \\t]+(?:' + _NAME_COMPONENT + ')){0,3})' +
    '(?=[ \\t]*(?:\\xa7|\\n|$|at\\s+[A-Z]))',
    'gi'
);

// ── Internal helpers ──────────────────────────────────────────────────────────

function _normalize(text) {
    return text.trim().toLowerCase();
}

function _stripPunctuation(text) {
    return text.replace(/^[\s.,;:'"\\-]+|[\s.,;:'"\\-]+$/g, '');
}

/**
 * Extract names that appear in staff-labelled positions on this page.
 * e.g. "Practitioner: Dr David Triska" → Set {"david triska", "dr david triska"}
 * @param {string} pageText
 * @returns {Set<string>}
 */
function _extractPageStaffNames(pageText) {
    var staff = new Set();
    var titles = new Set(["mr","mrs","ms","miss","dr","prof","sister","nurse","rev","mx"]);
    var re = new RegExp(_STAFF_NAME_EXTRACT_RE.source, 'gi');
    var m;
    while ((m = re.exec(pageText)) !== null) {
        var raw = m[1].trim();
        staff.add(_normalize(raw));
        // Also add without title prefix
        var parts = raw.split(/\s+/);
        while (parts.length > 0 && titles.has(parts[0].toLowerCase().replace(/\.$/, ''))) {
            parts.shift();
        }
        if (parts.length > 0) {
            staff.add(_normalize(parts.join(' ')));
        }
    }
    return staff;
}

/**
 * Check if the name at nameStart is directly preceded by a staff label.
 * Looks back up to 90 chars.
 * @param {string} pageText
 * @param {number} nameStart
 * @returns {boolean}
 */
function _isInStaffLabelContext(pageText, nameStart) {
    var pre = pageText.slice(Math.max(0, nameStart - 90), nameStart);
    return _STAFF_LABEL_RE.test(pre);
}

// ── isSubjectMatch ────────────────────────────────────────────────────────────

/**
 * Check if detected text matches the data subject's known details.
 * @param {string} entityText
 * @param {object} subject  SubjectDetails object
 * @returns {boolean}
 */
function isSubjectMatch(entityText, subject) {
    var cleaned = _normalize(_stripPunctuation(entityText));

    // Full name check
    if (subject.full_name) {
        if (cleaned === _normalize(subject.full_name)) return true;
        if (_normalize(subject.full_name).length > 0 && cleaned.includes(_normalize(subject.full_name))) return true;
    }

    // First name (only match single-word entities)
    if (subject.first_name) {
        var entityWords = cleaned.split(/\s+/);
        if (entityWords.length === 1 && entityWords[0] === _normalize(subject.first_name)) {
            return true;
        }
    }

    // Last name: match lone surname OR full name where first word also matches subject
    if (subject.last_name) {
        var subjLast = _normalize(subject.last_name);
        var entityWords2 = cleaned.split(/\s+/);
        if (entityWords2.includes(subjLast)) {
            if (entityWords2.length === 1) return true; // Lone surname
            if (subject.first_name && entityWords2.includes(_normalize(subject.first_name))) {
                return true; // Both first & last match subject
            }
        }
    }

    // Aliases
    if (subject.aliases) {
        for (var i = 0; i < subject.aliases.length; i++) {
            var alias = subject.aliases[i];
            if (alias && cleaned === _normalize(alias)) return true;
        }
    }

    // NHS number
    if (subject.nhs_number) {
        var strippedEntity = entityText.replace(/[\s\-]/g, '');
        var strippedSubject = subject.nhs_number.replace(/[\s\-]/g, '');
        if (strippedEntity === strippedSubject) return true;
    }

    // Date of birth
    if (subject.date_of_birth && cleaned === _normalize(subject.date_of_birth)) {
        return true;
    }

    // Phone
    if (subject.phone) {
        var strippedEntityPhone = entityText.replace(/[\s\-()]/g, '');
        var strippedSubjectPhone = subject.phone.replace(/[\s\-()]/g, '');
        if (strippedEntityPhone === strippedSubjectPhone) return true;
    }

    // Email
    if (subject.email && cleaned === _normalize(subject.email)) {
        return true;
    }

    // Address (70% word overlap)
    if (subject.address) {
        var stopwords = new Set(["the","a","an","and","of","in","at","on","to"]);
        var addrWords = new Set(_normalize(subject.address).split(/\s+/));
        var entityWordsSet = new Set(cleaned.split(/\s+/).filter(function(w) {
            return !stopwords.has(w);
        }));
        if (entityWordsSet.size > 0) {
            var overlap = 0;
            entityWordsSet.forEach(function(w) {
                if (addrWords.has(w)) overlap++;
            });
            if (overlap >= Math.max(1, entityWordsSet.size * 0.7)) return true;
        }
    }

    return false;
}

// ── isStaffName ───────────────────────────────────────────────────────────────

/**
 * Check if a detected name matches any member of the staff list.
 * Uses normalized comparison on full name and individual components.
 * @param {string} detectedName
 * @param {Array} staffList  Array of {name, role} objects
 * @returns {boolean}
 */
function isStaffName(detectedName, staffList) {
    if (!staffList || staffList.length === 0) return false;
    var titles = new Set(["dr","mr","mrs","ms","miss","prof","professor","nurse","sister"]);
    var normDetected = detectedName.trim().toLowerCase();
    var detectedParts = new Set(normDetected.split(/\s+/));

    for (var i = 0; i < staffList.length; i++) {
        var member = staffList[i];
        var staffName = member.name.trim().toLowerCase();
        var staffParts = new Set(staffName.split(/\s+/));

        // Exact match
        if (normDetected === staffName) return true;

        // Detected name is a component of a staff name
        if (staffParts.has(normDetected)) return true;

        // Meaningful overlap (excluding titles)
        var meaningfulDetected = new Set();
        detectedParts.forEach(function(p) { if (!titles.has(p)) meaningfulDetected.add(p); });
        var meaningfulStaff = new Set();
        staffParts.forEach(function(p) { if (!titles.has(p)) meaningfulStaff.add(p); });

        if (meaningfulDetected.size > 0 && meaningfulStaff.size > 0) {
            var hasOverlap = false;
            meaningfulDetected.forEach(function(p) {
                if (meaningfulStaff.has(p)) hasOverlap = true;
            });
            if (hasOverlap) return true;
        }
    }
    return false;
}

// ── mapTextToSpans ────────────────────────────────────────────────────────────

/**
 * Find TextSpan objects whose bounding boxes correspond to the given
 * character range in pageText.
 * @param {string} pageText
 * @param {Array} pageSpans  Array of TextSpan objects
 * @param {number} charStart
 * @param {number} charEnd
 * @returns {Array}
 */
function mapTextToSpans(pageText, pageSpans, charStart, charEnd) {
    var matching = [];
    var searchFrom = 0;

    for (var i = 0; i < pageSpans.length; i++) {
        var span = pageSpans[i];
        var pos = pageText.indexOf(span.text, searchFrom);
        if (pos === -1) {
            pos = pageText.indexOf(span.text);
        }
        if (pos === -1) continue;

        var spanEnd = pos + span.text.length;
        searchFrom = pos + 1;

        if (pos < charEnd && spanEnd > charStart) {
            matching.push(span);
        }
    }
    return matching;
}

// ── checkTextForRisk ──────────────────────────────────────────────────────────

/**
 * Check text against risk word dictionary.
 * Returns array of {phrase, category} matches.
 * @param {string} text
 * @param {object} riskWords  {category: [words...]}
 * @returns {Array}
 */
function checkTextForRisk(text, riskWords) {
    if (!text || !riskWords) return [];
    var results = [];
    var categories = Object.keys(riskWords);
    for (var i = 0; i < categories.length; i++) {
        var category = categories[i];
        var words = riskWords[category];
        for (var j = 0; j < words.length; j++) {
            var word = words[j];
            var escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            var re = new RegExp('\\b' + escaped + '\\b', 'i');
            if (re.test(text)) {
                results.push({ phrase: word, category: category });
            }
        }
    }
    return results;
}

// ── detectPII ─────────────────────────────────────────────────────────────────

/**
 * Detect third-party PII in page texts.
 * Combines rule-based name detection with regex patterns.
 *
 * @param {Array} pageTexts      Array of strings, one per page (0-indexed)
 * @param {Array} textSpansByPage  Array of arrays of TextSpan objects, one per page
 * @param {object} subject       SubjectDetails object
 * @param {Array} staffList      Array of {name, role} staff objects
 * @param {Array} customWords    Array of {phrase, case_sensitive} objects
 * @param {object} settings      DetectionSettings object
 * @param {object} riskWords     {category: [words...]} risk word dictionary
 * @param {string} sourceFilename
 * @returns {Array}  Array of RedactionCandidate objects
 */
function detectPII(pageTexts, textSpansByPage, subject, staffList, customWords, settings, riskWords, sourceFilename) {
    var PIICategory    = window.SARCore.PIICategory;
    var RedactionStatus = window.SARCore.RedactionStatus;
    var createRedactionCandidate = window.SARCore.createRedactionCandidate;
    var detectNames    = window.SARCore.detectNames;
    var findRegexMatches = window.SARCore.findRegexMatches;

    if (!settings) {
        settings = window.SARCore.createDetectionSettings();
    }

    var autoThresh = settings.auto_redact_threshold;
    var flagThresh = settings.flag_threshold;
    var enabled = new Set(settings.enabled_categories);
    var candidates = [];
    var titles = new Set(["mr","mrs","ms","miss","dr","prof","sister","nurse","rev","mx"]);

    for (var pageNum = 0; pageNum < pageTexts.length; pageNum++) {
        var pageText = pageTexts[pageNum] || '';
        if (!pageText.trim()) continue;

        var pageSpans = (textSpansByPage && textSpansByPage[pageNum]) || [];

        // Extract practitioner/author names from labelled fields on this page
        var pageStaffNames = _extractPageStaffNames(pageText);

        // ── Name detection ─────────────────────────────────────────────────────
        var nameMatches = detectNames(pageText);

        for (var ni = 0; ni < nameMatches.length; ni++) {
            var nm = nameMatches[ni];
            var entityText = _stripPunctuation(nm.text);
            if (!entityText) continue;

            if (isSubjectMatch(entityText, subject)) {
                candidates.push(createRedactionCandidate({
                    text:        entityText,
                    category:    PIICategory.PERSON_NAME,
                    status:      RedactionStatus.EXCLUDED_SUBJECT,
                    confidence:  1.0,
                    page_num:    pageNum,
                    reason:      'Matched data subject',
                    source_file: sourceFilename || '',
                }));
                continue;
            }

            // Check staff list and contextual staff names
            var entityNorm = _normalize(entityText);
            var entityWords = entityNorm.split(/\s+/);
            var entityNoTitle = entityWords.filter(function(w, i) {
                return !(i === 0 && titles.has(w.replace(/\.$/, '')));
            }).join(' ');

            var inStaffLabel = _isInStaffLabelContext(pageText, nm.start);
            var inPageStaff = pageStaffNames.has(entityNorm) || pageStaffNames.has(entityNoTitle);

            if (isStaffName(entityText, staffList) || inStaffLabel || inPageStaff) {
                var staffReason = 'Matched staff list';
                if (inStaffLabel) {
                    staffReason = 'Name in staff-labelled field (Practitioner/Author)';
                } else if (inPageStaff) {
                    staffReason = 'Name matched practitioner on this page';
                }
                candidates.push(createRedactionCandidate({
                    text:        entityText,
                    category:    PIICategory.PERSON_NAME,
                    status:      RedactionStatus.EXCLUDED_STAFF,
                    confidence:  1.0,
                    page_num:    pageNum,
                    reason:      staffReason,
                    source_file: sourceFilename || '',
                }));
                continue;
            }

            var matchedSpans = mapTextToSpans(pageText, pageSpans, nm.start, nm.end);
            var x0, y0, x1, y1;
            if (matchedSpans.length > 0) {
                x0 = Math.min.apply(null, matchedSpans.map(function(s) { return s.x0; }));
                y0 = Math.min.apply(null, matchedSpans.map(function(s) { return s.y0; }));
                x1 = Math.max.apply(null, matchedSpans.map(function(s) { return s.x1; }));
                y1 = Math.max.apply(null, matchedSpans.map(function(s) { return s.y1; }));
            } else {
                x0 = y0 = x1 = y1 = 0;
            }

            var confidence = nm.confidence;
            var status = (confidence >= autoThresh)
                ? RedactionStatus.AUTO_REDACT
                : RedactionStatus.FLAGGED;

            candidates.push(createRedactionCandidate({
                text:        entityText,
                category:    PIICategory.PERSON_NAME,
                status:      status,
                confidence:  confidence,
                page_num:    pageNum,
                x0: x0, y0: y0, x1: x1, y1: y1,
                reason:      nm.reason,
                source_file: sourceFilename || '',
            }));
        }

        // ── Regex detection ────────────────────────────────────────────────────
        var regexMatches = findRegexMatches(pageText, pageNum);

        for (var ri = 0; ri < regexMatches.length; ri++) {
            var rm = regexMatches[ri];
            var rEntityText = rm.text;

            if (isSubjectMatch(rEntityText, subject)) {
                candidates.push(createRedactionCandidate({
                    text:        rEntityText,
                    category:    rm.category,
                    status:      RedactionStatus.EXCLUDED_SUBJECT,
                    confidence:  1.0,
                    page_num:    pageNum,
                    reason:      'Matched data subject (' + rm.category + ')',
                    source_file: sourceFilename || '',
                }));
                continue;
            }

            var rMatchedSpans = mapTextToSpans(pageText, pageSpans, rm.start, rm.end);
            var rx0, ry0, rx1, ry1;
            if (rMatchedSpans.length > 0) {
                rx0 = Math.min.apply(null, rMatchedSpans.map(function(s) { return s.x0; }));
                ry0 = Math.min.apply(null, rMatchedSpans.map(function(s) { return s.y0; }));
                rx1 = Math.max.apply(null, rMatchedSpans.map(function(s) { return s.x1; }));
                ry1 = Math.max.apply(null, rMatchedSpans.map(function(s) { return s.y1; }));
            } else {
                rx0 = ry0 = rx1 = ry1 = 0;
            }

            var rConf = rm.confidence;
            var rStatus = (rConf >= autoThresh)
                ? RedactionStatus.AUTO_REDACT
                : RedactionStatus.FLAGGED;

            candidates.push(createRedactionCandidate({
                text:        rEntityText,
                category:    rm.category,
                status:      rStatus,
                confidence:  rConf,
                page_num:    pageNum,
                x0: rx0, y0: ry0, x1: rx1, y1: ry1,
                reason:      rm.reason,
                source_file: sourceFilename || '',
            }));
        }

        // ── Custom word detection ──────────────────────────────────────────────
        if (customWords && customWords.length > 0) {
            for (var ci = 0; ci < customWords.length; ci++) {
                var cw = customWords[ci];
                var phrase = cw.phrase;
                var escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                var cwFlags = cw.case_sensitive ? 'g' : 'gi';
                var cwRe = new RegExp('\\b' + escaped + '\\b', cwFlags);
                var cwM;
                while ((cwM = cwRe.exec(pageText)) !== null) {
                    var cwSpans = mapTextToSpans(pageText, pageSpans, cwM.index, cwM.index + cwM[0].length);
                    var cwx0, cwy0, cwx1, cwy1;
                    if (cwSpans.length > 0) {
                        cwx0 = Math.min.apply(null, cwSpans.map(function(s) { return s.x0; }));
                        cwy0 = Math.min.apply(null, cwSpans.map(function(s) { return s.y0; }));
                        cwx1 = Math.max.apply(null, cwSpans.map(function(s) { return s.x1; }));
                        cwy1 = Math.max.apply(null, cwSpans.map(function(s) { return s.y1; }));
                    } else {
                        cwx0 = cwy0 = cwx1 = cwy1 = 0;
                    }
                    candidates.push(createRedactionCandidate({
                        text:        cwM[0],
                        category:    PIICategory.CUSTOM_WORD,
                        status:      RedactionStatus.AUTO_REDACT,
                        confidence:  1.0,
                        page_num:    pageNum,
                        x0: cwx0, y0: cwy0, x1: cwx1, y1: cwy1,
                        reason:      'Custom redaction word/phrase',
                        source_file: sourceFilename || '',
                    }));
                }
            }
        }
    }

    // ── Deduplicate & filter ───────────────────────────────────────────────────
    var seen = new Set();
    var deduped = [];
    var excludedStatuses = new Set([
        RedactionStatus.EXCLUDED_SUBJECT,
        RedactionStatus.EXCLUDED_STAFF,
    ]);

    for (var di = 0; di < candidates.length; di++) {
        var c = candidates[di];

        // Filter by enabled categories (always keep excluded items for audit trail)
        if (!enabled.has(c.category) && !excludedStatuses.has(c.status)) {
            continue;
        }

        var key = _normalize(c.text) + '|' + c.page_num + '|' + (c.source_file || '') + '|' + c.category;
        if (!seen.has(key)) {
            seen.add(key);
            // Compute risk flags
            if (!c.risk_flags || c.risk_flags.length === 0) {
                c.risk_flags = checkTextForRisk(c.text, riskWords);
            }
            deduped.push(c);
        }
    }

    return deduped;
}


// ── Exports ───────────────────────────────────────────────────────────────────

window.SARCore.isSubjectMatch    = isSubjectMatch;
window.SARCore.isStaffName       = isStaffName;
window.SARCore.mapTextToSpans    = mapTextToSpans;
window.SARCore.checkTextForRisk  = checkTextForRisk;
window.SARCore.detectPII         = detectPII;

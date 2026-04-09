// nhs-patterns.js — Ported from sar/nhs_patterns.py
// Attach all exports to window.SARCore namespace.

window.SARCore = window.SARCore || {};

// ── NHS Number ────────────────────────────────────────────────────────────────
// 10 digits, optionally in 3-3-4 groups separated by spaces or hyphens.

var NHS_NUMBER_PATTERN = /\b(\d{3}[\s\-]?\d{3}[\s\-]?\d{4})\b/g;

/**
 * Validate an NHS number using the Modulus 11 check digit algorithm.
 * @param {string} candidate
 * @returns {boolean}
 */
function validateNhsNumber(candidate) {
    var digitsOnly = candidate.replace(/[\s\-]/g, '');
    if (digitsOnly.length !== 10 || !/^\d+$/.test(digitsOnly)) {
        return false;
    }
    var total = 0;
    for (var i = 0; i < 9; i++) {
        total += parseInt(digitsOnly[i], 10) * (10 - i);
    }
    var remainder = total % 11;
    var check = 11 - remainder;
    if (check === 11) check = 0;
    if (check === 10) return false;
    return check === parseInt(digitsOnly[9], 10);
}

// ── UK Phone Numbers ──────────────────────────────────────────────────────────
// Matches landlines, mobiles and +44 international format.

var UK_PHONE_PATTERN = /\b((?:0\d{2,4}[\s\-]?\d{3,4}[\s\-]?\d{3,4})|(?:\+44[\s\-]?\d{2,4}[\s\-]?\d{3,4}[\s\-]?\d{3,4})|(?:07\d{3}[\s\-]?\d{3}[\s\-]?\d{3}))\b/g;

// ── UK Postcodes ──────────────────────────────────────────────────────────────

var UK_POSTCODE_PATTERN = /\b([A-Z]{1,2}[0-9][0-9A-Z]?\s?[0-9][A-Z]{2})\b/gi;

// ── Email Addresses ───────────────────────────────────────────────────────────

var EMAIL_PATTERN = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;

// ── Safeguarding Patterns ─────────────────────────────────────────────────────
// Each entry: [RegExp, label]
// Always flagged for review — never auto-redact.

var _SAFEGUARDING_PATTERNS = [
    [/\bsafeguarding\b/gi,                                                   "Safeguarding reference"],
    [/\bdomestic\s+(?:abuse|violence)\b/gi,                                  "Domestic abuse/violence"],
    [/\b(?:child\s+protection|child\s+at\s+risk|children\s+at\s+risk|child\s+in\s+need)\b/gi, "Child protection"],
    [/\b(?:non[-\s]accidental\s+injury|NAI)\b/gi,                            "Non-accidental injury (NAI)"],
    [/\bMARAC\b/gi,                                                           "MARAC referral"],
    [/\b(?:FGM|female\s+genital\s+mutilation)\b/gi,                          "FGM reference"],
    [/\bat\s+risk\s+of\s+(?:harm|abuse)\b/gi,                                "At risk of harm/abuse"],
    [/\bvulnerable\s+adult\b/gi,                                              "Vulnerable adult"],
    [/\b(?:physical|emotional|sexual)\s+abuse\b/gi,                          "Abuse type reference"],
    [/\bneglect(?:ed)?\b/gi,                                                  "Neglect reference"],
    [/\b(?:DA|DV)\s+referral\b/gi,                                            "DA/DV referral"],
    [/\bsocial\s+services\s+referral\b/gi,                                    "Social services referral"],
];

// ── Sexual Health Patterns ────────────────────────────────────────────────────
// Always flagged for human review — never auto-redact.

var _SEXUAL_HEALTH_PATTERNS = [
    [/\bHIV\b|\bhuman\s+immunodeficiency\s+virus\b/gi,                       "HIV reference"],
    [/\bAIDS\b|\bacquired\s+immuno?deficiency\s+syndrome\b/gi,               "AIDS reference"],
    [/\bchlamydia\b/gi,                                                       "STI: Chlamydia"],
    [/\bgonorrh(?:oe|e)a\b/gi,                                               "STI: Gonorrhoea"],
    [/\bsyphilis\b/gi,                                                        "STI: Syphilis"],
    [/\b(?:genital\s+herpes|HSV[-\s]?[12])\b/gi,                             "STI: Herpes"],
    [/\b(?:genital\s+warts?|HPV|human\s+papillomavirus)\b/gi,                "HPV/genital warts"],
    [/\btrichomonas(?:is)?\b/gi,                                             "STI: Trichomonas"],
    [/\b(?:sexually\s+transmitted\s+(?:infection|disease)|STI|STD)\b/gi,     "STI/STD reference"],
    [/\b(?:GUM\s+clinic|sexual\s+health\s+clinic|genitourinary\s+medicine)\b/gi, "Sexual health clinic"],
    [/\b(?:sexual\s+assault|rape)\b/gi,                                       "Sexual assault/rape"],
    // PrEP/PEP: no /i flag in Python original — case-sensitive
    [/\b(?:PrEP|PEP)\b/g,                                                     "HIV prevention medication"],
];

// ── findRegexMatches ──────────────────────────────────────────────────────────

/**
 * Scan text for regex-detectable PII patterns.
 * Returns array of match objects: {text, category, start, end, confidence, reason}.
 *
 * @param {string} text  - Full page text
 * @param {number} pageNum - Zero-based page number (unused here, kept for API parity)
 * @returns {Array}
 */
function findRegexMatches(text, pageNum) {
    var matches = [];
    var PIICategory = window.SARCore.PIICategory;

    // ── NHS numbers ───────────────────────────────────────────────────────────
    var nhsRe = new RegExp(NHS_NUMBER_PATTERN.source, 'g');
    var m;
    while ((m = nhsRe.exec(text)) !== null) {
        var candidate = m[1];
        if (validateNhsNumber(candidate)) {
            matches.push({
                text:       candidate,
                category:   PIICategory.NHS_NUMBER,
                start:      m.index + (m[0].length - m[1].length),
                end:        m.index + (m[0].length - m[1].length) + m[1].length,
                confidence: 0.95,
                reason:     "Valid NHS number (Modulus 11 verified)",
            });
        }
    }

    // Helper: get capture-group 1 start/end
    function capturePos(match, fullStr) {
        // m[0] is full match, m[1] is first capture group.
        // The capture group starts at the same position as the full match when
        // there are no pre-group chars (which is true for all our patterns here
        // since the \b and outer groups align). We recalculate via indexOf.
        var groupStart = fullStr.indexOf(match[1], match.index);
        if (groupStart === -1) groupStart = match.index;
        return { start: groupStart, end: groupStart + match[1].length };
    }

    // ── Phone numbers ─────────────────────────────────────────────────────────
    var phoneRe = new RegExp(UK_PHONE_PATTERN.source, 'g');
    while ((m = phoneRe.exec(text)) !== null) {
        var pos = capturePos(m, text);
        matches.push({
            text:       m[1],
            category:   PIICategory.PHONE_NUMBER,
            start:      pos.start,
            end:        pos.end,
            confidence: 0.90,
            reason:     "UK phone number pattern",
        });
    }

    // ── Postcodes ─────────────────────────────────────────────────────────────
    var postcodeRe = new RegExp(UK_POSTCODE_PATTERN.source, 'gi');
    while ((m = postcodeRe.exec(text)) !== null) {
        var pos = capturePos(m, text);
        matches.push({
            text:       m[1],
            category:   PIICategory.POSTCODE,
            start:      pos.start,
            end:        pos.end,
            confidence: 0.75,
            reason:     "UK postcode pattern",
        });
    }

    // ── Email addresses ───────────────────────────────────────────────────────
    var emailRe = new RegExp(EMAIL_PATTERN.source, 'g');
    while ((m = emailRe.exec(text)) !== null) {
        var email = m[1].toLowerCase();
        // Skip common NHS/surgery domain emails
        if (email.endsWith('.nhs.uk') || email.endsWith('.nhs.net')) {
            continue;
        }
        var pos = capturePos(m, text);
        matches.push({
            text:       m[1],
            category:   PIICategory.EMAIL,
            start:      pos.start,
            end:        pos.end,
            confidence: 0.85,
            reason:     "Email address",
        });
    }

    // ── Safeguarding ──────────────────────────────────────────────────────────
    _SAFEGUARDING_PATTERNS.forEach(function (entry) {
        var re = new RegExp(entry[0].source, entry[0].flags);
        var reason = entry[1];
        while ((m = re.exec(text)) !== null) {
            matches.push({
                text:       m[0],
                category:   PIICategory.SAFEGUARDING,
                start:      m.index,
                end:        m.index + m[0].length,
                confidence: 0.75,
                reason:     reason,
            });
        }
    });

    // ── Sexual health ─────────────────────────────────────────────────────────
    _SEXUAL_HEALTH_PATTERNS.forEach(function (entry) {
        var re = new RegExp(entry[0].source, entry[0].flags);
        var reason = entry[1];
        while ((m = re.exec(text)) !== null) {
            matches.push({
                text:       m[0],
                category:   PIICategory.SEXUAL_HEALTH,
                start:      m.index,
                end:        m.index + m[0].length,
                confidence: 0.75,
                reason:     reason,
            });
        }
    });

    return matches;
}

// ── Exports ───────────────────────────────────────────────────────────────────

window.SARCore.NHS_NUMBER_PATTERN      = NHS_NUMBER_PATTERN;
window.SARCore.UK_PHONE_PATTERN        = UK_PHONE_PATTERN;
window.SARCore.UK_POSTCODE_PATTERN     = UK_POSTCODE_PATTERN;
window.SARCore.EMAIL_PATTERN           = EMAIL_PATTERN;
window.SARCore.validateNhsNumber       = validateNhsNumber;
window.SARCore.findRegexMatches        = findRegexMatches;

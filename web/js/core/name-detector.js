// name-detector.js — Ported from sar/name_detector.py
// Rule-based name detection for UK medical records.
// Attaches all exports to window.SARCore namespace.

window.SARCore = window.SARCore || {};

// ── UK Name Lists ─────────────────────────────────────────────────────────────
// Common UK first names drawn from ONS Baby Names top 500 lists + classic names.

var UK_FIRST_NAMES = new Set([
    // Top UK male names
    "oliver","george","harry","jack","noah","charlie","jacob","alfie","freddie",
    "oscar","james","william","thomas","henry","leo","ethan","joshua","archie",
    "alexander","joseph","samuel","edward","adam","max","lucas","mason","ibrahim",
    "muhammad","daniel","logan","tyler","jayden","ryan","isaac","harrison",
    "jake","riley","reuben","stanley","teddy","reggie","louie","theo","finn",
    "evan","luca","leon","sebastian","dominic","hugo","felix","elliot",
    "nathaniel","gabriel","albert","arthur","frankie","jenson","harley",
    "michael","david","christopher","andrew","mark","john","paul","stephen",
    "richard","robert","peter","alan","simon","graham","kevin","brian","gary",
    "ian","martin","neil","stuart","jonathan","matthew","nicholas","philip",
    "timothy","raymond","kenneth","patrick","derek","roger","geoffrey","ronald",
    "harold","donald","frank","ernest","walter","norman",
    "leonard","victor","clifford","reginald","gerald","douglas",
    "anthony","barry","terry","gordon","nigel","trevor","scott","wayne",
    "darren","dean","lee","jason","craig","steven","sean","keith",
    "colin","tony","dave","rob","pete","mike","nick","will","tom",
    // Top UK female names
    "olivia","amelia","isla","ava","mia","isabella","sophia","grace","lily",
    "freya","poppy","phoebe","daisy","charlotte","ella","emily","evie","ruby",
    "scarlett","alice","lucy","florence","lola","rose","millie","harriet",
    "ivy","sienna","eleanor","eliza","emma","maya","zoe","imogen","abigail",
    "ellie","sophie","jessica","bethany","molly","layla","amber","holly",
    "elsie","willow","violet","matilda","eva","bella","hannah","anna",
    "eve","faith","hope","summer","autumn","heather","janet","karen",
    "linda","barbara","patricia","margaret","elizabeth","helen","diane","susan",
    "carol","ann","claire","sarah","deborah","amanda","sharon","donna",
    "tracey","teresa","jacqueline","kathleen","jean","june","maureen","irene",
    "valerie","sandra","pamela","sheila","wendy","gillian","lesley","denise",
    "beverley","nicola","joanne","paula","alison","victoria","samantha",
    "rebecca","rachel","gemma","lisa","kerry","jade","stacey","hayley",
    "natalie","kelly","louise","amy","laura","michelle","jennifer",
    "maria","mary","anne","kate","katie","katherine","catherine",
    "diana","ruth","joan","dorothy","edna","doris","vera",
    "ethel","gladys","winifred","phyllis","constance","hilda",
    "mabel","beatrice","edith","gertrude","maud","agnes",
    "annie","clara","dora","ida","jane","lilly","louisa","maggie",
    "minnie","nellie","nora","winnie",
]);

// Common UK last names
var UK_LAST_NAMES = new Set([
    "smith","jones","williams","taylor","brown","davies","evans","wilson",
    "thomas","roberts","johnson","lewis","walker","robinson","wood","thompson",
    "white","watson","jackson","wright","green","harris","cooper","king",
    "lee","martin","clarke","james","morgan","hughes","edwards","hill",
    "moore","clark","harrison","scott","young","morris","hall","ward",
    "turner","campbell","mitchell","cook","carter","richardson","bailey",
    "collins","bell","shaw","murphy","miller","cox","rogers","kelly",
    "marshall","brooks","price","gray","henderson",
    "stone","newman","o'brien","mason","fox","mcdonald","fisher",
    "patel","ali","khan","hussain","begum","ahmed","hassan","miah","rahman",
    "islam","chowdhury","malik","kaur","singh","kumar","sharma",
    "rao","gupta","das","ghosh","nair","iyer","shah","mehta","verma",
    // Additional common UK surnames
    "simpson","pearson","butler","russell","barker","andrews","lawson",
    "hunt","cross","fletcher","harvey","stephens","griffin","foster",
    "hawkins","wade","atkinson","perkins","barlow","powell",
    "bates","burns","knight","west","webb","ryan","bond","grant",
    "jennings","gilbert","woods","reid","murray","dixon","barr",
    "bush","riley","obrien","norris","pearce","booth","stokes",
    "wilkins","farmer","yates","briggs","lawton","blake","wilkinson",
    "walters","gates","moran","holt","haynes","marsh","sutton","austin",
    "saunders","lloyd","berry","douglas","rowe","hamilton","gardner",
    "nicholson","long","higgins","newton","miles",
    "mccoy","mackenzie","mcbride","mcintyre","mckenzie","mclean",
    "overington","azadian","klepacka","triska","galloway","scholar",
    "thomason","sherrington","guerriero","nicholls","rayman","larder",
    "constantine","cockayne","moulds","geraint",
]);

// Titles that reliably precede names
var NAME_TITLES = new Set([
    "mr", "mrs", "ms", "miss", "dr", "prof", "professor",
    "rev", "reverend", "sir", "lord", "lady", "cllr", "councillor",
    "nurse", "sister", "brother", "fr", "father",
    "mx",
]);

// Words that look capitalised but are not names
var NOT_NAMES = new Set([
    // Medical
    "nhs", "gp", "a&e", "gmc", "hiv", "aids", "copd", "uti", "ibs", "ms",
    "adhd", "autism", "asthma", "cancer", "diabetes", "ecg", "mri", "ct",
    "xray", "scan", "ward", "clinic", "surgery", "hospital", "trust",
    // Months
    "january","february","march","april","may","june","july","august",
    "september","october","november","december",
    "jan","feb","mar","apr","jun","jul","aug","sep","oct","nov","dec",
    // Days
    "monday","tuesday","wednesday","thursday","friday","saturday","sunday",
    "mon","tue","wed","thu","fri","sat","sun",
    // Common non-name proper nouns
    "england","wales","scotland","uk","britain","london","manchester",
    "birmingham","leeds","liverpool","bristol","sheffield","nottingham",
    "leicester","coventry","bradford","belfast","edinburgh","glasgow",
    // Document terms
    "dear","sincerely","yours","regards","re","ref","subject","page",
    "date","time","tel","fax","email","please","thank","thanks",
    "faithfully","truly",
    // Section headers common in medical records
    "contacts","problems","active","past","history","examination","impression",
    "plan","procedure","comment","additional","document","attachment",
    "prescription","investigation","results","administration","consultation",
    "presenting","reason","linked","communication","note","record","filing",
    "performing","performer","requester","specimen","outbound","inbound",
    // UK street suffixes
    "lane","road","street","avenue","close","drive","place","court","way",
    "terrace","gardens","grove","crescent","mews","rise","walk","row",
]);

// ── Detection Patterns ────────────────────────────────────────────────────────
// Name component: Title-Cased word, including hyphenated forms like Smith-Jones
// or O'Brien. Matches: Smith, O'Brien, Smith-Jones, Al-Hassan, etc.
//
// Python: r"[A-Z][a-z\']+(?:-[A-Z][a-z\']+)*"
// JS version: same pattern (case-sensitive where needed)

var _NAME_WORD = "[A-Z][a-z']+(?:-[A-Z][a-z']+)*";
var _NAME_WORD_LONG = "[A-Z][a-z']{2,}(?:-[A-Z][a-z']+)*";

// Pattern 1: Title followed by optional initial and surname.
// Python used (?i:...) inline flag for the title part only, keeping name parts
// case-sensitive. In JavaScript there is no per-group flag, so we spell out the
// title keywords as case-insensitive character classes and compile WITHOUT the
// /i flag so that _NAME_WORD [A-Z][a-z']+ remains strictly Title-Case.
//
// Matches: Dr Smith, mr J. Smith, Mrs Jane Smith, Mrs Smith-Jones, Prof. Williams
var _TITLE_KW =
    '[Mm][Rr]\\.?|[Mm][Rr][Ss]\\.?|[Mm][Ss]\\.?|[Mm][Ii][Ss][Ss]|' +
    '[Dd][Rr]\\.?|[Pp][Rr][Oo][Ff]\\.?|[Pp]rofessor|[Rr][Ee][Vv]\\.?|[Rr]everend|' +
    '[Ss][Ii][Rr]|[Ll][Oo][Rr][Dd]|[Ll][Aa][Dd][Yy]|' +
    '[Nn][Uu][Rr][Ss][Ee]|[Ss][Ii][Ss][Tt][Ee][Rr]|[Bb][Rr][Oo][Tt][Hh][Ee][Rr]|' +
    '[Mm][Xx]\\.?';

var TITLE_NAME_PATTERN = new RegExp(
    '\\b' +
    '(' + _TITLE_KW + ')' +
    '\\s+' +
    '(?:[A-Z]\\.?\\s+)?' +           // Optional initial
    '(' + _NAME_WORD + ')' +          // First surname component (case-sensitive)
    '(?:\\s+(' + _NAME_WORD + '))?' + // Optional second name component
    '\\b'
    // No /i flag — name components [A-Z][a-z'] remain case-sensitive
);

// Pattern 2: "Dear [Title] [Name]" (letters)
// "Dear" itself is case-insensitive; name part must be Title-Cased.
var DEAR_PATTERN = new RegExp(
    '[Dd][Ee][Aa][Rr]\\s+(?:' + _TITLE_KW + ')?\\s*' +
    '(' + _NAME_WORD + '(?:\\s+' + _NAME_WORD + ')?)\\b'
);

// Pattern 3: Relational context — "patient's mother Sarah", "carer John"
// Relation keywords are case-insensitive (given as alternation); name part
// must be Title-Cased (case-sensitive [A-Z][a-z']+).
var RELATIONAL_PATTERN = new RegExp(
    '\\b(?:[Mm]other|[Ff]ather|[Ss]on|[Dd]aughter|[Ss]ister|[Bb]rother|' +
    '[Ww]ife|[Hh]usband|[Pp]artner|[Cc]arer|[Gg]uardian|[Pp]arent|' +
    '[Gg]randparent|[Gg]randmother|[Gg]randfather|[Uu]ncle|[Aa]unt|' +
    '[Nn]ephew|[Nn]iece|[Ff]riend|[Nn]eighbour|' +
    '[Nn]ext\\s+[Oo]f\\s+[Kk]in|[Nn][Oo][Kk])\\s+' +
    '(?:[Ii]s\\s+|[Ww]as\\s+|[Cc]alled\\s+|[Nn]amed\\s+)?' +
    '(' + _NAME_WORD + '(?:\\s+' + _NAME_WORD + ')?)\\b'
);

// Pattern 4: "Name (Relationship)" — e.g. "Adam Simpson (Husband)"
// High confidence. Name must be at least two Title-Cased words on same line.
// Relationship keyword is case-insensitive (listed as alternation).
var NAME_WITH_RELATION_PATTERN = new RegExp(
    '\\b(' + _NAME_WORD + '(?:[ \\t]+' + _NAME_WORD + ')+)[ \\t]*\\(' +
    '(?:[Hh]usband|[Ww]ife|[Pp]artner|[Mm]other|[Ff]ather|[Ss]on|[Dd]aughter|' +
    '[Bb]rother|[Ss]ister|[Uu]ncle|[Aa]unt|[Nn]ephew|[Nn]iece|' +
    '[Gg]randson|[Gg]randdaughter|[Gg]randparent|[Gg]randfather|[Gg]randmother|' +
    '[Gg]uardian|[Cc]arer|[Ff]riend|[Nn]eighbour|' +
    '[Nn]ext\\s+[Oo]f\\s+[Kk]in|NOK|[Ee]x-?[Hh]usband|[Ee]x-?[Ww]ife|[Ee]x-?[Pp]artner|' +
    '[Ss]tepmother|[Ss]tepfather|[Ss]tepson|[Ss]tepdaughter)' +
    '\\)'
);

// Pattern 5: Full name (two consecutive Title-Cased words on the same line,
// at least one of which is a known name) — lower confidence.
// Uses [ \t]+ to avoid crossing newlines (same as Python).
var FULL_NAME_PATTERN = new RegExp(
    '\\b(' + _NAME_WORD_LONG + ')(?:[ \\t]+[A-Z]\\.?[ \\t]+|[ \\t]+)(' + _NAME_WORD_LONG + ')\\b'
);


// ── Helper: isValidNameWord ───────────────────────────────────────────────────

/**
 * Return true if word could plausibly be a name component.
 * @param {string} word
 * @returns {boolean}
 */
function isValidNameWord(word) {
    var w = word.toLowerCase().replace(/[.,;:]+$/, '');
    if (NOT_NAMES.has(w)) return false;
    if (w.length < 2) return false;
    if (/^\d+$/.test(w)) return false;
    return true;
}


// ── Main detection function ───────────────────────────────────────────────────

/**
 * Detect potential third-party names in text using rule-based patterns.
 * Returns array of NameMatch objects sorted by position.
 *
 * Each NameMatch: {text, start, end, confidence, reason}
 *
 * @param {string} text
 * @returns {Array}
 */
function detectNames(text) {
    var matches = [];
    var seenSpans = []; // [{start, end}]

    function addMatch(nm) {
        // Avoid duplicate overlapping spans
        for (var i = 0; i < seenSpans.length; i++) {
            if (nm.start < seenSpans[i].end && nm.end > seenSpans[i].start) {
                return;
            }
        }
        matches.push(nm);
        seenSpans.push({ start: nm.start, end: nm.end });
    }

    var m;

    // ── Pattern 1: Title + Name (highest confidence) ──────────────────────────
    // TITLE_NAME_PATTERN has no /i flag (title keywords use inline char classes).
    // Just add /g for the exec loop.
    var titleRe = new RegExp(TITLE_NAME_PATTERN.source, 'g');
    while ((m = titleRe.exec(text)) !== null) {
        var title = m[1];
        var surname = m[2];
        var extra = m[3];

        if (!surname) continue;
        if (!isValidNameWord(surname)) continue;

        var namePart = extra ? (surname + ' ' + extra) : surname;
        var fullText = title + ' ' + namePart;

        addMatch({
            text:       fullText,
            start:      m.index,
            end:        m.index + m[0].length,
            confidence: 0.90,
            reason:     'Name with title (' + title + ')',
        });
    }

    // ── Pattern 2: Dear [Name] ────────────────────────────────────────────────
    // DEAR_PATTERN uses inline char-class case-insensitivity; add only /g here.
    var dearRe = new RegExp(DEAR_PATTERN.source, 'g');
    while ((m = dearRe.exec(text)) !== null) {
        if (!m[1]) continue;
        var nameText = m[1].trim();
        var firstWord = nameText.split(/\s+/)[0];
        if (!isValidNameWord(firstWord)) continue;

        // Find actual start/end of the capture group
        var groupStart = text.indexOf(m[1], m.index);
        if (groupStart === -1) groupStart = m.index;
        var groupEnd = groupStart + m[1].length;

        addMatch({
            text:       nameText,
            start:      groupStart,
            end:        groupEnd,
            confidence: 0.85,
            reason:     'Name in salutation (Dear...)',
        });
    }

    // ── Pattern 3: Relational context ────────────────────────────────────────
    var relRe = new RegExp(RELATIONAL_PATTERN.source, 'g');
    while ((m = relRe.exec(text)) !== null) {
        if (!m[1]) continue;
        var nameText = m[1].trim();
        var firstWord = nameText.split(/\s+/)[0];
        if (!isValidNameWord(firstWord)) continue;

        var groupStart = text.indexOf(m[1], m.index);
        if (groupStart === -1) groupStart = m.index;
        var groupEnd = groupStart + m[1].length;

        addMatch({
            text:       nameText,
            start:      groupStart,
            end:        groupEnd,
            confidence: 0.80,
            reason:     'Name in relational context',
        });
    }

    // ── Pattern 4: Name (Relationship) ───────────────────────────────────────
    var relBracketRe = new RegExp(NAME_WITH_RELATION_PATTERN.source, 'g');
    while ((m = relBracketRe.exec(text)) !== null) {
        if (!m[1]) continue;
        var nameText = m[1].trim();
        var words = nameText.split(/\s+/);
        var allValid = words.every(function(w) { return isValidNameWord(w); });
        if (!allValid) continue;

        var groupStart = text.indexOf(m[1], m.index);
        if (groupStart === -1) groupStart = m.index;
        var groupEnd = groupStart + m[1].length;

        // Skip if already covered by a higher-confidence pattern
        var alreadyCovered = seenSpans.some(function(sp) {
            return groupStart >= sp.start && groupEnd <= sp.end;
        });
        if (alreadyCovered) continue;

        addMatch({
            text:       nameText,
            start:      groupStart,
            end:        groupEnd,
            confidence: 0.92,
            reason:     'Name with relational bracket (e.g. Husband, Carer)',
        });
    }

    // ── Pattern 5: Two capitalised words (same line), at least one known name ─
    var fullNameRe = new RegExp(FULL_NAME_PATTERN.source, 'g');
    while ((m = fullNameRe.exec(text)) !== null) {
        if (!m[1] || !m[2]) continue;
        var word1 = m[1].toLowerCase();
        var word2 = m[2].toLowerCase();
        var fullText = m[0];

        // Skip if already covered by a higher-confidence pattern
        var alreadyCovered = seenSpans.some(function(sp) {
            return m.index >= sp.start && (m.index + m[0].length) <= sp.end;
        });
        if (alreadyCovered) continue;

        // At least one word must be a known UK first or last name
        var isName = (
            UK_FIRST_NAMES.has(word1) || UK_LAST_NAMES.has(word1) ||
            UK_FIRST_NAMES.has(word2) || UK_LAST_NAMES.has(word2)
        );
        if (!isName) continue;

        if (!isValidNameWord(m[1]) || !isValidNameWord(m[2])) continue;

        addMatch({
            text:       fullText,
            start:      m.index,
            end:        m.index + m[0].length,
            confidence: 0.65,
            reason:     'Full name (capitalised words, known name)',
        });
    }

    // Sort by position
    matches.sort(function(a, b) { return a.start - b.start; });
    return matches;
}


// ── Exports ───────────────────────────────────────────────────────────────────

window.SARCore.UK_FIRST_NAMES          = UK_FIRST_NAMES;
window.SARCore.UK_LAST_NAMES           = UK_LAST_NAMES;
window.SARCore.NAME_TITLES             = NAME_TITLES;
window.SARCore.NOT_NAMES               = NOT_NAMES;
window.SARCore.TITLE_NAME_PATTERN      = TITLE_NAME_PATTERN;
window.SARCore.DEAR_PATTERN            = DEAR_PATTERN;
window.SARCore.RELATIONAL_PATTERN      = RELATIONAL_PATTERN;
window.SARCore.NAME_WITH_RELATION_PATTERN = NAME_WITH_RELATION_PATTERN;
window.SARCore.FULL_NAME_PATTERN       = FULL_NAME_PATTERN;
window.SARCore.isValidNameWord         = isValidNameWord;
window.SARCore.detectNames             = detectNames;

// storage.js — IndexedDB wrapper for browser-side persistence.
// Stores SAR requests, staff list, custom words, risk words, and uploaded files.
// Attaches all exports to window.SARCore namespace.

window.SARCore = window.SARCore || {};

// ── Database configuration ────────────────────────────────────────────────────

var DB_NAME    = 'sar-redact';
var DB_VERSION = 1;

// Object store names
var STORE_SARS        = 'sars';
var STORE_STAFF       = 'staff';
var STORE_CUSTOM_WORDS = 'customWords';
var STORE_RISK_WORDS  = 'riskWords';
var STORE_FILES       = 'files';

var _db = null; // Cached database connection

// ── initDB ────────────────────────────────────────────────────────────────────

/**
 * Open (or create) the IndexedDB database.
 * Must be called before any other storage operations.
 * @returns {Promise<IDBDatabase>}
 */
async function initDB() {
    if (_db) return _db;

    return new Promise(function(resolve, reject) {
        var request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = function(event) {
            var db = event.target.result;

            // SARs — keyed by sar.id
            if (!db.objectStoreNames.contains(STORE_SARS)) {
                var sarStore = db.createObjectStore(STORE_SARS, { keyPath: 'id' });
                sarStore.createIndex('workflow_status', 'workflow_status', { unique: false });
                sarStore.createIndex('last_modified',   'last_modified',   { unique: false });
            }

            // Staff list — single record keyed by a fixed key 'list'
            if (!db.objectStoreNames.contains(STORE_STAFF)) {
                db.createObjectStore(STORE_STAFF, { keyPath: 'key' });
            }

            // Custom words — single record keyed by 'list'
            if (!db.objectStoreNames.contains(STORE_CUSTOM_WORDS)) {
                db.createObjectStore(STORE_CUSTOM_WORDS, { keyPath: 'key' });
            }

            // Risk words — single record keyed by 'dict'
            if (!db.objectStoreNames.contains(STORE_RISK_WORDS)) {
                db.createObjectStore(STORE_RISK_WORDS, { keyPath: 'key' });
            }

            // Files — compound key [sarId, filename]
            if (!db.objectStoreNames.contains(STORE_FILES)) {
                var fileStore = db.createObjectStore(STORE_FILES, { keyPath: ['sarId', 'filename'] });
                fileStore.createIndex('sarId', 'sarId', { unique: false });
            }
        };

        request.onsuccess = function(event) {
            _db = event.target.result;
            resolve(_db);
        };

        request.onerror = function(event) {
            reject(new Error('IndexedDB open failed: ' + event.target.error));
        };
    });
}

// ── Generic IDB helpers ───────────────────────────────────────────────────────

function _tx(storeName, mode) {
    return _db.transaction([storeName], mode);
}

function _idbRequest(req) {
    return new Promise(function(resolve, reject) {
        req.onsuccess = function() { resolve(req.result); };
        req.onerror   = function() { reject(req.error); };
    });
}

// ── SAR operations ────────────────────────────────────────────────────────────

/**
 * Save (create or update) a SAR request.
 * @param {object} sar  SARRequest object
 * @returns {Promise<void>}
 */
async function saveSAR(sar) {
    await initDB();
    sar.last_modified = new Date().toISOString();
    var store = _tx(STORE_SARS, 'readwrite').objectStore(STORE_SARS);
    await _idbRequest(store.put(sar));
}

/**
 * Load a SAR request by ID.
 * @param {string} id
 * @returns {Promise<object|undefined>}
 */
async function loadSAR(id) {
    await initDB();
    var store = _tx(STORE_SARS, 'readonly').objectStore(STORE_SARS);
    return _idbRequest(store.get(id));
}

/**
 * List all SAR summaries (id, created_at, subject name, workflow_status, due_date).
 * @returns {Promise<Array>}
 */
async function listSARs() {
    await initDB();
    var store = _tx(STORE_SARS, 'readonly').objectStore(STORE_SARS);
    var all = await _idbRequest(store.getAll());
    // Return lightweight summaries sorted by last_modified descending
    var summaries = all.map(function(sar) {
        return {
            id:              sar.id,
            created_at:      sar.created_at,
            last_modified:   sar.last_modified,
            due_date:        sar.due_date,
            workflow_status: sar.workflow_status,
            status:          sar.status,
            subject_name:    (sar.subject && sar.subject.full_name) || '',
            pdf_files:       (sar.pdf_files || []).length,
            candidate_count: (sar.candidates || []).length,
        };
    });
    summaries.sort(function(a, b) {
        return (b.last_modified || '').localeCompare(a.last_modified || '');
    });
    return summaries;
}

/**
 * Delete a SAR request and its associated files.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function deleteSAR(id) {
    await initDB();
    var store = _tx(STORE_SARS, 'readwrite').objectStore(STORE_SARS);
    await _idbRequest(store.delete(id));
    await deleteFiles(id);
}

// ── File operations ───────────────────────────────────────────────────────────

/**
 * Store an uploaded PDF in IndexedDB.
 * @param {string}      sarId
 * @param {string}      filename
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<void>}
 */
async function saveFile(sarId, filename, arrayBuffer) {
    await initDB();
    var store = _tx(STORE_FILES, 'readwrite').objectStore(STORE_FILES);
    await _idbRequest(store.put({
        sarId:    sarId,
        filename: filename,
        data:     arrayBuffer,
        saved_at: new Date().toISOString(),
    }));
}

/**
 * Retrieve a stored PDF.
 * @param {string} sarId
 * @param {string} filename
 * @returns {Promise<ArrayBuffer|undefined>}
 */
async function loadFile(sarId, filename) {
    await initDB();
    var store = _tx(STORE_FILES, 'readonly').objectStore(STORE_FILES);
    var record = await _idbRequest(store.get([sarId, filename]));
    return record ? record.data : undefined;
}

/**
 * Delete all files associated with a SAR.
 * @param {string} sarId
 * @returns {Promise<void>}
 */
async function deleteFiles(sarId) {
    await initDB();
    var tx    = _db.transaction([STORE_FILES], 'readwrite');
    var store = tx.objectStore(STORE_FILES);
    var index = store.index('sarId');
    var keys  = await _idbRequest(index.getAllKeys(sarId));
    for (var i = 0; i < keys.length; i++) {
        await _idbRequest(store.delete(keys[i]));
    }
}

// ── Staff list ────────────────────────────────────────────────────────────────

/**
 * Retrieve the staff list.
 * @returns {Promise<Array>}  Array of {name, role} objects
 */
async function getStaffList() {
    await initDB();
    var store  = _tx(STORE_STAFF, 'readonly').objectStore(STORE_STAFF);
    var record = await _idbRequest(store.get('list'));
    return record ? record.value : [];
}

/**
 * Save the staff list.
 * @param {Array} list  Array of {name, role} objects
 * @returns {Promise<void>}
 */
async function saveStaffList(list) {
    await initDB();
    var store = _tx(STORE_STAFF, 'readwrite').objectStore(STORE_STAFF);
    await _idbRequest(store.put({ key: 'list', value: list }));
}

// ── Custom words ──────────────────────────────────────────────────────────────

/**
 * Retrieve the custom words list.
 * @returns {Promise<Array>}  Array of {phrase, case_sensitive} objects
 */
async function getCustomWords() {
    await initDB();
    var store  = _tx(STORE_CUSTOM_WORDS, 'readonly').objectStore(STORE_CUSTOM_WORDS);
    var record = await _idbRequest(store.get('list'));
    return record ? record.value : [];
}

/**
 * Save the custom words list.
 * @param {Array} words  Array of {phrase, case_sensitive} objects
 * @returns {Promise<void>}
 */
async function saveCustomWords(words) {
    await initDB();
    var store = _tx(STORE_CUSTOM_WORDS, 'readwrite').objectStore(STORE_CUSTOM_WORDS);
    await _idbRequest(store.put({ key: 'list', value: words }));
}

// ── Risk words ────────────────────────────────────────────────────────────────

/**
 * Retrieve the risk word dictionary.
 * @returns {Promise<object>}  {category: [words...]}
 */
async function getRiskWords() {
    await initDB();
    var store  = _tx(STORE_RISK_WORDS, 'readonly').objectStore(STORE_RISK_WORDS);
    var record = await _idbRequest(store.get('dict'));
    return record ? record.value : {};
}

/**
 * Save the risk word dictionary.
 * @param {object} words  {category: [words...]}
 * @returns {Promise<void>}
 */
async function saveRiskWords(words) {
    await initDB();
    var store = _tx(STORE_RISK_WORDS, 'readwrite').objectStore(STORE_RISK_WORDS);
    await _idbRequest(store.put({ key: 'dict', value: words }));
}

// ── Exports ───────────────────────────────────────────────────────────────────

window.SARCore.initDB        = initDB;
window.SARCore.saveSAR       = saveSAR;
window.SARCore.loadSAR       = loadSAR;
window.SARCore.listSARs      = listSARs;
window.SARCore.deleteSAR     = deleteSAR;
window.SARCore.saveFile      = saveFile;
window.SARCore.loadFile      = loadFile;
window.SARCore.deleteFiles   = deleteFiles;
window.SARCore.getStaffList  = getStaffList;
window.SARCore.saveStaffList = saveStaffList;
window.SARCore.getCustomWords  = getCustomWords;
window.SARCore.saveCustomWords = saveCustomWords;
window.SARCore.getRiskWords  = getRiskWords;
window.SARCore.saveRiskWords = saveRiskWords;

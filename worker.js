/* Legacy-Compatible Worker Logic with early logs */
self.postMessage({ type: 'log', msg: 'Worker script execution started' });

try {
    importScripts('https://cdn.jsdelivr.net/npm/fzstd@0.1.1/dist/index.min.js');
    self.postMessage({ type: 'log', msg: 'fzstd loaded' });
} catch (e) {
    self.postMessage({ type: 'log', msg: 'fzstd load FAILED: ' + e.message });
}

function log(msg) {
    self.postMessage({ type: 'log', msg: msg });
}

var db = null;
var DB_NAME = 'WebPConverterDB';
var STORE_NAME = 'blobs';
var totalFiles = 0;
var fileMetadata = [];

function initDB(cb) {
    log("initDB start...");
    try {
        var request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = function (e) {
            log("IDB upgrade needed");
            var db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = function (e) {
            log("IDB open success");
            db = e.target.result;
            var trans = db.transaction(STORE_NAME, 'readwrite');
            trans.objectStore(STORE_NAME).clear().onsuccess = function () {
                log("IDB cleared");
                cb();
            };
        };
        request.onerror = function (e) {
            log("IDB open ERROR: " + e.target.error);
            self.postMessage({ type: 'error', error: 'DB Init Failed: ' + e.target.error });
        }
    } catch (e) {
        log("IDB Catch: " + e.message);
        cb(); // Continue without DB if needed, though it might OOM later
    }
}

self.onmessage = function (e) {
    var d = e.data;
    log("Worker message received: " + d.type);
    try {
        if (d.type === 'start') {
            totalFiles = d.total;
            fileMetadata = [];
            initDB(function () {
                log("Starting request-next");
                self.postMessage({ type: 'request-next' });
            });
        }
        else if (d.type === 'process-file') {
            processOne(d.file, d.index);
        }
        else if (d.type === 'finalize') {
            finalize();
        }
    } catch (err) {
        log("Worker Fatal: " + err.message);
        self.postMessage({ type: 'error', error: err.message });
    }
};

function processOne(file, index) {
    self.postMessage({
        type: 'progress',
        progress: Math.floor((index / totalFiles) * 85),
        filename: file.name
    });

    log("processOne: " + file.name);
    var reader = new FileReader();
    reader.onload = function (event) {
        log("FileReader done: " + file.name);
        var blob = new Blob([event.target.result], { type: file.type });

        if (typeof createImageBitmap !== 'undefined') {
            log("Calling createImageBitmap...");
            createImageBitmap(blob).then(function (img) {
                renderAndSave(img, file.name, index);
            }).catch(function (err) {
                log("Bitmap Error: " + err.message);
                self.postMessage({ type: 'error', error: err.message });
            });
        } else {
            log("ERR: createImageBitmap unsupported in Worker");
            self.postMessage({ type: 'error', error: 'createImageBitmap unsupported' });
        }
    };
    reader.onerror = function () { log("FileReader ERR: " + file.name); };
    reader.readAsArrayBuffer(file);
}

function renderAndSave(img, originalName, index) {
    log("renderAndSave: " + originalName);
    if (typeof OffscreenCanvas === 'undefined') {
        log("ERR: OffscreenCanvas unsupported");
        self.postMessage({ type: 'error', error: 'OffscreenCanvas unsupported' });
        return;
    }

    var canvas = new OffscreenCanvas(img.width, img.height);
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    log("Calling convertToBlob...");
    canvas.convertToBlob({ type: 'image/webp', quality: 0.8 }).then(function (webpBlob) {
        log("WebP Blob size: " + webpBlob.size);
        img.close();
        var reader = new FileReader();
        reader.onload = function (e) {
            var data = new Uint8Array(e.target.result);
            if (db) {
                var trans = db.transaction(STORE_NAME, 'readwrite');
                trans.objectStore(STORE_NAME).put(data, index).onsuccess = function () {
                    var webpName = originalName.replace(/\.[^/.]+$/, "") + ".webp";
                    fileMetadata.push({ name: webpName, size: data.length });
                    self.postMessage({ type: 'request-next' });
                };
            } else {
                // No DB fallback (dangerous for memory but works for small batches)
                var webpName = originalName.replace(/\.[^/.]+$/, "") + ".webp";
                fileMetadata.push({ name: webpName, data: data, size: data.length });
                self.postMessage({ type: 'request-next' });
            }
        };
        reader.readAsArrayBuffer(webpBlob);
    }).catch(function (err) {
        log("Convert Error: " + err.message);
    });
}

function finalize() {
    log("Finalizing...");
    var totalTarSize = 0;
    for (var i = 0; i < fileMetadata.length; i++) {
        totalTarSize += 512 + (Math.ceil(fileMetadata[i].size / 512) * 512);
    }
    totalTarSize += 1024;

    var tarBuffer = new Uint8Array(totalTarSize);
    var offset = 0;

    var processNextTar = function (idx) {
        if (idx >= fileMetadata.length) {
            log("Zstd Compress start...");
            try {
                var compressed = fzstd.compress(tarBuffer);
                log("Compress done. Result: " + compressed.length);
                self.postMessage({ type: 'done', result: new Blob([compressed], { type: 'application/zstd' }) });
            } catch (e) {
                log("Compress ERR: " + e.message);
                self.postMessage({ type: 'error', error: e.message });
            }
            return;
        }

        var meta = fileMetadata[idx];
        if (db) {
            var trans = db.transaction(STORE_NAME, 'readonly');
            trans.objectStore(STORE_NAME).get(idx).onsuccess = function (e) {
                writeToTar(e.target.result, meta, idx);
            };
        } else {
            writeToTar(meta.data, meta, idx);
        }
    };

    function writeToTar(data, meta, idx) {
        var h = new Uint8Array(512);
        var nameStr = meta.name;
        for (var j = 0; j < Math.min(nameStr.length, 99); j++) h[j] = nameStr.charCodeAt(j);
        var sizeStr = data.length.toString(8);
        while (sizeStr.length < 11) sizeStr = "0" + sizeStr;
        for (var j = 0; j < 11; j++) h[124 + j] = sizeStr.charCodeAt(j);
        h[156] = 48;
        var magic = "ustar\u000000";
        for (var j = 0; j < 8; j++) headerMagic(h, j, magic[j]);
        var chk = 0; for (var j = 0; j < 512; j++) chk += (j >= 148 && j < 156) ? 32 : h[j];
        var chkStr = chk.toString(8); while (chkStr.length < 6) chkStr = "0" + chkStr;
        for (var j = 0; j < 6; j++) h[148 + j] = chkStr.charCodeAt(j);
        h[154] = 0; h[155] = 32;
        tarBuffer.set(h, offset); offset += 512;
        tarBuffer.set(data, offset); offset += Math.ceil(data.length / 512) * 512;
        processNextTar(idx + 1);
    }

    function headerMagic(h, j, char) { h[257 + j] = char.charCodeAt(0); }

    processNextTar(0);
}

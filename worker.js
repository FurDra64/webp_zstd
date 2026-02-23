/* Legacy-Compatible Worker Logic */
self.postMessage({ type: 'log', msg: 'Worker top-level execution' });

try {
    importScripts('https://cdn.jsdelivr.net/npm/fzstd@0.1.1/dist/index.min.js');
    self.postMessage({ type: 'log', msg: 'fzstd library loaded successfully' });
} catch (e) {
    self.postMessage({ type: 'log', msg: 'CRITICAL: fzstd load failed: ' + e.message });
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
    log("initDB: opening " + DB_NAME);
    try {
        var request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = function (e) {
            log("initDB: upgrade needed");
            var db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = function (e) {
            log("initDB: open success");
            db = e.target.result;
            var trans = db.transaction(STORE_NAME, 'readwrite');
            var store = trans.objectStore(STORE_NAME);
            store.clear().onsuccess = function () {
                log("initDB: store cleared");
                cb();
            };
        };
        request.onerror = function (e) {
            log("initDB: ERROR " + e.target.error);
            cb(); // Continue without DB
        }
    } catch (e) {
        log("initDB: CATCH " + e.message);
        cb();
    }
}

self.onmessage = function (e) {
    var d = e.data;
    log("Worker: onmessage received " + d.type);
    try {
        if (d.type === 'start') {
            totalFiles = d.total;
            fileMetadata = [];
            initDB(function () {
                log("Worker: Ready, requesting next file");
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
        log("Worker: Fatal Error " + err.message);
        self.postMessage({ type: 'error', error: err.message });
    }
};

function processOne(file, index) {
    log("Worker: Processing " + file.name + " (index " + index + ")");
    self.postMessage({
        type: 'progress',
        progress: Math.floor((index / totalFiles) * 85),
        filename: file.name
    });

    var reader = new FileReader();
    reader.onload = function (event) {
        log("Worker: FileReader loaded " + file.name);
        var blob = new Blob([event.target.result], { type: file.type });

        if (typeof createImageBitmap !== 'undefined') {
            log("Worker: createImageBitmap calling...");
            createImageBitmap(blob).then(function (img) {
                log("Worker: Bitmap created " + img.width + "x" + img.height);
                renderAndSave(img, file.name, index);
            }).catch(function (err) {
                log("Worker: Bitmap Error " + err.message);
                self.postMessage({ type: 'error', error: err.message });
            });
        } else {
            log("Worker: createImageBitmap NOT supported");
            self.postMessage({ type: 'error', error: 'createImageBitmap unsupported' });
        }
    };
    reader.onerror = function () { log("Worker: FileReader ERROR"); };
    reader.readAsArrayBuffer(file);
}

function renderAndSave(img, originalName, index) {
    if (typeof OffscreenCanvas === 'undefined') {
        log("Worker: OffscreenCanvas NOT supported");
        self.postMessage({ type: 'error', error: 'OffscreenCanvas unsupported' });
        return;
    }

    log("Worker: Drawing to canvas");
    var canvas = new OffscreenCanvas(img.width, img.height);
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    log("Worker: convertToBlob start");
    canvas.convertToBlob({ type: 'image/webp', quality: 0.8 }).then(function (webpBlob) {
        log("Worker: convertToBlob success, size " + webpBlob.size);
        img.close();
        var reader = new FileReader();
        reader.onload = function (e) {
            var data = new Uint8Array(e.target.result);
            if (db) {
                var trans = db.transaction(STORE_NAME, 'readwrite');
                trans.objectStore(STORE_NAME).put(data, index).onsuccess = function () {
                    log("Worker: Data saved to IDB " + originalName);
                    var webpName = originalName.replace(/\.[^/.]+$/, "") + ".webp";
                    fileMetadata.push({ name: webpName, size: data.length });
                    self.postMessage({ type: 'request-next' });
                };
            } else {
                log("Worker: Data saved to RAM (No DB)");
                var webpName = originalName.replace(/\.[^/.]+$/, "") + ".webp";
                fileMetadata.push({ name: webpName, data: data, size: data.length });
                self.postMessage({ type: 'request-next' });
            }
        };
        reader.readAsArrayBuffer(webpBlob);
    }).catch(function (err) {
        log("Worker: Convert Error " + err.message);
    });
}

function finalize() {
    log("Worker: finalize start");
    var totalTarSize = 0;
    for (var i = 0; i < fileMetadata.length; i++) {
        totalTarSize += 512 + (Math.ceil(fileMetadata[i].size / 512) * 512);
    }
    totalTarSize += 1024;

    log("Worker: Build TAR size " + totalTarSize);
    var tarBuffer = new Uint8Array(totalTarSize);
    var offset = 0;

    var processNextTar = function (idx) {
        if (idx >= fileMetadata.length) {
            log("Worker: Zstd compress start");
            try {
                var compressed = fzstd.compress(tarBuffer);
                log("Worker: Zstd success " + compressed.length);
                self.postMessage({ type: 'done', result: new Blob([compressed], { type: 'application/zstd' }) });
            } catch (e) {
                log("Worker: Zstd Error " + e.message);
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

        h[156] = 48; // File type '0'

        var magic = "ustar\u000000";
        for (var j = 0; j < 8; j++) h[257 + j] = magic.charCodeAt(j);

        var chk = 0; for (var j = 0; j < 512; j++) chk += (j >= 148 && j < 156) ? 32 : h[j];
        var chkStr = chk.toString(8); while (chkStr.length < 6) chkStr = "0" + chkStr;
        for (var j = 0; j < 6; j++) h[148 + j] = chkStr.charCodeAt(j);
        h[154] = 0; h[155] = 32;

        tarBuffer.set(h, offset);
        offset += 512;
        tarBuffer.set(data, offset);
        offset += Math.ceil(data.length / 512) * 512;

        if (idx % 20 === 0) self.postMessage({ type: 'progress', progress: 85 + Math.floor((idx / fileMetadata.length) * 10) });
        processNextTar(idx + 1);
    }

    processNextTar(0);
}

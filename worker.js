/* Legacy-Compatible Worker Logic */
importScripts('https://cdn.jsdelivr.net/npm/fzstd@0.1.1/dist/index.min.js');

function log(msg) {
    self.postMessage({ type: 'log', msg: msg });
}

var db = null;
var DB_NAME = 'WebPConverterDB';
var STORE_NAME = 'blobs';
var totalFiles = 0;
var fileMetadata = [];

function initDB(cb) {
    log("DB Init...");
    var request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
        }
    };
    request.onsuccess = function (e) {
        db = e.target.result;
        var trans = db.transaction(STORE_NAME, 'readwrite');
        trans.objectStore(STORE_NAME).clear().onsuccess = function () {
            cb();
        };
    };
    request.onerror = function (e) {
        log("DB Error");
        self.postMessage({ type: 'error', error: 'DB Init Failed' });
    }
}

self.onmessage = function (e) {
    var d = e.data;
    try {
        if (d.type === 'start') {
            totalFiles = d.total;
            fileMetadata = [];
            initDB(function () {
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
        log("Fatal: " + err.message);
        self.postMessage({ type: 'error', error: err.message });
    }
};

function processOne(file, index) {
    self.postMessage({
        type: 'progress',
        progress: Math.floor((index / totalFiles) * 85),
        filename: file.name
    });

    // Use FileReader for better compatibility in older WebKit
    var reader = new FileReader();
    reader.onload = function (event) {
        var blob = new Blob([event.target.result], { type: file.type });

        // createImageBitmap fallback check
        if (typeof createImageBitmap !== 'undefined') {
            createImageBitmap(blob).then(function (img) {
                renderAndSave(img, file.name, index);
            }).catch(function (err) {
                log("Bitmap Error: " + err.message);
            });
        } else {
            log("createImageBitmap not supported");
            // Here we would need a main-thread fallback usually
            self.postMessage({ type: 'error', error: 'createImageBitmap not supported' });
        }
    };
    reader.readAsArrayBuffer(file);
}

function renderAndSave(img, originalName, index) {
    if (typeof OffscreenCanvas === 'undefined') {
        log("No OffscreenCanvas");
        self.postMessage({ type: 'error', error: 'OffscreenCanvas not supported' });
        return;
    }

    var canvas = new OffscreenCanvas(img.width, img.height);
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    canvas.convertToBlob({ type: 'image/webp', quality: 0.8 }).then(function (webpBlob) {
        img.close();
        var reader = new FileReader();
        reader.onload = function (e) {
            var data = new Uint8Array(e.target.result);
            var trans = db.transaction(STORE_NAME, 'readwrite');
            trans.objectStore(STORE_NAME).put(data, index).onsuccess = function () {
                var webpName = originalName.replace(/\.[^/.]+$/, "") + ".webp";
                fileMetadata.push({ name: webpName, size: data.length });
                self.postMessage({ type: 'request-next' });
            };
        };
        reader.readAsArrayBuffer(webpBlob);
    }).catch(function (err) {
        log("Convert Error: " + err.message);
    });
}

function finalize() {
    log("Building Archive...");
    var totalTarSize = 0;
    for (var i = 0; i < fileMetadata.length; i++) {
        totalTarSize += 512 + (Math.ceil(fileMetadata[i].size / 512) * 512);
    }
    totalTarSize += 1024;

    var tarBuffer = new Uint8Array(totalTarSize);
    var offset = 0;

    var processNextTar = function (idx) {
        if (idx >= fileMetadata.length) {
            log("Zstd Compress...");
            var compressed = fzstd.compress(tarBuffer);
            self.postMessage({ type: 'done', result: new Blob([compressed], { type: 'application/zstd' }) });
            return;
        }

        var meta = fileMetadata[idx];
        var trans = db.transaction(STORE_NAME, 'readonly');
        trans.objectStore(STORE_NAME).get(idx).onsuccess = function (e) {
            var data = e.target.result;

            // Header
            var header = new Uint8Array(512);
            var nameStr = meta.name;
            for (var j = 0; j < Math.min(nameStr.length, 99); j++) header[j] = nameStr.charCodeAt(j);

            var sizeStr = data.length.toString(8);
            while (sizeStr.length < 11) sizeStr = "0" + sizeStr;
            for (var j = 0; j < 11; j++) header[124 + j] = sizeStr.charCodeAt(j);

            header.set([48], 156); // Type 0

            // Magic
            var magic = "ustar\u000000";
            for (var j = 0; j < 8; j++) header[257 + j] = magic.charCodeAt(j);

            // Simple Checksum
            var chk = 0;
            for (var j = 0; j < 512; j++) chk += (j >= 148 && j < 156) ? 32 : header[j];
            var chkStr = chk.toString(8);
            while (chkStr.length < 6) chkStr = "0" + chkStr;
            for (var j = 0; j < 6; j++) header[148 + j] = chkStr.charCodeAt(j);
            header[154] = 0; header[155] = 32;

            tarBuffer.set(header, offset);
            offset += 512;
            tarBuffer.set(data, offset);
            offset += Math.ceil(data.length / 512) * 512;

            if (idx % 10 === 0) self.postMessage({ type: 'progress', progress: 85 + Math.floor((idx / fileMetadata.length) * 10) });
            processNextTar(idx + 1);
        };
    };

    processNextTar(0);
}

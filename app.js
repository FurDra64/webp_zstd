/* Legacy-Compatible JS (ES5/ES6 simple) */
(function () {
    var dropZone = document.getElementById('drop-zone');
    var fileInput = document.getElementById('file-input');
    var fileList = document.getElementById('file-list');
    var fileListContainer = document.getElementById('file-list-container');
    var clearBtn = document.getElementById('clear-btn');
    var convertBtn = document.getElementById('convert-btn');
    var forceMainBtn = document.getElementById('force-main-btn');
    var progressContainer = document.getElementById('progress-container');
    var progressFill = document.getElementById('progress-fill');
    var statusText = document.getElementById('status-text');
    var debugLog = document.getElementById('debug-log');
    var zstd = null;

    function initZstd() {
        var startInit = null;
        if (typeof ZstdInit !== 'undefined') startInit = ZstdInit;
        else if (typeof zstdCodec !== 'undefined' && zstdCodec.ZstdInit) startInit = zstdCodec.ZstdInit;

        if (startInit) {
            startInit().then(function (instance) {
                zstd = instance;
                log("Zstd Library ready.");
            }).catch(function (err) {
                log("Zstd Init Error: " + err.message);
            });
        }
    }
    initZstd();

    var filesArray = [];
    var currentFileIndex = 0;
    var worker = null;

    function log(msg) {
        console.log(msg);
        var div = document.createElement('div');
        div.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
        debugLog.appendChild(div);
        debugLog.scrollTop = debugLog.scrollHeight;
    }

    log("Initial Check...");
    log("UserAgent: " + navigator.userAgent);

    var hasWorker = typeof Worker !== 'undefined';
    var hasOffscreen = typeof OffscreenCanvas !== 'undefined';
    log("Worker Support: " + hasWorker);
    log("OffscreenCanvas Support: " + hasOffscreen);

    dropZone.onclick = function () { fileInput.click(); };
    fileInput.onchange = function (e) {
        addFiles(e.target.files);
        fileInput.value = '';
    };

    function addFiles(files) {
        for (var i = 0; i < files.length; i++) {
            if (files[i].type.indexOf('image/') === 0) {
                filesArray.push(files[i]);
            }
        }
        updateUI();
    }

    function updateUI() {
        fileList.innerHTML = '';
        for (var i = 0; i < Math.min(filesArray.length, 50); i++) {
            var li = document.createElement('li');
            li.textContent = filesArray[i].name + " (" + Math.round(filesArray[i].size / 1024) + " KB)";
            fileList.appendChild(li);
        }
        if (filesArray.length > 50) {
            var li = document.createElement('li');
            li.textContent = "...他 " + (filesArray.length - 50) + " 件";
            fileList.appendChild(li);
        }
        fileListContainer.className = filesArray.length > 0 ? '' : 'hidden';
        convertBtn.disabled = filesArray.length === 0;
    }

    clearBtn.onclick = function () {
        filesArray = [];
        updateUI();
    };

    convertBtn.onclick = function () {
        startProcessing(false);
    };

    forceMainBtn.onclick = function (e) {
        e.preventDefault();
        startProcessing(true);
    };

    function startProcessing(forceMain) {
        log("Process Start. Files: " + filesArray.length + (forceMain ? " (MainThread)" : " (Worker)"));
        convertBtn.disabled = true;
        progressContainer.className = '';
        currentFileIndex = 0;

        if (hasWorker && !forceMain) {
            startWorkerMode();
        } else {
            log("Mode: Main Thread (Process started)");
            startMainThreadMode();
        }
    }

    function startWorkerMode() {
        if (worker) worker.terminate();
        try {
            worker = new Worker('worker.js');
            worker.onerror = function (e) {
                log("Worker Error: " + e.message);
                if (window.location.protocol === 'file:') {
                    log("TIP: Workers often fail on file:// protocol. Use a local server.");
                }
            };
        } catch (e) {
            log("Worker Creation failed: " + e.message);
            if (window.location.protocol === 'file:') {
                log("NOTE: Browser security blocks Workers on file://. Falling back to Main Thread.");
            }
            startMainThreadMode();
            return;
        }

        worker.onmessage = function (e) {
            var d = e.data;
            if (d.type === 'log') log("Worker: " + d.msg);
            else if (d.type === 'progress') {
                progressFill.style.width = d.progress + "%";
                statusText.textContent = d.filename || "処理中...";
            }
            else if (d.type === 'request-next') {
                if (currentFileIndex < filesArray.length) {
                    worker.postMessage({ type: 'process-file', file: filesArray[currentFileIndex], index: currentFileIndex });
                    currentFileIndex++;
                } else {
                    worker.postMessage({ type: 'finalize' });
                }
            }
            else if (d.type === 'done') finish(d.result);
            else if (d.type === 'error') {
                log("Worker Logic Error: " + d.error);
                convertBtn.disabled = false;
            }
        };

        worker.postMessage({ type: 'start', total: filesArray.length });
    }

    function startMainThreadMode() {
        var tarEntries = [];
        var canvas = document.createElement('canvas');

        function processNext() {
            if (currentFileIndex >= filesArray.length) {
                finalizeMain(tarEntries);
                return;
            }

            var file = filesArray[currentFileIndex];
            log("Main: Processing " + file.name);
            statusText.textContent = file.name;
            progressFill.style.width = Math.floor((currentFileIndex / filesArray.length) * 80) + "%";

            var reader = new FileReader();
            reader.onload = function (e) {
                var img = new Image();
                img.onload = function () {
                    log("Main: Image loaded " + img.width + "x" + img.height);
                    canvas.width = img.width;
                    canvas.height = img.height;
                    canvas.getContext('2d').drawImage(img, 0, 0);

                    try {
                        var webpDataUrl = canvas.toDataURL('image/webp', 0.8);
                        if (webpDataUrl.indexOf('data:image/webp') !== 0) {
                            log("Main: WebP non-supported by canvas, falling back to data:image/png");
                            webpDataUrl = canvas.toDataURL('image/png');
                        }

                        var parts = webpDataUrl.split(',');
                        var binary = atob(parts[1]);
                        var array = new Uint8Array(binary.length);
                        for (var i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);

                        var ext = webpDataUrl.indexOf('webp') !== -1 ? ".webp" : ".png";
                        var newName = file.name.replace(/\.[^/.]+$/, "") + ext;

                        tarEntries.push({ name: newName, data: array });
                        log("Main: Done " + newName + " (" + array.length + " bytes)");

                        currentFileIndex++;
                        setTimeout(processNext, 50);
                    } catch (err) {
                        log("Main Error: " + err.message);
                        convertBtn.disabled = false;
                    }
                };
                img.onerror = function () { log("Main: Image Load Error"); };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        }

        processNext();
    }

    function finalizeMain(entries) {
        log("Main: Building TAR...");
        var totalSize = 0;
        for (var i = 0; i < entries.length; i++) totalSize += 512 + (Math.ceil(entries[i].data.length / 512) * 512);
        totalSize += 1024;

        var buffer = new Uint8Array(totalSize);
        var offset = 0;
        var nowOctal = Math.floor(Date.now() / 1000).toString(8);
        while (nowOctal.length < 11) nowOctal = "0" + nowOctal;

        for (var i = 0; i < entries.length; i++) {
            var ent = entries[i];
            var h = new Uint8Array(512);
            // Name
            for (var j = 0; j < Math.min(ent.name.length, 99); j++) h[j] = ent.name.charCodeAt(j);
            // Mode (0000644)
            var mode = "0000644";
            for (var j = 0; j < 7; j++) h[100 + j] = mode.charCodeAt(j);
            // UID / GID (0000000)
            for (var j = 0; j < 7; j++) { h[108 + j] = 48; h[116 + j] = 48; }
            // Size
            var sz = ent.data.length.toString(8);
            while (sz.length < 11) sz = "0" + sz;
            for (var j = 0; j < 11; j++) h[124 + j] = sz.charCodeAt(j);
            // Mtime
            for (var j = 0; j < 11; j++) h[136 + j] = nowOctal.charCodeAt(j);

            h[156] = 48; // File type 0

            // Magic
            var magic = "ustar\u000000";
            for (var j = 0; j < 8; j++) h[257 + j] = magic.charCodeAt(j);

            var chk = 0; for (var j = 0; j < 512; j++) chk += (j >= 148 && j < 156) ? 32 : h[j];
            var chkS = chk.toString(8); while (chkS.length < 6) chkS = "0" + chkS;
            for (var j = 0; j < 6; j++) h[148 + j] = chkS.charCodeAt(j);
            h[154] = 0; h[155] = 32;

            buffer.set(h, offset); offset += 512;
            buffer.set(ent.data, offset); offset += Math.ceil(ent.data.length / 512) * 512;
        }

        log("Main: Zstd Compress start...");
        if (!zstd) {
            log("Main: Compress Error: Zstd library not initialized yet.");
            convertBtn.disabled = false;
            return;
        }
        try {
            var compressed;
            if (zstd.ZstdSimple && typeof zstd.ZstdSimple.compress === 'function') {
                compressed = zstd.ZstdSimple.compress(buffer);
            } else if (typeof zstd.compress === 'function') {
                compressed = zstd.compress(buffer);
            } else {
                throw new Error("Compression function not found in library instance.");
            }
            log("Main: Compress done (" + compressed.length + " bytes)");
            finish(new Blob([compressed], { type: 'application/zstd' }));
        } catch (e) {
            log("Main: Compress Error: " + e.message);
            convertBtn.disabled = false;
        }
    }

    function finish(blob) {
        log("Done! Downloading...");
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = "images_" + (+new Date()) + ".tar.zst";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            URL.revokeObjectURL(url);
            document.body.removeChild(a);
            convertBtn.disabled = false;
            statusText.textContent = "完了";
        }, 1000);
    }
})();

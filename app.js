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
        startProcessing();
    };

    function startProcessing() {
        log("Process Start. Files: " + filesArray.length);
        convertBtn.disabled = true;
        progressContainer.className = '';
        currentFileIndex = 0;

        if (hasWorker) {
            startWorkerMode();
        } else {
            log("No Worker support. Falling back to Main Thread (UI may freeze)");
            startMainThreadMode();
        }
    }

    function startWorkerMode() {
        if (worker) worker.terminate();
        worker = new Worker('worker.js');

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
                log("Worker Error: " + d.error);
                convertBtn.disabled = false;
            }
        };

        worker.postMessage({ type: 'start', total: filesArray.length });
    }

    // Simplified Main Thread Mode using invisible canvas
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
                    canvas.width = img.width;
                    canvas.height = img.height;
                    canvas.getContext('2d').drawImage(img, 0, 0);

                    try {
                        var webpDataUrl = canvas.toDataURL('image/webp', 0.8);
                        var binary = atob(webpDataUrl.split(',')[1]);
                        var array = new Uint8Array(binary.length);
                        for (var i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);

                        var webpName = file.name.replace(/\.[^/.]+$/, "") + ".webp";
                        tarEntries.push({ name: webpName, data: array });

                        currentFileIndex++;
                        setTimeout(processNext, 10);
                    } catch (err) {
                        log("Main Error: " + err.message);
                    }
                };
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
        for (var i = 0; i < entries.length; i++) {
            var ent = entries[i];
            var h = new Uint8Array(512);
            for (var j = 0; j < Math.min(ent.name.length, 99); j++) h[j] = ent.name.charCodeAt(j);
            var sz = ent.data.length.toString(8);
            while (sz.length < 11) sz = "0" + sz;
            for (var j = 0; j < 11; j++) h[124 + j] = sz.charCodeAt(j);
            h[156] = 48;
            var chk = 0; for (var j = 0; j < 512; j++) chk += (j >= 148 && j < 156) ? 32 : h[j];
            var chkS = chk.toString(8); while (chkS.length < 6) chkS = "0" + chkS;
            for (var j = 0; j < 6; j++) h[148 + j] = chkS.charCodeAt(j);
            buffer.set(h, offset); offset += 512;
            buffer.set(ent.data, offset); offset += Math.ceil(ent.data.length / 512) * 512;
        }

        log("Main: Zstd Compress...");
        var compressed = fzstd.compress(buffer);
        finish(new Blob([compressed], { type: 'application/zstd' }));
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

/* Legacy-Compatible JS (ES5/ES6 simple) */
(function () {
    var dropZone = document.getElementById('drop-zone');
    var fileInput = document.getElementById('file-input');
    var fileList = document.getElementById('file-list');
    var fileListContainer = document.getElementById('file-list-container');
    var clearBtn = document.getElementById('clear-btn');
    var convertBtn = document.getElementById('convert-btn');
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

    // Placeholder for Main Thread Mode if needed in future
    function startMainThreadMode() {
        log("Main Thread Processing not yet fully implemented for Zstd. Please use a modern browser.");
        alert("Worker非対応ブラウザです。");
        convertBtn.disabled = false;
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

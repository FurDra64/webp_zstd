const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const fileListContainer = document.getElementById('file-list-container');
const fileCount = document.getElementById('file-count');
const clearBtn = document.getElementById('clear-btn');
const convertBtn = document.getElementById('convert-btn');
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const progressPercent = document.getElementById('progress-percent');
const statusText = document.getElementById('status-text');

let filesArray = [];
let worker = null;
let currentFileIndex = 0;

// Debug Log
const debugConsole = document.getElementById('debug-console');
const debugLogArea = document.getElementById('debug-log');

function log(msg) {
    console.log(msg);
    const div = document.createElement('div');
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    debugLogArea.appendChild(div);
    debugLogArea.scrollTop = debugLogArea.scrollHeight;
}

// Global error handler
window.onerror = (msg, url, line) => log(`ERR: ${msg} (${line})`);
window.onunhandledrejection = (e) => log(`REJECT: ${e.reason}`);

// Create debug button
const debugBtn = document.createElement('button');
debugBtn.className = 'debug-btn';
debugBtn.textContent = 'Debug';
debugBtn.onclick = () => debugConsole.classList.toggle('hidden');
document.body.appendChild(debugBtn);

log("App Initialized");
checkFeatures();

async function checkFeatures() {
    log(`UserAgent: ${navigator.userAgent}`);
    log(`OffscreenCanvas: ${typeof OffscreenCanvas !== 'undefined'}`);
    if (typeof OffscreenCanvas !== 'undefined') {
        try {
            const canvas = new OffscreenCanvas(1, 1);
            log(`OC.convertToBlob: ${typeof canvas.convertToBlob === 'function'}`);
            const webpTest = await canvas.convertToBlob({ type: 'image/webp' }).catch(() => null);
            log(`WebP Encoding Support: ${webpTest?.type === 'image/webp'}`);
        } catch (e) {
            log(`OC Test Error: ${e.message}`);
        }
    }
}

// Initialize Web Worker
function initWorker() {
    if (worker) worker.terminate();
    worker = new Worker('worker.js');

    worker.onmessage = (e) => {
        const { type, progress, result, error, filename } = e.data;

        if (type === 'progress') {
            progressFill.style.width = `${progress}%`;
            progressPercent.textContent = `${Math.round(progress)}%`;
            statusText.textContent = filename ? `Converting: ${filename}` : 'Processing...';
        } else if (type === 'log') {
            log(`Worker: ${e.data.msg}`);
        } else if (type === 'request-next') {
            sendNextFile();
        } else if (type === 'done') {
            handleComplete(result);
        } else if (type === 'error') {
            handleError(error);
        }
    };
}

// UI Event Listeners
dropZone.onclick = () => fileInput.click();

fileInput.onchange = (e) => {
    addFiles(Array.from(e.target.files));
    fileInput.value = '';
};

dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
};

dropZone.ondragleave = () => {
    dropZone.classList.remove('dragover');
};

dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    addFiles(Array.from(e.dataTransfer.files));
};

clearBtn.onclick = () => {
    filesArray = [];
    updateUI();
};

convertBtn.onclick = () => {
    startConversion();
};

function addFiles(newFiles) {
    const images = newFiles.filter(f => f.type.startsWith('image/'));
    filesArray = [...filesArray, ...images];
    updateUI();
}

function updateUI() {
    fileList.innerHTML = '';

    // Performance: Don't render too many items if they crash the DOM
    const displayLimit = 100;
    const toShow = filesArray.slice(0, displayLimit);

    toShow.forEach(file => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span class="file-name">${file.name}</span>
            <span class="file-size">${formatBytes(file.size)}</span>
        `;
        fileList.appendChild(li);
    });

    if (filesArray.length > displayLimit) {
        const li = document.createElement('li');
        li.textContent = `... and ${filesArray.length - displayLimit} more files`;
        li.style.color = 'var(--text-muted)';
        li.style.justifyContent = 'center';
        fileList.appendChild(li);
    }

    if (filesArray.length > 0) {
        fileListContainer.classList.remove('hidden');
        convertBtn.disabled = false;
        fileCount.textContent = `${filesArray.length} file${filesArray.length > 1 ? 's' : ''}`;
    } else {
        fileListContainer.classList.add('hidden');
        convertBtn.disabled = true;
    }

    progressContainer.classList.add('hidden');
}

async function startConversion() {
    if (filesArray.length === 0) return;

    initWorker();
    currentFileIndex = 0;

    convertBtn.disabled = true;
    progressContainer.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';
    statusText.textContent = 'Initializing...';

    // Start communication
    worker.postMessage({ type: 'start', total: filesArray.length });
}

function sendNextFile() {
    if (currentFileIndex < filesArray.length) {
        const file = filesArray[currentFileIndex];
        // Send one file at a time. This avoids massive message cloning overhead.
        worker.postMessage({ type: 'process-file', file: file, index: currentFileIndex });
        currentFileIndex++;
    } else {
        worker.postMessage({ type: 'finalize' });
    }
}

function handleComplete(blob) {
    statusText.textContent = 'Complete!';
    progressFill.style.background = 'var(--success)';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `images_${new Date().getTime()}.tar.zst`;
    document.body.appendChild(a);
    a.click();

    // Cleanup URL immediately after download click
    setTimeout(() => {
        URL.revokeObjectURL(url);
        document.body.removeChild(a);
        convertBtn.disabled = false;
    }, 2000);
}

function handleError(err) {
    console.error(err);
    statusText.textContent = `Error: ${err}`;
    convertBtn.disabled = false;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

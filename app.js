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

// Initialize Web Worker
function initWorker() {
    if (worker) worker.terminate();
    worker = new Worker('worker.js');
    
    worker.onmessage = (e) => {
        const { type, progress, result, error, filename } = e.data;
        
        if (type === 'progress') {
            progressFill.style.width = `${progress}%`;
            progressPercent.textContent = `${Math.round(progress)}%`;
            statusText.textContent = `Converting: ${filename}`;
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
    fileInput.value = ''; // Reset for same file selection
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
    filesArray.forEach(file => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span class="file-name">${file.name}</span>
            <span class="file-size">${formatBytes(file.size)}</span>
        `;
        fileList.appendChild(li);
    });

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
    
    convertBtn.disabled = true;
    progressContainer.classList.remove('hidden');
    progressFill.style.width = '0%';
    progressPercent.textContent = '0%';
    statusText.textContent = 'Starting...';

    // Send files to worker
    // We need to read them as ArrayBuffers first or pass Blobs
    const fileData = await Promise.all(filesArray.map(async file => {
        const buffer = await file.arrayBuffer();
        return { name: file.name, data: buffer, type: file.type };
    }));

    worker.postMessage({ type: 'start', files: fileData });
}

function handleComplete(blob) {
    statusText.textContent = 'Complete!';
    progressFill.style.background = 'var(--success)';
    
    // Download the result
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `images_${new Date().getTime()}.tar.zst`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    setTimeout(() => {
        convertBtn.disabled = false;
    }, 2000);
}

function handleError(err) {
    console.error(err);
    statusText.textContent = 'Error occurred';
    convertBtn.disabled = false;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Import fzstd
try {
    importScripts('https://cdn.jsdelivr.net/npm/fzstd@0.1.1/dist/index.min.js');
} catch (e) {
    self.postMessage({ type: 'error', error: 'Failed to load fzstd library: ' + e.message });
}

function log(msg) {
    self.postMessage({ type: 'log', msg });
}

let totalFiles = 0;
let db = null;
const DB_NAME = 'WebPConverterDB';
const STORE_NAME = 'blobs';

// Initialize IndexedDB
async function initDB() {
    log("initDB start");
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (e) => {
            log("DB Upgrade needed");
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = (e) => {
            log("DB Open success");
            db = e.target.result;
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).clear();
            resolve();
        };
        request.onerror = (e) => {
            log("DB Open error: " + e.target.error);
            reject(e.target.error);
        };
    });
}

async function saveToDB(index, data) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const request = transaction.objectStore(STORE_NAME).put(data, index);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function getFromDB(index) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(index);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

let fileMetadata = [];

self.onmessage = async (e) => {
    const { type, total, file, index } = e.data;

    try {
        if (type === 'start') {
            log(`Start message received. Total: ${total}`);
            totalFiles = total;
            fileMetadata = [];
            await initDB();
            log("Worker ready, requesting first file");
            self.postMessage({ type: 'request-next' });
        }
        else if (type === 'process-file') {
            log(`Processing file ${index}: ${file.name}`);
            self.postMessage({
                type: 'progress',
                progress: (index / totalFiles) * 80,
                filename: file.name
            });

            const { name, data } = await processOne(file);
            await saveToDB(index, data);
            fileMetadata.push({ name, size: data.length });

            log(`Saved ${name} to DB. Requesting next.`);
            self.postMessage({ type: 'request-next' });
        }
        else if (type === 'finalize') {
            log("Finalizing archive...");
            await finalize();
        }
    } catch (err) {
        log(`CRITICAL ERROR: ${err.message}`);
        self.postMessage({ type: 'error', error: err.message });
    }
};

async function processOne(file) {
    log(`createImageBitmap start: ${file.name}`);
    let imgBitmap;
    try {
        imgBitmap = await createImageBitmap(file);
    } catch (e) {
        log(`createImageBitmap FAILED: ${e.message}`);
        throw e;
    }

    log(`Bitmap ready: ${imgBitmap.width}x${imgBitmap.height}. Creating canvas.`);

    if (typeof OffscreenCanvas === 'undefined') {
        log("OffscreenCanvas is UNDEFINED");
        throw new Error("OffscreenCanvas not supported in this browser version.");
    }

    const canvas = new OffscreenCanvas(imgBitmap.width, imgBitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgBitmap, 0, 0);

    log("convertToBlob start (image/webp)");
    let blob;
    try {
        blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    } catch (e) {
        log(`convertToBlob FAILED: ${e.message}`);
        throw e;
    }

    log(`Conversion successful: ${blob.size} bytes`);
    imgBitmap.close();

    const arrayBuffer = await blob.arrayBuffer();
    const webpName = file.name.replace(/\.[^/.]+$/, "") + ".webp";

    return { name: webpName, data: new Uint8Array(arrayBuffer) };
}

async function finalize() {
    self.postMessage({ type: 'progress', progress: 85, filename: 'Building TAR archive...' });

    let totalTarSize = 0;
    fileMetadata.forEach(m => {
        totalTarSize += 512;
        totalTarSize += Math.ceil(m.size / 512) * 512;
    });
    totalTarSize += 1024;

    log(`Total TAR size calculated: ${totalTarSize}`);
    const tarBuffer = new Uint8Array(totalTarSize);
    let offset = 0;

    for (let i = 0; i < fileMetadata.length; i++) {
        const meta = fileMetadata[i];
        const data = await getFromDB(i);

        const header = createTarHeader(meta.name, data.length);
        tarBuffer.set(header, offset);
        offset += 512;

        tarBuffer.set(data, offset);
        offset += Math.ceil(data.length / 512) * 512;

        if (i % 50 === 0) {
            self.postMessage({ type: 'progress', progress: 85 + (i / fileMetadata.length) * 5 });
            await new Promise(r => setTimeout(r, 0));
        }
    }

    log("Compressing with fzstd...");
    self.postMessage({ type: 'progress', progress: 95, filename: 'Zstd Compression...' });

    try {
        const compressed = fzstd.compress(tarBuffer);
        log("Compression complete. Sending blob.");
        self.postMessage({
            type: 'done',
            result: new Blob([compressed], { type: 'application/zstd' })
        });
    } catch (e) {
        log(`Compression FAILED: ${e.message}`);
        throw e;
    }
}

function createTarHeader(name, size) {
    const h = new Uint8Array(512);
    const encoder = new TextEncoder();
    h.set(encoder.encode(name).subarray(0, 99));
    h.set(encoder.encode("0000644\u0000"), 100);
    h.set(encoder.encode("0000000\u0000"), 108);
    h.set(encoder.encode("0000000\u0000"), 116);
    h.set(encoder.encode(size.toString(8).padStart(11, '0') + "\u0000"), 124);
    h.set(encoder.encode(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + "\u0000"), 136);
    h.set(encoder.encode("        "), 148);
    h[156] = 48; // '0'
    h.set(encoder.encode("ustar\u0000"), 257);
    h.set(encoder.encode("00"), 263);

    let cksum = 0;
    for (let i = 0; i < 512; i++) cksum += h[i];
    h.set(encoder.encode(cksum.toString(8).padStart(6, '0') + "\u0000 "), 148);
    return h;
}

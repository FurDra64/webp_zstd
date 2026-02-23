// Import fzstd from CDN inside worker
importScripts('https://cdn.jsdelivr.net/npm/fzstd@0.1.1/dist/index.min.js');

self.onmessage = async (e) => {
    const { type, files } = e.data;
    if (type === 'start') {
        try {
            const result = await processFiles(files);
            self.postMessage({ type: 'done', result });
        } catch (err) {
            console.error(err);
            self.postMessage({ type: 'error', error: err.message });
        }
    }
};

async function processFiles(files) {
    const tarEntries = [];
    let totalFiles = files.length;

    for (let i = 0; i < totalFiles; i++) {
        const file = files[i];
        self.postMessage({
            type: 'progress',
            progress: (i / totalFiles) * 85,
            filename: file.name
        });

        // 1. Convert to WebP (processes one at a time to save memory)
        const webpData = await convertToWebP(file);

        // 2. Add to TAR list
        const webpName = file.name.replace(/\.[^/.]+$/, "") + ".webp";
        tarEntries.push({
            name: webpName,
            data: webpData
        });

        // Minor delay to allow GC a chance to breathe in some environments
        if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
    }

    self.postMessage({ type: 'progress', progress: 90, filename: 'Creating TAR...' });
    const tarBuffer = createTar(tarEntries);

    // Clear references to converted data as soon as TAR is built
    tarEntries.length = 0;

    self.postMessage({ type: 'progress', progress: 95, filename: 'Compressing Zstd...' });
    const zstdBuffer = fzstd.compress(tarBuffer);

    return new Blob([zstdBuffer], { type: 'application/zstd' });
}

async function convertToWebP(file) {
    // createImageBitmap(file) is very efficient for Blobs/Files
    const imgBitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(imgBitmap.width, imgBitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgBitmap, 0, 0);

    // Convert to blob
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });

    // Explicitly close the bitmap to free graphics memory IMMEDIATELY
    imgBitmap.close();

    // Convert blob to Uint8Array for the TAR buffer
    return new Uint8Array(await blob.arrayBuffer());
}

// Minimal USTAR implementation
function createTar(entries) {
    const blockSize = 512;
    let totalSize = 0;

    entries.forEach(entry => {
        totalSize += blockSize; // Header
        totalSize += Math.ceil(entry.data.length / blockSize) * blockSize; // Data
    });
    totalSize += blockSize * 2; // End of archive (two null blocks)

    const buffer = new Uint8Array(totalSize);
    let offset = 0;

    entries.forEach(entry => {
        const header = new Uint8Array(blockSize);
        const nameEncoder = new TextEncoder();

        // Fill header according to USTAR format
        const nameBytes = nameEncoder.encode(entry.name);
        header.set(nameBytes.subarray(0, 99));

        header.set(nameEncoder.encode("0000644\u0000"), 100);
        header.set(nameEncoder.encode("0000000\u0000"), 108);
        header.set(nameEncoder.encode("0000000\u0000"), 116);

        const sizeStr = entry.data.length.toString(8).padStart(11, '0') + "\u0000";
        header.set(nameEncoder.encode(sizeStr), 124);

        const mtimeStr = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + "\u0000";
        header.set(nameEncoder.encode(mtimeStr), 136);

        header.set(nameEncoder.encode("        "), 148);
        header[156] = 48; // '0' (Normal file)

        header.set(nameEncoder.encode("ustar\u0000"), 257);
        header.set(nameEncoder.encode("00"), 263);

        // Sum up all bytes for checksum
        let checksum = 0;
        for (let i = 0; i < blockSize; i++) checksum += header[i];
        const checksumStr = checksum.toString(8).padStart(6, '0') + "\u0000 ";
        header.set(nameEncoder.encode(checksumStr), 148);

        buffer.set(header, offset);
        offset += blockSize;

        buffer.set(entry.data, offset);
        offset += Math.ceil(entry.data.length / blockSize) * blockSize;
    });

    return buffer;
}

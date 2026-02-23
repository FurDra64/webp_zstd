// Import fzstd from CDN inside worker
importScripts('https://cdn.jsdelivr.net/npm/fzstd@0.1.1/dist/index.min.js');

self.onmessage = async (e) => {
    const { type, files } = e.data;
    if (type === 'start') {
        try {
            const result = await processFiles(files);
            self.postMessage({ type: 'done', result });
        } catch (err) {
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
            progress: (i / totalFiles) * 80, // First 80% for conversion
            filename: file.name
        });

        // 1. Convert to WebP
        const webpBlob = await convertToWebP(file);
        const webpData = new Uint8Array(await webpBlob.arrayBuffer());

        // 2. Add to TAR list
        const webpName = file.name.replace(/\.[^/.]+$/, "") + ".webp";
        tarEntries.push({
            name: webpName,
            data: webpData
        });
    }

    self.postMessage({ type: 'progress', progress: 85, filename: 'Creating TAR...' });
    const tarBuffer = createTar(tarEntries);

    self.postMessage({ type: 'progress', progress: 90, filename: 'Compressing Zstd...' });
    const zstdBuffer = fzstd.compress(tarBuffer);

    return new Blob([zstdBuffer], { type: 'application/zstd' });
}

async function convertToWebP(file) {
    const imgBitmap = await createImageBitmap(new Blob([file.data], { type: file.type }));
    const canvas = new OffscreenCanvas(imgBitmap.width, imgBitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgBitmap, 0, 0);
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
}

// Minimal USTAR implementation
function createTar(entries) {
    const blockSize = 512;
    let totalSize = 0;

    // Calculate total size
    entries.forEach(entry => {
        totalSize += blockSize; // Header
        totalSize += Math.ceil(entry.data.length / blockSize) * blockSize; // Data
    });
    totalSize += blockSize * 2; // End of archive (two null blocks)

    const buffer = new Uint8Array(totalSize);
    let offset = 0;

    entries.forEach(entry => {
        const header = new Uint8Array(blockSize);
        // Name (0-99)
        const nameEncoder = new TextEncoder();
        const nameBytes = nameEncoder.encode(entry.name);
        header.set(nameBytes.subarray(0, 99));

        // Mode (100-107) - default 644
        header.set(nameEncoder.encode("0000644\u0000"), 100);
        // UID (108-115)
        header.set(nameEncoder.encode("0000000\u0000"), 108);
        // GID (116-123)
        header.set(nameEncoder.encode("0000000\u0000"), 116);
        // Size (124-135) - octal
        const sizeStr = entry.data.length.toString(8).padStart(11, '0') + "\u0000";
        header.set(nameEncoder.encode(sizeStr), 124);
        // Mtime (136-147)
        const mtimeStr = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + "\u0000";
        header.set(nameEncoder.encode(mtimeStr), 136);

        // Checksum placeholder (148-155) - spaces
        header.set(nameEncoder.encode("        "), 148);

        // Type flag (156) - '0' for normal file
        header[156] = 48; // '0'

        // magic (257-262)
        header.set(nameEncoder.encode("ustar\u0000"), 257);
        // version (263-264)
        header.set(nameEncoder.encode("00"), 263);

        // Calculate actual checksum
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

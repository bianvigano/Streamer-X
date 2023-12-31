const axios = require("axios");
const hljs = require('highlight.js');
require('dotenv').config()

// --------- CONFIG -------------
const maxStreamInfoSize = process.env.MAX_STREAM_INFO_SIZE ? process.env.MAX_STREAM_INFO_SIZE : 20; // max amount of streamsInfo. This does not take much space so this can be fairly high.
const maxQueueSize = process.env.MAX_QUEUE_SIZE ? process.env.MAX_QUEUE_SIZE : 6; // queue size this is expensive. one item in queue is HOLD_BUFFER_SIZE MB. Be careful not to run out of memory.
const buffSize = process.env.HOLD_BUFFER_SIZE ? process.env.HOLD_BUFFER_SIZE : 6.25 * 1024 ** 2;
const sendBufferSize = process.env.SEND_BUFFER_SIZE ? process.env.SEND_BUFFER_SIZE : 1.5625 * 1024 ** 2;
const linkStart = process.env.LINKSTART ? process.env.LINKSTART : "https://cdn.discordapp.com/attachments";
// ------------------------------
const streamsInfo = new Map();
const oldChunkSize = 8 * 1024 ** 2;

async function getStreamInfo(fid, cid) {
    if (streamsInfo.has(fid)) {
        return streamsInfo.get(fid);
    } else {
        try {
            const res = await axios.get(`${linkStart}/${cid}/${fid}/blob`);
            if (!res.data.chunks || !res.data.size) return null;
            if (!res.data.chunkSize) res.data.chunkSize = oldChunkSize;
            res.data.type = getTypeFromName(res.data.name);
            streamsInfo.set(fid, res.data);
            if (streamsInfo.size > maxStreamInfoSize) {
                streamsInfo.delete(streamsInfo.keys().next().value);
            }
            return res.data;
        } catch (err) {
            console.log(err);
            return null;
        }
    }
}

function getTypeFromName(name) {
    const parts = name.split('.');
    if (parts.length === 0) {
        return null;
    }
    const ext = parts[parts.length - 1].toLowerCase();
    switch (ext) {
        case 'mp3':
        case 'wav':
            return 'audio/mpeg';
        case 'mp4':
        case 'avi':
        case 'mkv':
            return 'video/mp4';
        case 'png':
            return 'image/png';
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'gif':
            return 'image/gif';
        case 'txt':
        case 'html':
        case 'js':
            return 'text/plain';
        case 'pdf':
            return 'application/pdf';
        default:
            return null;
    }
}

// async function getimageBufferPart(fid, cid, start, bufferSize = sendBufferSize) {
//     const packet = await getStreamBuffer(fid, cid, start);
//     if (!packet) return null;
//     const maxChunkSize = Math.min(packet.buffer.length, bufferSize);
//     const sliced = packet.buffer.slice(start, packet.buffer.length);
//     //console.log(`off: ${offsetBytes} | max: ${maxChunkSize} | slc: ${sliced.length}`);
//     return {
//         buffer: sliced,
//         streamSize: packet.streamSize,
//         length: sliced.length,
//         type: packet.type,
//         name: packet.name
//     };
// }

async function getimageBufferPart(fid, cid, start, { quality, width, height, bufferSize = sendBufferSize } = {}) {
    const packet = await getStreamBuffer(fid, cid, start);
    if (!packet) return null;
    const maxChunkSize = Math.min(packet.buffer.length, bufferSize);
    const sliced = packet.buffer.slice(start, packet.buffer.length);

    // Process image resizing based on specified width and height
    let resizedBuffer = sliced;
    
    if (packet.type && packet.type.startsWith('image/') && (width || height)) {
        console.log('Image')
        try {
            const sharp = require('sharp');

            // Ensure width and height are positive integers
            const validWidth = width && parseInt(width, 10) > 0 ? parseInt(width, 10) : null;
            const validHeight = height && parseInt(height, 10) > 0 ? parseInt(height, 10) : null;

            const sharpInstance = sharp(sliced);

            // Check and apply quality parameter if provided
            if (quality && typeof quality === 'number' && quality >= 1 && quality <= 100) {
                sharpInstance.quality(quality);
            }

            // Resize the image if valid width and/or height are provided
            if (validWidth || validHeight) {
                sharpInstance.resize(validWidth, validHeight);
            }

            resizedBuffer = await sharpInstance.toBuffer();
        } catch (resizeError) {
            console.error('Error resizing image:', resizeError);
        }
    } else if (packet.type && packet.type.startsWith('text/')) {
        // Count the number of lines in the text, but limit it to 100 lines
        const lines = sliced.toString().split('\n');
        let remainingLines = 0;
    
        if (lines.length > 100) {
            remainingLines = lines.length - 100;
            numberOfLines = lines.slice(0, 100).join('\n') + `\n... (${remainingLines} lines left)`;
        } else {
            numberOfLines = sliced.toString();
        }
    
        // console.log(numberOfLines);
    
        // Add numberOfLines to the buffer
        resizedBuffer = Buffer.from(numberOfLines);
    }

    return {
        buffer: resizedBuffer,
        streamSize: packet.streamSize,
        length: resizedBuffer.length,
        type: packet.type,
        name: packet.name,
    };
}




async function getStreamBufferPart(fid, cid, start, bufferSize = sendBufferSize) {
    const packet = await getStreamBuffer(fid, cid, start);
    //console.log(packet)
    if (!packet) return null;
    const offsetBytes = start - packet.start;
    const maxChunkSize = Math.min(packet.buffer.length - offsetBytes, bufferSize);
    const sliced = packet.buffer.slice(offsetBytes, offsetBytes + maxChunkSize);
    //console.log(`off: ${offsetBytes} | max: ${maxChunkSize} | slc: ${sliced.length}`);
    return {
        buffer: sliced,
        streamSize: packet.streamSize,
        length: sliced.length,
        type: packet.type,
        name: packet.name
    };
}

async function getStreamBuffer(fid, cid, start) {
    const streamInfo = await getStreamInfo(fid, cid);
    if (streamInfo === null || start < 0 || start > streamInfo.size) return null;
    AddToQueue(fid, cid, streamInfo, start);
    if (start + buffSize < streamInfo.size) { // buffer up more stream
        AddToQueue(fid, cid, streamInfo, start + buffSize);
    }
    const item = await getFromQueue(fid, start);
    if (!item) return null;
    return {
        buffer: item.buffer,
        start: item.start,
        streamSize: streamInfo.size,
        type: streamInfo.type ?? 'other',
        name: streamInfo.name
    };
}

async function getDownloadBuffer(cid, streamInfo, start, controller) {
    let arr = []
    const markerAtChunk = start % streamInfo.chunkSize;
    const chunkIndex = Math.floor(start / streamInfo.chunkSize);
    const allowedBuffSize = Math.min(buffSize, streamInfo.size - start)
    let endByte = markerAtChunk + allowedBuffSize;
    let diff = 0;
    if (endByte > streamInfo.chunkSize) {
        diff = endByte - streamInfo.chunkSize;
        endByte -= diff;
    }
    //console.log(`${chunkIndex} | start: ${start}; max: ${streamInfo.size}; diff: ${diff}; abuff: ${allowedBuffSize}; ${markerAtChunk} - ${endByte}`)
    arr.push(
        axios.get(`${linkStart}/${cid}/${streamInfo.chunks[chunkIndex]}/blob`, {
            responseType: 'arraybuffer',
            signal: controller.signal,
            headers: {
                Range: `bytes=${markerAtChunk}-${endByte - 1}`
            }
        }).then(rs => rs.data).catch(err => { console.log(start, endByte, streamInfo.chunkSize, chunkIndex, err.stack, 1); return undefined; })
    )

    if (chunkIndex + 1 < streamInfo.chunks.length && diff > 0) {
        arr.push(
            axios.get(`${linkStart}/${cid}/${streamInfo.chunks[chunkIndex + 1]}/blob`, {
                responseType: 'arraybuffer',
                signal: controller.signal,
                headers: {
                    Range: `bytes=${0}-${diff - 1}`
                }
            }).then(rs => rs.data).catch(err => { console.log(err.stack, 2); return undefined; })
        )
    }
    const buffs = await Promise.all(arr);
    if (buffs.includes(undefined)) return null;
    return Buffer.concat(buffs);
}

let Queue = [];
function AddToQueue(fid, cid, streamInfo, start) {
    const item = Queue.find(w => w.fid === fid && w.start <= start && w.end - sendBufferSize > start);
    if (item) return;
    const controller = new AbortController();
    const buffer = getDownloadBuffer(cid, streamInfo, start, controller);
    Queue.unshift({ fid, buffer, controller, start, end: Math.min(streamInfo.size, start + buffSize) });
    if (Queue.length > maxQueueSize) {
        Queue.pop().controller.abort();
    }
}

async function getFromQueue(fid, start) {
    const item = Queue.find(w => w.fid === fid && w.start <= start && w.end > start);
    if (!item) return null;
    const buffer = await item.buffer;
    return { buffer, start: item.start };
}

function formatID(id) {
    const ind = id.lastIndexOf('.');
    let reg = /^\d+$/;
    if (ind !== -1) {
        const idPart = id.slice(0, ind);
        if (reg.test(idPart)) {
            return idPart;
        }
        return null;
    }
    if (reg.test(id)) {
        return id;
    }
    return null;
}

module.exports = {
    getStreamBuffer,
    getStreamBufferPart,
    getimageBufferPart,
    sendBufferSize,
    formatID
}
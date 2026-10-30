export function generateWaveformFromBuffer(audioBuffer: AudioBuffer, numBars: number = 36): number[] {
    const rawData = audioBuffer.getChannelData(0); // use first channel
    const blockSize = Math.floor(rawData.length / numBars);
    const bars: number[] = [];
    
    for (let i = 0; i < numBars; i++) {
        const start = i * blockSize;
        let sum = 0;
        let peak = 0;
        const end = Math.min(start + blockSize, rawData.length);
        if (start >= rawData.length) {
            bars.push(0.1);
            continue;
        }
        for (let j = start; j < end; j++) {
            const val = Math.abs(rawData[j]);
            if (val > peak) peak = val;
            sum += val * val;
        }
        // Use a mix of RMS and peak, normalized, and ensure a minimum height
        const rms = Math.sqrt(sum / Math.max(1, end - start));
        const val = 0.2 * rms + 0.8 * peak;
        bars.push(Math.max(0.08, Math.min(1, val)));
    }
    return bars;
}

export function disableVideoTracksInMp4(arrayBuffer: ArrayBuffer): ArrayBuffer {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    const end = arrayBuffer.byteLength;

    interface Box {
        type: string;
        start: number;
        end: number;
        size: number;
        headerSize: number;
        payloadStart: number;
        payloadEnd: number;
    }

    function parseBoxes(start: number, end: number): Box[] {
        const boxes: Box[] = [];
        let pos = start;
        while (pos + 8 <= end) {
            let size = view.getUint32(pos);
            const typeBytes = bytes.slice(pos + 4, pos + 8);
            const type = String.fromCharCode(...typeBytes);
            let headerSize = 8;
            if (size === 1) {
                if (pos + 16 > end) break;
                const high = view.getUint32(pos + 8);
                const low = view.getUint32(pos + 12);
                size = high * 0x100000000 + low;
                headerSize = 16;
            } else if (size === 0) {
                size = end - pos;
            }
            if (size < headerSize || pos + size > end) {
                break;
            }
            boxes.push({
                type,
                start: pos,
                end: pos + size,
                size,
                headerSize,
                payloadStart: pos + headerSize,
                payloadEnd: pos + size
            });
            pos += size;
        }
        return boxes;
    }

    function disableVideoTrack(trak: Box) {
        const mdiaBoxes = parseBoxes(trak.payloadStart, trak.payloadEnd).filter(b => b.type === "mdia");
        if (mdiaBoxes.length === 0) return;
        const mdia = mdiaBoxes[0];
        const hdlrBoxes = parseBoxes(mdia.payloadStart, mdia.payloadEnd).filter(b => b.type === "hdlr");
        if (hdlrBoxes.length === 0) return;
        const hdlr = hdlrBoxes[0];
        if (hdlr.payloadStart + 12 <= hdlr.payloadEnd) {
            const hTypeBytes = bytes.slice(hdlr.payloadStart + 8, hdlr.payloadStart + 12);
            const handlerType = String.fromCharCode(...hTypeBytes);
            if (handlerType === "vide") {
                // Overwrite 'vide' with 'null' in place to bypass HEVC decoding
                bytes[hdlr.payloadStart + 8] = "n".charCodeAt(0);
                bytes[hdlr.payloadStart + 9] = "u".charCodeAt(0);
                bytes[hdlr.payloadStart + 10] = "l".charCodeAt(0);
                bytes[hdlr.payloadStart + 11] = "l".charCodeAt(0);
            }
        }
    }

    const topLevelBoxes = parseBoxes(0, end);
    const moovBox = topLevelBoxes.find(b => b.type === "moov");
    if (!moovBox) {
        return arrayBuffer;
    }

    const subBoxes = parseBoxes(moovBox.payloadStart, moovBox.payloadEnd);
    for (const sub of subBoxes) {
        if (sub.type === "trak") {
            disableVideoTrack(sub);
        }
    }

    return arrayBuffer;
}

export function extractAacFromMp4(arrayBuffer: ArrayBuffer): ArrayBuffer | null {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    const end = arrayBuffer.byteLength;

    interface Box {
        type: string;
        start: number;
        end: number;
        size: number;
        headerSize: number;
        payloadStart: number;
        payloadEnd: number;
    }

    function parseBoxes(start: number, end: number): Box[] {
        const boxes: Box[] = [];
        let pos = start;
        while (pos + 8 <= end) {
            let size = view.getUint32(pos);
            const typeBytes = bytes.slice(pos + 4, pos + 8);
            const type = String.fromCharCode(...typeBytes);
            let headerSize = 8;
            if (size === 1) {
                if (pos + 16 > end) break;
                const high = view.getUint32(pos + 8);
                const low = view.getUint32(pos + 12);
                size = high * 0x100000000 + low;
                headerSize = 16;
            } else if (size === 0) {
                size = end - pos;
            }
            if (size < headerSize || pos + size > end) {
                break;
            }
            boxes.push({
                type,
                start: pos,
                end: pos + size,
                size,
                headerSize,
                payloadStart: pos + headerSize,
                payloadEnd: pos + size
            });
            pos += size;
        }
        return boxes;
    }

    function findBox(boxes: Box[], path: string): Box | null {
        const parts = path.split("/");
        let current: Box[] = boxes;
        for (let i = 0; i < parts.length; i++) {
            const target = parts[i];
            const found = current.find(b => b.type === target);
            if (!found) return null;
            if (i === parts.length - 1) return found;
            const startOffset = found.type === "stsd" ? 8 : 0;
            current = parseBoxes(found.payloadStart + startOffset, found.payloadEnd);
        }
        return null;
    }

    try {
        const topLevelBoxes = parseBoxes(0, end);
        const moovBox = topLevelBoxes.find(b => b.type === "moov");
        if (!moovBox) return null;

        const traks = parseBoxes(moovBox.payloadStart, moovBox.payloadEnd).filter(b => b.type === "trak");
        let audioTrak: Box | null = null;
        let mp4aBox: Box | null = null;
        let stblBox: Box | null = null;

        for (const trak of traks) {
            const hdlr = findBox([trak], "trak/mdia/hdlr");
            if (!hdlr) continue;
            if (hdlr.payloadStart + 12 <= hdlr.payloadEnd) {
                const hTypeBytes = bytes.slice(hdlr.payloadStart + 8, hdlr.payloadStart + 12);
                const hType = String.fromCharCode(...hTypeBytes);
                if (hType === "soun") {
                    const mp4a = findBox([trak], "trak/mdia/minf/stbl/stsd/mp4a");
                    if (mp4a) {
                        audioTrak = trak;
                        mp4aBox = mp4a;
                        stblBox = findBox([trak], "trak/mdia/minf/stbl");
                        break;
                    }
                }
            }
        }

        if (!audioTrak || !mp4aBox || !stblBox) return null;

        const stblBoxes = parseBoxes(stblBox.payloadStart, stblBox.payloadEnd);

        // Parse stsz
        const stszBox = stblBoxes.find(b => b.type === "stsz");
        if (!stszBox) return null;
        const stszView = new DataView(bytes.buffer, stszBox.payloadStart, stszBox.payloadEnd - stszBox.payloadStart);
        const defaultSampleSize = stszView.getUint32(4);
        const sampleCount = stszView.getUint32(8);
        const sampleSizes: number[] = [];
        if (defaultSampleSize !== 0) {
            for (let i = 0; i < sampleCount; i++) {
                sampleSizes.push(defaultSampleSize);
            }
        } else {
            for (let i = 0; i < sampleCount; i++) {
                sampleSizes.push(stszView.getUint32(12 + i * 4));
            }
        }

        // Parse stco/co64
        const stcoBox = stblBoxes.find(b => b.type === "stco");
        const co64Box = stblBoxes.find(b => b.type === "co64");
        const chunkOffsets: number[] = [];
        if (stcoBox) {
            const stcoView = new DataView(bytes.buffer, stcoBox.payloadStart, stcoBox.payloadEnd - stcoBox.payloadStart);
            const entryCount = stcoView.getUint32(4);
            for (let i = 0; i < entryCount; i++) {
                chunkOffsets.push(stcoView.getUint32(8 + i * 4));
            }
        } else if (co64Box) {
            const co64View = new DataView(bytes.buffer, co64Box.payloadStart, co64Box.payloadEnd - co64Box.payloadStart);
            const entryCount = co64View.getUint32(4);
            for (let i = 0; i < entryCount; i++) {
                const high = co64View.getUint32(8 + i * 8);
                const low = co64View.getUint32(12 + i * 8);
                chunkOffsets.push(high * 0x100000000 + low);
            }
        } else {
            return null;
        }

        // Parse stsc
        const stscBox = stblBoxes.find(b => b.type === "stsc");
        if (!stscBox) return null;
        const stscView = new DataView(bytes.buffer, stscBox.payloadStart, stscBox.payloadEnd - stscBox.payloadStart);
        const stscCount = stscView.getUint32(4);
        interface StscEntry {
            firstChunk: number;
            samplesPerChunk: number;
        }
        const stscEntries: StscEntry[] = [];
        for (let i = 0; i < stscCount; i++) {
            stscEntries.push({
                firstChunk: stscView.getUint32(8 + i * 12),
                samplesPerChunk: stscView.getUint32(12 + i * 12)
            });
        }

        // Map samples
        const samples: { offset: number; size: number }[] = [];
        let globalSampleIndex = 0;
        for (let c = 0; c < chunkOffsets.length; c++) {
            const chunkNum = c + 1;
            let activeEntry = stscEntries[0];
            for (const entry of stscEntries) {
                if (entry.firstChunk <= chunkNum) {
                    activeEntry = entry;
                } else {
                    break;
                }
            }
            
            let runningOffset = chunkOffsets[c];
            const samplesInChunk = activeEntry.samplesPerChunk;
            for (let s = 0; s < samplesInChunk; s++) {
                if (globalSampleIndex >= sampleSizes.length) break;
                const size = sampleSizes[globalSampleIndex];
                samples.push({ offset: runningOffset, size });
                runningOffset += size;
                globalSampleIndex++;
            }
        }

        // Parse channel count & sample rate from mp4a
        const mp4aView = new DataView(bytes.buffer, mp4aBox.payloadStart, mp4aBox.payloadEnd - mp4aBox.payloadStart);
        const channelCount = mp4aView.getUint16(16);
        const sampleRateFixed = mp4aView.getUint32(24);
        const sampleRate = sampleRateFixed >>> 16;

        const samplingFreqs = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
        let freqIndex = samplingFreqs.indexOf(sampleRate);
        if (freqIndex === -1) freqIndex = 4; // fallback 44100

        function getAdtsHeader(frameSize: number, freqIdx: number, channels: number): Uint8Array {
            const header = new Uint8Array(7);
            const totalSize = frameSize + 7;
            header[0] = 0xFF;
            header[1] = 0xF1;
            const profile = 1; // AAC-LC
            header[2] = ((profile & 3) << 6) | ((freqIdx & 15) << 2) | ((channels & 4) >> 2);
            header[3] = ((channels & 3) << 6) | ((totalSize & 0x1800) >> 11);
            header[4] = (totalSize & 0x7F8) >> 3;
            header[5] = ((totalSize & 7) << 5) | 0x1F;
            header[6] = 0xFC;
            return header;
        }

        let totalAdtsSize = 0;
        for (const s of samples) {
            totalAdtsSize += 7 + s.size;
        }

        const adtsBuffer = new Uint8Array(totalAdtsSize);
        let adtsOffset = 0;
        for (const s of samples) {
            if (s.offset + s.size > end) return null; // safety check
            const header = getAdtsHeader(s.size, freqIndex, channelCount);
            adtsBuffer.set(header, adtsOffset);
            adtsOffset += 7;
            adtsBuffer.set(bytes.subarray(s.offset, s.offset + s.size), adtsOffset);
            adtsOffset += s.size;
        }

        return adtsBuffer.buffer;
    } catch (e) {
        console.warn("Failed to extract AAC from MP4/MOV container:", e);
        return null;
    }
}

export async function getArrayBufferFromFile(file: Blob): Promise<ArrayBuffer> {
    let url: string | null = null;
    try {
        url = URL.createObjectURL(file);
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to fetch local object URL");
        let buffer = await res.arrayBuffer();
        
        // Helper function to check magic bytes
        const checkIsMp4Mov = (buf: ArrayBuffer): boolean => {
            if (buf.byteLength < 8) return false;
            // Parse first 1KB to search for common box signatures
            const bView = new DataView(buf);
            const bBytes = new Uint8Array(buf);
            let pos = 0;
            const limit = Math.min(buf.byteLength, 1024);
            while (pos + 8 <= limit) {
                const size = bView.getUint32(pos);
                const typeBytes = bBytes.slice(pos + 4, pos + 8);
                const type = String.fromCharCode(...typeBytes);
                if (["ftyp", "moov", "mdat", "wide", "free", "uuid"].includes(type)) {
                    return true;
                }
                if (size < 8) break;
                pos += size;
            }
            return false;
        };

        const isMp4Mov = checkIsMp4Mov(buffer);
        const isVideo = file.type.startsWith("video/") || isMp4Mov ||
            (file instanceof File && (file.name.endsWith(".mov") || file.name.endsWith(".mp4")));
        
        if (isVideo) {
            const extracted = extractAacFromMp4(buffer);
            if (extracted) {
                buffer = extracted;
            } else {
                buffer = disableVideoTracksInMp4(buffer);
            }
        }
        return buffer;
    } catch (e) {
        console.warn("Fetch from object URL failed, falling back to direct arrayBuffer() read:", e);
        let buffer = await file.arrayBuffer();
        
        const checkIsMp4Mov = (buf: ArrayBuffer): boolean => {
            if (buf.byteLength < 8) return false;
            const bView = new DataView(buf);
            const bBytes = new Uint8Array(buf);
            let pos = 0;
            const limit = Math.min(buf.byteLength, 1024);
            while (pos + 8 <= limit) {
                const size = bView.getUint32(pos);
                const typeBytes = bBytes.slice(pos + 4, pos + 8);
                const type = String.fromCharCode(...typeBytes);
                if (["ftyp", "moov", "mdat", "wide", "free", "uuid"].includes(type)) {
                    return true;
                }
                if (size < 8) break;
                pos += size;
            }
            return false;
        };

        const isMp4Mov = checkIsMp4Mov(buffer);
        const isVideo = file.type.startsWith("video/") || isMp4Mov ||
            (file instanceof File && (file.name.endsWith(".mov") || file.name.endsWith(".mp4")));
            
        if (isVideo) {
            const extracted = extractAacFromMp4(buffer);
            if (extracted) {
                buffer = extracted;
            } else {
                buffer = disableVideoTracksInMp4(buffer);
            }
        }
        return buffer;
    } finally {
        if (url) {
            URL.revokeObjectURL(url);
        }
    }
}

export async function extractAudioToWav(file: File): Promise<{blob: Blob, durationMs: number, waveform: number[]}> {
    const AudioContextClass = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    // 1 channel, 1 sample length, 44100 sample rate
    const audioContext = new AudioContextClass(1, 1, 44100);
    const arrayBuffer = await getArrayBufferFromFile(file);
    const audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
        try {
            const promise = audioContext.decodeAudioData(
                arrayBuffer,
                (buffer) => resolve(buffer),
                (err) => reject(err || new Error("Failed to decode audio data"))
            );
            if (promise && typeof promise.catch === "function") {
                promise.catch((err) => reject(err));
            }
        } catch (e) {
            reject(e);
        }
    });
    
    const numOfChan = audioBuffer.numberOfChannels;
    const length = audioBuffer.length * numOfChan * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    const channels = [];
    let sample = 0;
    let offset = 0;
    let pos = 0;

    const setUint32 = (data: number) => { view.setUint32(pos, data, true); pos += 4; };
    const setUint16 = (data: number) => { view.setUint16(pos, data, true); pos += 2; };
    const writeString = (s: string) => { for (let i = 0; i < s.length; i++) { view.setUint8(pos++, s.charCodeAt(i)); } };

    writeString('RIFF');
    setUint32(length - 8);
    writeString('WAVE');
    writeString('fmt ');
    setUint32(16);
    setUint16(1);
    setUint16(numOfChan);
    setUint32(audioBuffer.sampleRate);
    setUint32(audioBuffer.sampleRate * 2 * numOfChan);
    setUint16(numOfChan * 2);
    setUint16(16);
    writeString('data');
    setUint32(length - pos - 4);

    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
        channels.push(audioBuffer.getChannelData(i));
    }

    while (pos < length) {
        for (let i = 0; i < numOfChan; i++) {
            sample = Math.max(-1, Math.min(1, channels[i][offset]));
            sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            view.setInt16(pos, sample, true);
            pos += 2;
        }
        offset++;
    }

    const waveform = generateWaveformFromBuffer(audioBuffer, 36);
    return { 
        blob: new Blob([buffer], { type: "audio/wav" }), 
        durationMs: audioBuffer.duration * 1000,
        waveform
    };
}

export async function getAudioFileMetadata(file: Blob): Promise<{ durationMs: number; waveform: number[] }> {
    const AudioContextClass = window.OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    const audioContext = new AudioContextClass(1, 1, 44100);
    const arrayBuffer = await getArrayBufferFromFile(file);
    const audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
        try {
            const promise = audioContext.decodeAudioData(
                arrayBuffer,
                (buffer) => resolve(buffer),
                (err) => reject(err || new Error("Failed to decode audio data"))
            );
            if (promise && typeof promise.catch === "function") {
                promise.catch((err) => reject(err));
            }
        } catch (e) {
            reject(e);
        }
    });

    const waveform = generateWaveformFromBuffer(audioBuffer, 36);
    return {
        durationMs: audioBuffer.duration * 1000,
        waveform
    };
}


import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const mimeToExtension = (mimeType) => {
    if (mimeType?.includes('ogg')) {
        return 'ogg';
    }
    if (mimeType?.includes('wav')) {
        return 'wav';
    }
    return 'webm';
};

export class PttRtpPublisher extends EventEmitter {
    constructor({ ffmpegPath, host, payloadType = 111, sampleRate = 48000, channels = 2, tempDirectory, maxBytes = 10 * 1024 * 1024, spawnProcess = spawn }) {
        super();
        this.ffmpegPath = ffmpegPath;
        this.host = host;
        this.payloadType = payloadType;
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.tempDirectory = tempDirectory;
        this.maxBytes = maxBytes;
        this.spawnProcess = spawnProcess;
        this.roomQueues = new Map();
    }

    async publishClip({ roomId, port, audioBuffer, mimeType, durationMs }) {
        if (!audioBuffer || audioBuffer.length === 0) {
            throw new Error('No audio payload was provided for push-to-talk playback.');
        }
        if (audioBuffer.length > this.maxBytes) {
            throw new Error(`Push-to-talk payload exceeds the ${this.maxBytes} byte limit.`);
        }

        const queue = this.roomQueues.get(roomId) ?? Promise.resolve();
        const next = queue
            .catch(() => { })
            .then(() => this.#publishClipNow({ roomId, port, audioBuffer, mimeType, durationMs }));
        this.roomQueues.set(roomId, next);
        return next;
    }

    async #publishClipNow({ roomId, port, audioBuffer, mimeType, durationMs }) {
        await fs.mkdir(this.tempDirectory, { recursive: true });
        const extension = mimeToExtension(mimeType);
        const inputPath = path.join(this.tempDirectory, `${roomId}-${Date.now()}.${extension}`);
        const destination = `rtp://${this.host}:${port}?pkt_size=1200`;

        await fs.writeFile(inputPath, audioBuffer);
        this.emit('playback-started', { roomId, port, durationMs });

        try {
            await this.#runFfmpeg(inputPath, destination);
            this.emit('playback-ended', { roomId, port, durationMs });
        } catch (error) {
            this.emit('playback-error', { roomId, port, error });
            throw error;
        } finally {
            await fs.rm(inputPath, { force: true });
        }
    }

    #runFfmpeg(inputPath, destination) {
        const args = [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-re',
            '-i',
            inputPath,
            '-vn',
            '-map',
            '0:a:0',
            '-c:a',
            'libopus',
            '-application',
            'voip',
            '-ar',
            String(this.sampleRate),
            '-ac',
            String(this.channels),
            '-frame_duration',
            '20',
            '-f',
            'rtp',
            '-payload_type',
            String(this.payloadType),
            destination,
        ];

        return new Promise((resolve, reject) => {
            const child = this.spawnProcess(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';

            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(stderr || `FFmpeg exited with code ${code}.`));
            });
        });
    }
}

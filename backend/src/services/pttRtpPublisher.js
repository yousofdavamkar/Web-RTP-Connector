import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const LIVE_SESSION_SHUTDOWN_TIMEOUT_MS = 1500;

const mimeToExtension = (mimeType) => {
    if (mimeType?.includes('ogg')) {
        return 'ogg';
    }
    if (mimeType?.includes('wav')) {
        return 'wav';
    }
    return 'webm';
};

const mimeToInputFormat = (mimeType) => {
    const normalized = mimeType?.toLowerCase() ?? '';
    if (normalized.includes('ogg')) {
        return 'ogg';
    }
    return 'webm';
};

const codecToFfmpegEncoder = (codec) => {
    switch ((codec || 'opus').toLowerCase()) {
        case 'pcma':
            return 'pcm_alaw';
        case 'pcmu':
            return 'pcm_mulaw';
        case 'opus':
        default:
            return 'libopus';
    }
};

export class PttRtpPublisher extends EventEmitter {
    constructor({ ffmpegPath, host, payloadType = 111, sampleRate = 48000, channels = 1, tempDirectory, maxBytes = 10 * 1024 * 1024, mirrorTarget = null, spawnProcess = spawn }) {
        super();
        this.ffmpegPath = ffmpegPath;
        this.host = host;
        this.payloadType = payloadType;
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.tempDirectory = tempDirectory;
        this.maxBytes = maxBytes;
        this.mirrorTarget = mirrorTarget;
        this.spawnProcess = spawnProcess;
        this.roomQueues = new Map();
        this.liveSessions = new Map();
    }

    async startLiveSession({ sessionId, roomId, port, mimeType = 'audio/webm;codecs=opus' }) {
        if (!sessionId) {
            throw new Error('Live PTT session requires a sessionId.');
        }
        if (!roomId) {
            throw new Error('Live PTT session requires a roomId.');
        }
        if (!Number.isFinite(port)) {
            throw new Error('Live PTT session requires a valid RTP port.');
        }

        const existing = this.liveSessions.get(sessionId);
        if (existing) {
            return existing.meta;
        }

        const inputFormat = mimeToInputFormat(mimeType);
        const outputs = [];

        const primaryDestination = `rtp://${this.host}:${port}?pkt_size=1200`;
        outputs.push(this.#createLiveOutputProcess({
            inputFormat,
            destination: primaryDestination,
            codec: 'opus',
            payloadType: this.payloadType,
            sampleRate: this.sampleRate,
            channels: this.channels,
        }));

        if (this.mirrorTarget?.enabled && this.mirrorTarget.host && this.mirrorTarget.port > 0) {
            const mirrorDestination = `rtp://${this.mirrorTarget.host}:${this.mirrorTarget.port}?pkt_size=1200`;
            outputs.push(this.#createLiveOutputProcess({
                inputFormat,
                destination: mirrorDestination,
                codec: this.mirrorTarget.codec,
                payloadType: this.mirrorTarget.payloadType,
                sampleRate: this.mirrorTarget.sampleRate,
                channels: this.mirrorTarget.channels,
            }));
        }

        const liveSession = {
            sessionId,
            roomId,
            mimeType,
            outputPort: port,
            outputs,
            bytesReceived: 0,
            startedAtMs: Date.now(),
        };

        this.liveSessions.set(sessionId, liveSession);
        this.emit('playback-started', { roomId, durationMs: null });

        return {
            sessionId,
            roomId,
            mimeType,
            outputPort: port,
        };
    }

    hasLiveSession(sessionId) {
        return this.liveSessions.has(sessionId);
    }

    pushLiveChunk({ sessionId, chunk }) {
        const liveSession = this.liveSessions.get(sessionId);
        if (!liveSession) {
            throw new Error(`Live PTT session ${sessionId} is not active.`);
        }

        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? []);
        if (buffer.length === 0) {
            return;
        }

        liveSession.bytesReceived += buffer.length;
        if (liveSession.bytesReceived > this.maxBytes) {
            throw new Error(`Push-to-talk payload exceeds the ${this.maxBytes} byte limit.`);
        }

        for (const output of liveSession.outputs) {
            output.child.stdin.write(buffer);
        }
    }

    async stopLiveSession(sessionId) {
        const liveSession = this.liveSessions.get(sessionId);
        if (!liveSession) {
            return false;
        }

        this.liveSessions.delete(sessionId);

        const waiters = liveSession.outputs.map((output) => new Promise((resolve, reject) => {
            if (output.child.exitCode !== null || output.child.killed) {
                resolve();
                return;
            }

            let settled = false;

            const timeout = setTimeout(() => {
                if (!settled) {
                    output.child.kill('SIGKILL');
                }
            }, LIVE_SESSION_SHUTDOWN_TIMEOUT_MS);
            timeout.unref?.();

            output.child.once('close', (code) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                if (code === 0 || code === null) {
                    resolve();
                    return;
                }
                reject(new Error(output.stderr || `FFmpeg live session exited with code ${code}.`));
            });
        }));

        for (const output of liveSession.outputs) {
            output.child.stdin.end();
        }

        await Promise.all(waiters);
        const durationMs = Math.max(0, Date.now() - liveSession.startedAtMs);
        this.emit('playback-ended', { roomId: liveSession.roomId, durationMs });
        return true;
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
            const publishTasks = [
                this.#runFfmpeg(inputPath, destination, {
                    codec: 'opus',
                    payloadType: this.payloadType,
                    sampleRate: this.sampleRate,
                    channels: this.channels,
                }),
            ];

            if (this.mirrorTarget?.enabled && this.mirrorTarget.host && this.mirrorTarget.port > 0) {
                const mirrorDestination = `rtp://${this.mirrorTarget.host}:${this.mirrorTarget.port}?pkt_size=1200`;
                publishTasks.push(this.#runFfmpeg(inputPath, mirrorDestination, {
                    codec: this.mirrorTarget.codec,
                    payloadType: this.mirrorTarget.payloadType,
                    sampleRate: this.mirrorTarget.sampleRate,
                    channels: this.mirrorTarget.channels,
                }));
            }

            await Promise.all(publishTasks);
            this.emit('playback-ended', { roomId, port, durationMs });
        } catch (error) {
            this.emit('playback-error', { roomId, port, error });
            throw error;
        } finally {
            await fs.rm(inputPath, { force: true });
        }
    }

    #runFfmpeg(inputPath, destination, { codec = 'opus', payloadType = 111, sampleRate = 48000, channels = 1 } = {}) {
        const normalizedCodec = (codec || 'opus').toLowerCase();
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
            codecToFfmpegEncoder(normalizedCodec),
        ];

        if (normalizedCodec === 'opus') {
            args.push(
                '-application', 'voip',
                '-b:a', '48k',
                '-vbr', 'constrained',
                '-frame_duration', '20',
                '-packet_loss', '15',
            );
        }

        args.push(
            '-ar',
            String(sampleRate),
            '-ac',
            String(channels),
            '-f',
            'rtp',
            '-payload_type',
            String(payloadType),
            destination,
        );

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

    #createLiveOutputProcess({ inputFormat, destination, codec = 'opus', payloadType = 111, sampleRate = 48000, channels = 1 }) {
        const normalizedCodec = (codec || 'opus').toLowerCase();
        const args = [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-fflags',
            'nobuffer',
            '-flags',
            'low_delay',
            '-probesize',
            '32',
            '-analyzeduration',
            '0',
            '-f',
            inputFormat,
            '-i',
            'pipe:0',
            '-vn',
            '-map',
            '0:a:0',
            '-c:a',
            codecToFfmpegEncoder(normalizedCodec),
        ];

        if (normalizedCodec === 'opus') {
            args.push(
                '-application', 'voip',
                '-b:a', '48k',
                '-vbr', 'constrained',
                '-frame_duration', '20',
                '-packet_loss', '15',
            );
        }

        args.push(
            '-ar',
            String(sampleRate),
            '-ac',
            String(channels),
            '-flush_packets',
            '1',
            '-f',
            'rtp',
            '-payload_type',
            String(payloadType),
            destination,
        );

        const child = this.spawnProcess(this.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
        const output = { child, stderr: '' };

        child.stderr.on('data', (chunk) => {
            output.stderr += chunk.toString();
        });

        child.on('error', (error) => {
            output.stderr += `\n${error.message}`;
        });

        return output;
    }
}

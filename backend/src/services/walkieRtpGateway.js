import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

const INPUT_CODEC_MAP = {
    pcmu: { encodingName: 'PCMU', clockRate: 8000, channels: 1 },
    pcma: { encodingName: 'PCMA', clockRate: 8000, channels: 1 },
    opus: { encodingName: 'opus', clockRate: 48000, channels: 2 },
};

const STOP_GRACE_MS = 2000;
const STOP_KILL_GRACE_MS = 1000;
const MEDIA_IDLE_TIMEOUT_MS = 5000;
const FIRST_PACKET_TIMEOUT_MS = 30000;

const waitForSessionFinish = (session, timeoutMs) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    session.finished.then(() => {
        clearTimeout(timer);
        resolve(true);
    });
});

const createInputSdp = ({ host, port, payloadType, encodingName, clockRate, channels }) => {
    const channelSuffix = channels > 1 ? `/${channels}` : '';
    return [
        'v=0',
        `o=- 0 0 IN IP4 ${host}`,
        's=External Walkie RTP Input',
        `c=IN IP4 ${host}`,
        't=0 0',
        `m=audio ${port} RTP/AVP ${payloadType}`,
        `a=rtpmap:${payloadType} ${encodingName}/${clockRate}${channelSuffix}`,
        'a=recvonly',
        '',
    ].join('\n');
};

const normalizeInputCodec = (codec) => {
    const normalized = codec?.trim().toLowerCase() ?? 'pcmu';
    const codecConfig = INPUT_CODEC_MAP[normalized];
    if (!codecConfig) {
        throw new Error(`Unsupported external walkie RTP codec: ${codec}.`);
    }

    return { normalized, ...codecConfig };
};

export class WalkieRtpGateway extends EventEmitter {
    constructor({
        ffmpegPath,
        inputHost = '0.0.0.0',
        outputHost,
        outputPayloadType = 111,
        outputSampleRate = 48000,
        outputChannels = 1,
        inputListenTimeoutSeconds = 300,
        mediaIdleTimeoutMs = MEDIA_IDLE_TIMEOUT_MS,
        firstPacketTimeoutMs = FIRST_PACKET_TIMEOUT_MS,
        stopGraceMs = STOP_GRACE_MS,
        stopKillGraceMs = STOP_KILL_GRACE_MS,
        tempDirectory,
        spawnProcess = spawn,
    }) {
        super();
        this.ffmpegPath = ffmpegPath;
        this.inputHost = inputHost;
        this.outputHost = outputHost;
        this.outputPayloadType = outputPayloadType;
        this.outputSampleRate = outputSampleRate;
        this.outputChannels = outputChannels;
        this.inputListenTimeoutSeconds = inputListenTimeoutSeconds;
        this.mediaIdleTimeoutMs = mediaIdleTimeoutMs;
        this.firstPacketTimeoutMs = firstPacketTimeoutMs;
        this.stopGraceMs = stopGraceMs;
        this.stopKillGraceMs = stopKillGraceMs;
        this.tempDirectory = tempDirectory;
        this.spawnProcess = spawnProcess;
        this.sessions = new Map();
    }

    async startSession({ roomId, participantId, inputPort, inputCodec = 'pcmu', inputPayloadType = 0, outputPort }) {
        if (this.sessions.has(participantId)) {
            throw new Error(`External walkie participant ${participantId} already has an active RTP session.`);
        }

        const codec = normalizeInputCodec(inputCodec);
        await fs.mkdir(this.tempDirectory, { recursive: true });

        const sdpPath = path.join(this.tempDirectory, `walkie-${roomId}-${participantId}.sdp`);
        await fs.writeFile(sdpPath, createInputSdp({
            host: this.inputHost,
            port: inputPort,
            payloadType: inputPayloadType,
            encodingName: codec.encodingName,
            clockRate: codec.clockRate,
            channels: codec.channels,
        }));

        const destination = `rtp://${this.outputHost}:${outputPort}?pkt_size=1200`;
        const args = [
            '-nostdin',
            '-hide_banner',
            '-loglevel',
            'error',
            '-stats_period',
            '0.5',
            '-progress',
            'pipe:1',
            '-protocol_whitelist',
            'file,udp,rtp',
            '-fflags',
            '+genpts',
            '-listen_timeout',
            String(this.inputListenTimeoutSeconds),
            '-i',
            sdpPath,
            '-vn',
            '-map',
            '0:a:0',
            '-c:a',
            'libopus',
            '-application',
            'voip',
            '-b:a',
            '48k',
            '-vbr',
            'constrained',
            '-ar',
            String(this.outputSampleRate),
            '-ac',
            String(this.outputChannels),
            '-frame_duration',
            '20',
            '-packet_loss',
            '15',
            '-f',
            'rtp',
            '-payload_type',
            String(this.outputPayloadType),
            destination,
        ];

        let child;
        try {
            child = this.spawnProcess(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            await fs.rm(sdpPath, { force: true });
            throw error;
        }

        const session = {
            roomId,
            participantId,
            inputPort,
            inputCodec: codec.normalized,
            inputPayloadType,
            outputPort,
            sdpPath,
            child,
            stderr: '',
            stdoutBuffer: '',
            lastOutTimeUs: -1,
            idleTimer: null,
            stopRequested: false,
            finalized: false,
        };
        session.finished = new Promise((resolve) => {
            session.resolveFinished = resolve;
        });

        this.sessions.set(participantId, session);

        this.#refreshMediaIdleTimer(session);

        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            session.stderr += text;
            // Log in real-time so errors are visible without waiting for process exit.
            process.stderr.write(`[ffmpeg:${participantId}] ${text}`);
        });

        child.stdout.on('data', (chunk) => {
            session.stdoutBuffer += chunk.toString();
            let newlineIndex;
            while ((newlineIndex = session.stdoutBuffer.indexOf('\n')) !== -1) {
                const line = session.stdoutBuffer.slice(0, newlineIndex).trim();
                session.stdoutBuffer = session.stdoutBuffer.slice(newlineIndex + 1);
                let value = null;
                if (line.startsWith('out_time_us=')) {
                    value = Number.parseInt(line.slice('out_time_us='.length), 10);
                } else if (line.startsWith('out_time_ms=')) {
                    value = Number.parseInt(line.slice('out_time_ms='.length), 10);
                }
                if (value === null || !Number.isFinite(value)) {
                    continue;
                }
                if (value > session.lastOutTimeUs) {
                    session.lastOutTimeUs = value;
                    this.#refreshMediaIdleTimer(session);
                }
            }
        });

        child.on('error', (error) => {
            void this.#finalizeSession(session, { error });
        });

        child.on('close', (code, signal) => {
            const error = !session.stopRequested && code !== 0
                ? new Error(session.stderr || `FFmpeg exited with code ${code}.`)
                : null;
            void this.#finalizeSession(session, { code, signal, error });
        });

        this.emit('session-started', {
            roomId,
            participantId,
            inputPort,
            inputCodec: codec.normalized,
            inputPayloadType,
            outputPort,
        });

        return {
            roomId,
            participantId,
            inputPort,
            inputCodec: codec.normalized,
            inputPayloadType,
            outputPort,
        };
    }

    getSession(participantId) {
        const session = this.sessions.get(participantId);
        if (!session) {
            return null;
        }

        return {
            roomId: session.roomId,
            participantId: session.participantId,
            inputPort: session.inputPort,
            inputCodec: session.inputCodec,
            inputPayloadType: session.inputPayloadType,
            outputPort: session.outputPort,
        };
    }

    async stopSession(participantId) {
        const session = this.sessions.get(participantId);
        if (!session) {
            return false;
        }

        session.stopRequested = true;
        clearTimeout(session.idleTimer);
        session.idleTimer = null;

        session.child.kill('SIGTERM');
        if (await waitForSessionFinish(session, this.stopGraceMs)) {
            return true;
        }

        session.child.kill('SIGKILL');
        if (await waitForSessionFinish(session, this.stopKillGraceMs)) {
            return true;
        }

        await this.#finalizeSession(session, { signal: 'SIGKILL' });
        return true;
    }

    async stopRoomSessions(roomId) {
        const sessions = Array.from(this.sessions.values())
            .filter((session) => session.roomId === roomId)
            .map((session) => this.stopSession(session.participantId));
        await Promise.all(sessions);
    }

    async close() {
        await Promise.all(Array.from(this.sessions.keys()).map((participantId) => this.stopSession(participantId)));
    }

    async #finalizeSession(session, { code = null, signal = null, error = null } = {}) {
        if (session.finalized) {
            return;
        }

        session.finalized = true;
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
        this.sessions.delete(session.participantId);
        await fs.rm(session.sdpPath, { force: true });

        if (error) {
            this.emit('session-error', {
                roomId: session.roomId,
                participantId: session.participantId,
                inputPort: session.inputPort,
                outputPort: session.outputPort,
                error,
            });
        } else {
            this.emit('session-stopped', {
                roomId: session.roomId,
                participantId: session.participantId,
                inputPort: session.inputPort,
                outputPort: session.outputPort,
                code,
                signal,
            });
        }

        session.resolveFinished();
    }

    #refreshMediaIdleTimer(session) {
        if (session.stopRequested || session.finalized) {
            return;
        }

        clearTimeout(session.idleTimer);
        const timeoutMs = session.lastOutTimeUs < 0
            ? this.firstPacketTimeoutMs
            : this.mediaIdleTimeoutMs;
        session.idleTimer = setTimeout(() => {
            if (!session.stopRequested && !session.finalized) {
                void this.stopSession(session.participantId);
            }
        }, timeoutMs);
        session.idleTimer.unref?.();
    }
}
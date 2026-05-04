import dotenv from 'dotenv';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config();

const parseInteger = (value, fallback) => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBoolean = (value, fallback = false) => {
    if (typeof value !== 'string') {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return fallback;
};

const resolveBundledFfmpegPath = () => {
    try {
        return require('ffmpeg-static');
    } catch {
        return null;
    }
};

const resolveFfmpegPath = () => {
    const configuredPath = process.env.FFMPEG_PATH?.trim();
    const bundledPath = resolveBundledFfmpegPath();

    if (configuredPath && configuredPath !== 'ffmpeg') {
        return configuredPath;
    }

    return bundledPath ?? configuredPath ?? 'ffmpeg';
};

const parseClientOrigin = (value) => {
    const normalized = value?.trim();
    if (!normalized) {
        return true;
    }
    if (normalized === '*') {
        return true;
    }

    const origins = normalized
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    if (origins.length === 0) {
        return true;
    }
    return origins.length === 1 ? origins[0] : origins;
};

export const config = {
    signalingPort: parseInteger(process.env.SIGNALING_PORT, 4000),
    clientOrigin: parseClientOrigin(process.env.CLIENT_ORIGIN),
    janus: {
        wsUrl: process.env.JANUS_WS_URL ?? 'ws://localhost:8188',
        apiSecret: process.env.JANUS_API_SECRET ?? '',
        streamingAdminKey: process.env.JANUS_STREAMING_ADMIN_KEY ?? 'streaming-admin-key',
        audioBridgeAdminKey: process.env.JANUS_AUDIOBRIDGE_ADMIN_KEY ?? 'audiobridge-admin-key',
        streamingBindHost: process.env.JANUS_STREAMING_BIND_HOST ?? 'janus',
        streamingPublicHost: process.env.JANUS_STREAMING_PUBLIC_HOST ?? 'localhost',
        rtpForwardHost: process.env.JANUS_RTP_FORWARD_HOST ?? 'host.docker.internal',
        rtpForwardPort: parseInteger(process.env.JANUS_RTP_FORWARD_PORT, 7000),
        streamingPortStart: parseInteger(process.env.JANUS_STREAMING_PORT_START, 5004),
        streamingPortEnd: parseInteger(process.env.JANUS_STREAMING_PORT_END, 5098),
        streamingMountpointIdStart: parseInteger(process.env.JANUS_STREAMING_MOUNTPOINT_ID_START, 4100),
        streamingMountpointIdEnd: parseInteger(process.env.JANUS_STREAMING_MOUNTPOINT_ID_END, 4999),
    },
    walkieRtp: {
        publicHost: process.env.WALKIE_RTP_PUBLIC_HOST?.trim()
            || process.env.LAN_HOST_IP?.trim()
            || '127.0.0.1',
        portStart: parseInteger(process.env.WALKIE_RTP_PORT_START, 7004),
        portEnd: parseInteger(process.env.WALKIE_RTP_PORT_END, 7098),
        inputCodec: process.env.WALKIE_RTP_INPUT_CODEC?.trim().toLowerCase() || 'pcmu',
        inputPayloadType: parseInteger(process.env.WALKIE_RTP_INPUT_PAYLOAD_TYPE, 0),
        autoRadio: {
            enabled: parseBoolean(process.env.WALKIE_RTP_AUTO_RADIO_ENABLED, false),
            participantId: process.env.WALKIE_RTP_AUTO_RADIO_ID?.trim() || 'auto-radio',
            displayName: process.env.WALKIE_RTP_AUTO_RADIO_DISPLAY_NAME?.trim() || 'Radio Gateway',
            rearmIntervalSec: parseInteger(process.env.WALKIE_RTP_AUTO_RADIO_REARM_SEC, 3),
        },
        browserMirror: {
            enabled: parseBoolean(process.env.WALKIE_RTP_BROWSER_MIRROR_ENABLED, false),
            host: process.env.WALKIE_RTP_BROWSER_MIRROR_HOST?.trim() || '',
            port: parseInteger(process.env.WALKIE_RTP_BROWSER_MIRROR_PORT, 0),
            codec: process.env.WALKIE_RTP_BROWSER_MIRROR_CODEC?.trim().toLowerCase() || 'pcma',
            payloadType: parseInteger(process.env.WALKIE_RTP_BROWSER_MIRROR_PAYLOAD_TYPE, 8),
        },
    },
    ffmpegPath: resolveFfmpegPath(),
    maxPttBytes: parseInteger(process.env.MAX_PTT_BYTES, 10 * 1024 * 1024),
    tempDirectory: path.resolve(process.cwd(), 'tmp'),
};

export const socketEventNames = Object.freeze({
    joinRoom: 'join-room',
    leaveRoom: 'leave-room',
    roomJoined: 'room-joined',
    roomState: 'room-state',
    offer: 'offer',
    answer: 'answer',
    iceCandidate: 'ice-candidate',
    pttStart: 'ptt-start',
    pttChunk: 'ptt-chunk',
    pttStop: 'ptt-stop',
    pttBusy: 'ptt-busy',
    pttPlaybackStarted: 'ptt-playback-started',
    pttPlaybackEnded: 'ptt-playback-ended',
    callRequest: 'call-request',
    callAccept: 'call-accept',
    callReject: 'call-reject',
    callEnd: 'call-end',
    callMute: 'call-mute',
    incomingCall: 'incoming-call',
    callAccepted: 'call-accepted',
    callRejected: 'call-rejected',
    callEnded: 'call-ended',
    error: 'app-error',
});

export const roomModes = Object.freeze({
    WALKIE_TALKIE: 'walkie-talkie',
    PHONE_CALL: 'phone-call',
});

import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config();

const parseInteger = (value, fallback) => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const parseClientOrigin = (value) => {
    const normalized = value?.trim();
    if (!normalized) {
        return 'http://localhost:5173';
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
    },
    ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
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

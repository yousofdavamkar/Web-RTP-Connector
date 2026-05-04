import fs from 'node:fs/promises';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { Server as SocketIOServer } from 'socket.io';

import { config, socketEventNames } from './config.js';
import { createRoomsRouter } from './routes/rooms.js';
import { JanusClient } from './services/janusClient.js';
import { PttRtpPublisher } from './services/pttRtpPublisher.js';
import { WalkieRtpGateway } from './services/walkieRtpGateway.js';
import { registerSocketHandlers } from './socket/registerSocketHandlers.js';
import { RoomStore, createExternalWalkieOwnerId } from './state/roomStore.js';

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
    cors: {
        origin: config.clientOrigin,
        methods: ['GET', 'POST', 'DELETE'],
    },
    maxHttpBufferSize: config.maxPttBytes,
});

const janusClient = new JanusClient({
    wsUrl: config.janus.wsUrl,
    apiSecret: config.janus.apiSecret,
    streamingAdminKey: config.janus.streamingAdminKey,
    audioBridgeAdminKey: config.janus.audioBridgeAdminKey,
});

const JANUS_RETRY_DELAY_MS = 3000;
let janusReconnectTimer = null;
let shuttingDown = false;

const roomStore = new RoomStore({
    janusClient,
    portRangeStart: config.janus.streamingPortStart,
    portRangeEnd: config.janus.streamingPortEnd,
    externalWalkiePortStart: config.walkieRtp.portStart,
    externalWalkiePortEnd: config.walkieRtp.portEnd,
});

const pttPublisher = new PttRtpPublisher({
    ffmpegPath: config.ffmpegPath,
    host: config.janus.streamingBindHost,
    tempDirectory: config.tempDirectory,
    maxBytes: config.maxPttBytes,
});

const walkieRtpGateway = new WalkieRtpGateway({
    ffmpegPath: config.ffmpegPath,
    outputHost: config.janus.streamingBindHost,
    tempDirectory: config.tempDirectory,
});

const emitRoomState = (roomId) => {
    const room = roomStore.getRoom(roomId);
    if (room) {
        io.to(roomId).emit(socketEventNames.roomState, roomStore.serializeRoom(room));
    }
};

app.use(
    cors({
        origin: config.clientOrigin,
        credentials: true,
    }),
);
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(morgan('dev'));

app.get('/health', (_request, response) => {
    response.json({
        ok: true,
        janus: janusClient.getState(),
        rooms: roomStore.listRooms().length,
    });
});

app.use('/api/rooms', createRoomsRouter({
    roomStore,
    janusClient,
    config,
    walkieRtpGateway,
    notifyRoomState: emitRoomState,
}));

app.use((error, _request, response, _next) => {
    const status = error.message?.includes('not found') ? 404 : 500;
    response.status(status).json({ error: error.message || 'Unexpected server error.' });
});

registerSocketHandlers({ io, roomStore, janusClient, pttPublisher });

walkieRtpGateway.on('session-error', ({ roomId, participantId, error }) => {
    roomStore.releasePtt(roomId, createExternalWalkieOwnerId(participantId));
    emitRoomState(roomId);
    console.warn(`[walkie-rtp:error] room=${roomId} participant=${participantId} ${error.message}`);
});

walkieRtpGateway.on('session-stopped', ({ roomId, participantId }) => {
    roomStore.releasePtt(roomId, createExternalWalkieOwnerId(participantId));
    emitRoomState(roomId);
});

const scheduleJanusBootstrap = (delayMs = 0) => {
    if (shuttingDown || janusReconnectTimer) {
        return;
    }

    janusReconnectTimer = setTimeout(async () => {
        janusReconnectTimer = null;

        try {
            await janusClient.ensureSession();
            // Destroy stale dynamic streaming mountpoints left over from previous backend sessions.
            await janusClient.destroyStaleDynamicMountpoints({
                idRangeStart: config.janus.streamingMountpointIdStart,
                idRangeEnd: config.janus.streamingMountpointIdEnd,
            }).catch((error) => {
                console.warn(`Stale mountpoint cleanup failed (non-fatal): ${error.message}`);
            });
        } catch (error) {
            console.warn(`Janus bootstrap failed: ${error.message}`);
            scheduleJanusBootstrap(JANUS_RETRY_DELAY_MS);
        }
    }, delayMs);
};

janusClient.on('disconnected', () => {
    scheduleJanusBootstrap(JANUS_RETRY_DELAY_MS);
});

const bootstrap = async () => {
    await fs.mkdir(config.tempDirectory, { recursive: true });
    scheduleJanusBootstrap();

    server.listen(config.signalingPort, () => {
        console.log(`Signaling server listening on http://localhost:${config.signalingPort}`);
    });
};

const shutdown = async () => {
    shuttingDown = true;
    clearTimeout(janusReconnectTimer);
    janusReconnectTimer = null;
    io.close();
    server.close();
    await walkieRtpGateway.close();
    await janusClient.close();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

bootstrap().catch((error) => {
    console.error(error);
    process.exit(1);
});

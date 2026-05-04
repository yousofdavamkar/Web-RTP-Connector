import express from 'express';
import { randomUUID } from 'node:crypto';

import { createExternalWalkieOwnerId } from '../state/roomStore.js';

const createId = (length = 12) => randomUUID().replace(/-/g, '').slice(0, length);
const WALKIE_INPUT_CODEC_DEFAULT_PAYLOADS = Object.freeze({
    pcmu: 0,
    pcma: 8,
    opus: 111,
});

const LOCAL_REQUEST_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const parseOptionalInteger = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeWalkieInputCodec = (value, fallback = 'pcmu') => {
    const normalized = value?.trim().toLowerCase() || fallback;
    if (!Object.hasOwn(WALKIE_INPUT_CODEC_DEFAULT_PAYLOADS, normalized)) {
        throw new Error(`Unsupported walkie RTP input codec: ${value}.`);
    }
    return normalized;
};

const resolveWalkieIngestHost = ({ requestedHost, explicitHost, fallbackHost }) => {
    const normalizedExplicitHost = explicitHost?.trim();
    if (normalizedExplicitHost) {
        return normalizedExplicitHost;
    }

    const normalizedRequestedHost = requestedHost?.split(':')[0]?.trim().toLowerCase();
    if (normalizedRequestedHost && LOCAL_REQUEST_HOSTS.has(normalizedRequestedHost)) {
        return '127.0.0.1';
    }

    return fallbackHost;
};

const serializeWalkieParticipant = (roomStore, roomId, externalParticipantId) => {
    const room = roomStore.getRoom(roomId);
    if (!room) {
        return null;
    }

    return roomStore
        .serializeRoom(room)
        .externalWalkieParticipants
        .find((participant) => participant.externalParticipantId === externalParticipantId) ?? null;
};

export const createRoomsRouter = ({ roomStore, janusClient, config, walkieRtpGateway, notifyRoomState = () => { } }) => {
    const router = express.Router();

    router.get('/', (_request, response) => {
        response.json({ rooms: roomStore.listRooms() });
    });

    router.post('/', async (request, response, next) => {
        try {
            const room = await roomStore.createRoom({
                roomId: request.body.roomId,
                name: request.body.name,
            });
            response.status(201).json({ room: roomStore.serializeRoom(room) });
        } catch (error) {
            if (error.message?.includes('already exists')) {
                const existingRoom = roomStore.getRoom(request.body.roomId?.trim());
                if (existingRoom) {
                    response.status(200).json({ room: roomStore.serializeRoom(existingRoom) });
                    return;
                }
            }
            next(error);
        }
    });

    router.get('/:roomId', (request, response) => {
        const room = roomStore.getRoom(request.params.roomId);
        if (!room) {
            response.status(404).json({ error: 'Room not found.' });
            return;
        }
        response.json({ room: roomStore.serializeRoom(room) });
    });

    router.get('/:roomId/forwarders', (request, response) => {
        const forwarders = roomStore.listForwarders(request.params.roomId);
        if (!forwarders) {
            response.status(404).json({ error: 'Room not found.' });
            return;
        }
        response.json({ forwarders });
    });

    router.get('/:roomId/walkie-rtp-participants', (request, response) => {
        const participants = roomStore.listExternalWalkieParticipants(request.params.roomId);
        if (!participants) {
            response.status(404).json({ error: 'Room not found.' });
            return;
        }

        const room = roomStore.getRoom(request.params.roomId);
        response.json({ participants: roomStore.serializeRoom(room).externalWalkieParticipants });
    });

    router.delete('/:roomId', async (request, response, next) => {
        try {
            await walkieRtpGateway.stopRoomSessions(request.params.roomId);
            const removed = await roomStore.deleteRoom(request.params.roomId);
            if (!removed) {
                response.status(404).json({ error: 'Room not found.' });
                return;
            }
            response.status(204).send();
        } catch (error) {
            next(error);
        }
    });

    router.post('/:roomId/walkie-rtp-participants', (request, response, next) => {
        const room = roomStore.getRoom(request.params.roomId);
        if (!room) {
            response.status(404).json({ error: 'Room not found.' });
            return;
        }

        const inputCodec = normalizeWalkieInputCodec(request.body.inputCodec, config.walkieRtp.inputCodec);
        const payloadType = parseOptionalInteger(
            request.body.payloadType ?? request.body.ptype,
            WALKIE_INPUT_CODEC_DEFAULT_PAYLOADS[inputCodec] ?? config.walkieRtp.inputPayloadType,
        );
        const ingestPort = roomStore.allocateExternalWalkiePort();
        const ingestHost = resolveWalkieIngestHost({
            requestedHost: request.get('host'),
            explicitHost: request.body.ingestHost,
            fallbackHost: config.walkieRtp.publicHost,
        });

        try {
            const externalParticipantId = createId(10);
            const participant = roomStore.addExternalWalkieParticipant(request.params.roomId, {
                externalParticipantId,
                displayName: request.body.displayName?.trim() || 'VLC Walkie Endpoint',
                inputCodec,
                payloadType,
                ingestHost,
                ingestPort,
                createdAt: new Date().toISOString(),
            });

            console.info(`[walkie-rtp:create] room=${request.params.roomId} participant=${externalParticipantId} codec=${inputCodec} pt=${payloadType} listen=${participant.ingestHost}:${participant.ingestPort}`);
            notifyRoomState(request.params.roomId);
            response.status(201).json({ participant: serializeWalkieParticipant(roomStore, request.params.roomId, externalParticipantId) });
        } catch (error) {
            roomStore.releaseExternalWalkiePort(ingestPort);
            next(error);
        }
    });

    router.post('/:roomId/walkie-rtp-participants/:externalParticipantId/ptt/start', async (request, response, next) => {
        try {
            const room = roomStore.getRoom(request.params.roomId);
            if (!room) {
                response.status(404).json({ error: 'Room not found.' });
                return;
            }

            const participant = roomStore.getExternalWalkieParticipant(request.params.roomId, request.params.externalParticipantId);
            if (!participant) {
                response.status(404).json({ error: 'Walkie RTP participant not found.' });
                return;
            }

            const existingSession = walkieRtpGateway.getSession(request.params.externalParticipantId);
            if (existingSession) {
                response.status(200).json({
                    participant: serializeWalkieParticipant(roomStore, request.params.roomId, request.params.externalParticipantId),
                    session: existingSession,
                });
                return;
            }

            const ownerId = createExternalWalkieOwnerId(request.params.externalParticipantId);
            const claimed = roomStore.claimPtt(request.params.roomId, ownerId);
            if (!claimed) {
                response.status(409).json({
                    error: 'The walkie-talkie channel is currently busy.',
                    holder: room.activePttSpeaker,
                });
                return;
            }

            try {
                const session = await walkieRtpGateway.startSession({
                    roomId: request.params.roomId,
                    participantId: request.params.externalParticipantId,
                    inputPort: participant.ingestPort,
                    inputCodec: participant.inputCodec,
                    inputPayloadType: participant.payloadType,
                    outputPort: room.janus.streamingPort,
                });

                console.info(`[walkie-rtp:start] room=${request.params.roomId} participant=${request.params.externalParticipantId} src=${participant.ingestHost}:${participant.ingestPort} dst=${config.janus.streamingBindHost}:${room.janus.streamingPort}`);
                notifyRoomState(request.params.roomId);
                response.status(201).json({
                    participant: serializeWalkieParticipant(roomStore, request.params.roomId, request.params.externalParticipantId),
                    session,
                });
            } catch (error) {
                roomStore.releasePtt(request.params.roomId, ownerId);
                throw error;
            }
        } catch (error) {
            next(error);
        }
    });

    router.post('/:roomId/walkie-rtp-participants/:externalParticipantId/ptt/stop', async (request, response, next) => {
        try {
            const participant = roomStore.getExternalWalkieParticipant(request.params.roomId, request.params.externalParticipantId);
            if (!participant) {
                response.status(404).json({ error: 'Walkie RTP participant not found.' });
                return;
            }

            await walkieRtpGateway.stopSession(request.params.externalParticipantId);
            roomStore.releasePtt(request.params.roomId, createExternalWalkieOwnerId(request.params.externalParticipantId));

            console.info(`[walkie-rtp:stop] room=${request.params.roomId} participant=${request.params.externalParticipantId}`);
            notifyRoomState(request.params.roomId);
            response.status(200).json({ stopped: true });
        } catch (error) {
            next(error);
        }
    });

    router.post('/:roomId/forwarders', async (request, response, next) => {
        try {
            const room = roomStore.getRoom(request.params.roomId);
            if (!room) {
                response.status(404).json({ error: 'Room not found.' });
                return;
            }

            const forwarder = await janusClient.createAudioBridgeForwarder({
                room: room.janus.audioBridgeRoomId,
                host: request.body.host ?? config.janus.rtpForwardHost,
                port: parseOptionalInteger(request.body.port, config.janus.rtpForwardPort),
                codec: request.body.codec ?? 'opus',
                ptype: parseOptionalInteger(request.body.payloadType ?? request.body.ptype, 111),
                alwaysOn: request.body.alwaysOn ?? true,
            });

            const storedForwarder = roomStore.addForwarder(request.params.roomId, {
                streamId: forwarder.stream_id,
                host: request.body.host ?? config.janus.rtpForwardHost,
                port: parseOptionalInteger(request.body.port, config.janus.rtpForwardPort),
                codec: request.body.codec ?? 'opus',
                payloadType: parseOptionalInteger(request.body.payloadType ?? request.body.ptype, 111),
                alwaysOn: request.body.alwaysOn ?? true,
                createdAt: new Date().toISOString(),
            });

            console.info(`[forwarder:create] room=${request.params.roomId} stream=${storedForwarder.streamId} codec=${storedForwarder.codec} pt=${storedForwarder.payloadType} dst=${storedForwarder.host}:${storedForwarder.port}`);

            response.status(201).json({ forwarder });
        } catch (error) {
            next(error);
        }
    });

    router.delete('/:roomId/forwarders/:streamId', async (request, response, next) => {
        try {
            const room = roomStore.getRoom(request.params.roomId);
            if (!room) {
                response.status(404).json({ error: 'Room not found.' });
                return;
            }
            await janusClient.stopAudioBridgeForwarder({
                room: room.janus.audioBridgeRoomId,
                streamId: Number.parseInt(request.params.streamId, 10),
            });

            const removed = roomStore.removeForwarder(request.params.roomId, Number.parseInt(request.params.streamId, 10));
            if (removed) {
                console.info(`[forwarder:delete] room=${request.params.roomId} stream=${removed.streamId} codec=${removed.codec} pt=${removed.payloadType} dst=${removed.host}:${removed.port}`);
            }

            response.status(204).send();
        } catch (error) {
            next(error);
        }
    });

    router.post('/:roomId/rtp-participants', async (request, response, next) => {
        try {
            const room = roomStore.getRoom(request.params.roomId);
            if (!room) {
                response.status(404).json({ error: 'Room not found.' });
                return;
            }

            const remotePort = Number.parseInt(request.body.remotePort, 10);
            const participant = await janusClient.createAudioBridgeRtpParticipant({
                room: room.janus.audioBridgeRoomId,
                display: request.body.displayName ?? 'VLC RTP Endpoint',
                codec: request.body.codec ?? 'opus',
                host: request.body.remoteHost,
                port: Number.isFinite(remotePort) ? remotePort : undefined,
                payloadType: parseOptionalInteger(request.body.payloadType ?? request.body.ptype, 111),
                muted: request.body.muted ?? false,
            });

            const externalParticipantId = createId(10);
            const storedParticipant = roomStore.addExternalRtpParticipant(request.params.roomId, {
                externalParticipantId,
                handleId: participant.handleId,
                janusParticipantId: participant.janusParticipantId,
                displayName: participant.display,
                codec: request.body.codec ?? 'opus',
                remoteHost: request.body.remoteHost ?? null,
                remotePort: Number.isFinite(remotePort) ? remotePort : null,
                janusRtp: participant.janusRtp,
                createdAt: new Date().toISOString(),
            });

            response.status(201).json({ participant: storedParticipant });
        } catch (error) {
            next(error);
        }
    });

    router.delete('/:roomId/walkie-rtp-participants/:externalParticipantId', async (request, response, next) => {
        try {
            const participant = roomStore.getExternalWalkieParticipant(request.params.roomId, request.params.externalParticipantId);
            if (!participant) {
                response.status(404).json({ error: 'Walkie RTP participant not found.' });
                return;
            }

            await walkieRtpGateway.stopSession(request.params.externalParticipantId);
            roomStore.releasePtt(request.params.roomId, createExternalWalkieOwnerId(request.params.externalParticipantId));
            roomStore.removeExternalWalkieParticipant(request.params.roomId, request.params.externalParticipantId);

            console.info(`[walkie-rtp:delete] room=${request.params.roomId} participant=${request.params.externalParticipantId} listen=${participant.ingestHost}:${participant.ingestPort}`);
            notifyRoomState(request.params.roomId);
            response.status(204).send();
        } catch (error) {
            next(error);
        }
    });

    router.delete('/:roomId/rtp-participants/:externalParticipantId', async (request, response, next) => {
        try {
            const participant = roomStore.removeExternalRtpParticipant(
                request.params.roomId,
                request.params.externalParticipantId,
            );
            if (!participant) {
                response.status(404).json({ error: 'RTP participant not found.' });
                return;
            }

            await janusClient.detachHandle(participant.handleId);
            response.status(204).send();
        } catch (error) {
            next(error);
        }
    });

    return router;
};

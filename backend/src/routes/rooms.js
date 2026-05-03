import express from 'express';
import { randomUUID } from 'node:crypto';

const createId = (length = 12) => randomUUID().replace(/-/g, '').slice(0, length);
const parseOptionalInteger = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};

export const createRoomsRouter = ({ roomStore, janusClient, config }) => {
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

    router.delete('/:roomId', async (request, response, next) => {
        try {
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

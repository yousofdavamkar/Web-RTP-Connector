import { randomUUID } from 'node:crypto';

const DEFAULT_AUDIO_ROOM_START = 3100;
const DEFAULT_STREAM_MOUNTPOINT_START = 4100;
const createId = (length = 12) => randomUUID().replace(/-/g, '').slice(0, length);

export class RoomStore {
    constructor({ janusClient, portRangeStart = 5004, portRangeEnd = 5098 }) {
        this.janusClient = janusClient;
        this.rooms = new Map();
        this.userRoomIndex = new Map();
        this.allocatedPorts = new Set();
        this.portRangeStart = portRangeStart;
        this.portRangeEnd = portRangeEnd;
        this.nextAudioBridgeRoomId = DEFAULT_AUDIO_ROOM_START;
        this.nextStreamingMountpointId = DEFAULT_STREAM_MOUNTPOINT_START;
    }

    listRooms() {
        return Array.from(this.rooms.values()).map((room) => this.serializeRoom(room));
    }

    getRoom(roomId) {
        return this.rooms.get(roomId) ?? null;
    }

    serializeRoom(room) {
        return {
            roomId: room.roomId,
            name: room.name,
            createdAt: room.createdAt,
            participants: Array.from(room.participants.values()).map((participant) => ({
                socketId: participant.socketId,
                userId: participant.userId,
                displayName: participant.displayName,
                mode: participant.mode,
                joinedAt: participant.joinedAt,
                muted: participant.muted,
            })),
            janus: {
                streamingMountpointId: room.janus.streamingMountpointId,
                streamingPort: room.janus.streamingPort,
                audioBridgeRoomId: room.janus.audioBridgeRoomId,
            },
            externalRtpParticipants: Array.from(room.externalRtpParticipants.values()).map((participant) => ({
                externalParticipantId: participant.externalParticipantId,
                displayName: participant.displayName,
                codec: participant.codec,
                remoteHost: participant.remoteHost,
                remotePort: participant.remotePort,
                janusRtp: participant.janusRtp,
                createdAt: participant.createdAt,
            })),
            forwarders: Array.from(room.forwarders.values()).map((forwarder) => ({
                streamId: forwarder.streamId,
                host: forwarder.host,
                port: forwarder.port,
                codec: forwarder.codec,
                payloadType: forwarder.payloadType,
                alwaysOn: forwarder.alwaysOn,
                createdAt: forwarder.createdAt,
            })),
            activePttSpeaker: room.activePttSpeaker,
            call: { ...room.call },
        };
    }

    async createRoom({ roomId, name }) {
        const normalizedRoomId = roomId?.trim() || createId(8).toLowerCase();
        if (this.rooms.has(normalizedRoomId)) {
            throw new Error(`Room ${normalizedRoomId} already exists.`);
        }

        const streamingPort = this.allocatePort();
        const audioBridgeRoomId = this.nextAudioBridgeRoomId++;
        const streamingMountpointId = this.nextStreamingMountpointId++;

        try {
            await this.janusClient.createStreamingMountpoint({
                id: streamingMountpointId,
                name: `${normalizedRoomId}-ptt`,
                description: `${name ?? normalizedRoomId} Push-to-Talk`,
                audioPort: streamingPort,
            });

            await this.janusClient.createAudioBridgeRoom({
                room: audioBridgeRoomId,
                description: `${name ?? normalizedRoomId} Phone Call`,
            });
        } catch (error) {
            this.releasePort(streamingPort);
            throw error;
        }

        const room = {
            roomId: normalizedRoomId,
            name: name?.trim() || normalizedRoomId,
            createdAt: new Date().toISOString(),
            participants: new Map(),
            externalRtpParticipants: new Map(),
            forwarders: new Map(),
            janus: {
                streamingMountpointId,
                streamingPort,
                audioBridgeRoomId,
            },
            activePttSpeaker: null,
            call: {
                status: 'idle',
                pendingCallerId: null,
                acceptedBy: null,
                startedAt: null,
            },
        };

        this.rooms.set(normalizedRoomId, room);
        return room;
    }

    async deleteRoom(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) {
            return false;
        }

        await this.janusClient.destroyStreamingMountpoint(room.janus.streamingMountpointId).catch(() => { });
        await this.janusClient.destroyAudioBridgeRoom(room.janus.audioBridgeRoomId).catch(() => { });

        for (const participant of room.participants.values()) {
            this.userRoomIndex.delete(participant.socketId);
        }
        this.releasePort(room.janus.streamingPort);
        this.rooms.delete(roomId);
        return true;
    }

    addParticipant({ roomId, socketId, displayName, mode }) {
        const room = this.rooms.get(roomId);
        if (!room) {
            throw new Error(`Room ${roomId} does not exist.`);
        }

        const participant = {
            socketId,
            userId: createId(10),
            displayName: displayName?.trim() || `User-${socketId.slice(0, 6)}`,
            mode,
            joinedAt: new Date().toISOString(),
            streamingHandleId: null,
            audioBridgeHandleId: null,
            janusParticipantId: null,
            muted: false,
        };

        room.participants.set(socketId, participant);
        this.userRoomIndex.set(socketId, roomId);
        return participant;
    }

    removeParticipant(socketId) {
        const roomId = this.userRoomIndex.get(socketId);
        if (!roomId) {
            return { room: null, participant: null };
        }

        const room = this.rooms.get(roomId);
        const participant = room?.participants.get(socketId) ?? null;
        if (room && participant) {
            room.participants.delete(socketId);
            if (room.activePttSpeaker === socketId) {
                room.activePttSpeaker = null;
            }
            if (room.call.pendingCallerId === socketId || room.call.acceptedBy === socketId) {
                room.call = {
                    status: 'idle',
                    pendingCallerId: null,
                    acceptedBy: null,
                    startedAt: null,
                };
            }
        }

        this.userRoomIndex.delete(socketId);
        return { room, participant };
    }

    findParticipant(socketId) {
        const roomId = this.userRoomIndex.get(socketId);
        const room = roomId ? this.rooms.get(roomId) : null;
        return {
            room,
            participant: room?.participants.get(socketId) ?? null,
        };
    }

    setStreamingHandle(socketId, handleId) {
        const { participant } = this.findParticipant(socketId);
        if (participant) {
            participant.streamingHandleId = handleId;
        }
    }

    setAudioBridgeHandle(socketId, handleId) {
        const { participant } = this.findParticipant(socketId);
        if (participant) {
            participant.audioBridgeHandleId = handleId;
        }
    }

    setJanusParticipantId(socketId, janusParticipantId) {
        const { participant } = this.findParticipant(socketId);
        if (participant) {
            participant.janusParticipantId = janusParticipantId;
        }
    }

    setMuted(socketId, muted) {
        const { participant } = this.findParticipant(socketId);
        if (participant) {
            participant.muted = muted;
        }
    }

    claimPtt(roomId, socketId) {
        const room = this.rooms.get(roomId);
        if (!room) {
            throw new Error(`Room ${roomId} does not exist.`);
        }
        if (room.activePttSpeaker && room.activePttSpeaker !== socketId) {
            return false;
        }
        room.activePttSpeaker = socketId;
        return true;
    }

    releasePtt(roomId, socketId) {
        const room = this.rooms.get(roomId);
        if (room && room.activePttSpeaker === socketId) {
            room.activePttSpeaker = null;
        }
    }

    startCall(roomId, callerSocketId) {
        const room = this.rooms.get(roomId);
        if (!room) {
            throw new Error(`Room ${roomId} does not exist.`);
        }
        const otherParticipants = Array.from(room.participants.values()).filter(
            (participant) => participant.socketId !== callerSocketId,
        );
        if (otherParticipants.length === 0) {
            throw new Error('A phone call requires another participant in the room.');
        }
        room.call = {
            status: 'ringing',
            pendingCallerId: callerSocketId,
            acceptedBy: null,
            startedAt: null,
        };
        return otherParticipants[0];
    }

    acceptCall(roomId, receiverSocketId) {
        const room = this.rooms.get(roomId);
        if (!room || room.call.status !== 'ringing') {
            throw new Error('There is no active incoming call to accept.');
        }
        room.call = {
            status: 'in-call',
            pendingCallerId: room.call.pendingCallerId,
            acceptedBy: receiverSocketId,
            startedAt: new Date().toISOString(),
        };
        return room.call;
    }

    rejectCall(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) {
            throw new Error(`Room ${roomId} does not exist.`);
        }
        const previous = { ...room.call };
        room.call = {
            status: 'idle',
            pendingCallerId: null,
            acceptedBy: null,
            startedAt: null,
        };
        return previous;
    }

    endCall(roomId) {
        return this.rejectCall(roomId);
    }

    addExternalRtpParticipant(roomId, participant) {
        const room = this.rooms.get(roomId);
        if (!room) {
            throw new Error(`Room ${roomId} does not exist.`);
        }
        room.externalRtpParticipants.set(participant.externalParticipantId, participant);
        return participant;
    }

    removeExternalRtpParticipant(roomId, externalParticipantId) {
        const room = this.rooms.get(roomId);
        if (!room) {
            return null;
        }
        const participant = room.externalRtpParticipants.get(externalParticipantId) ?? null;
        if (participant) {
            room.externalRtpParticipants.delete(externalParticipantId);
        }
        return participant;
    }

    addForwarder(roomId, forwarder) {
        const room = this.rooms.get(roomId);
        if (!room) {
            throw new Error(`Room ${roomId} does not exist.`);
        }
        room.forwarders.set(forwarder.streamId, forwarder);
        return forwarder;
    }

    removeForwarder(roomId, streamId) {
        const room = this.rooms.get(roomId);
        if (!room) {
            return null;
        }
        const forwarder = room.forwarders.get(streamId) ?? null;
        if (forwarder) {
            room.forwarders.delete(streamId);
        }
        return forwarder;
    }

    listForwarders(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) {
            return null;
        }
        return Array.from(room.forwarders.values());
    }

    allocatePort() {
        for (let port = this.portRangeStart; port <= this.portRangeEnd; port += 2) {
            if (!this.allocatedPorts.has(port)) {
                this.allocatedPorts.add(port);
                return port;
            }
        }
        throw new Error('No RTP ports are available for new walkie-talkie rooms.');
    }

    releasePort(port) {
        this.allocatedPorts.delete(port);
    }
}

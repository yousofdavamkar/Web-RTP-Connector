import test from 'node:test';
import assert from 'node:assert/strict';

import { RoomStore, createExternalWalkieOwnerId } from '../src/state/roomStore.js';

const createMockJanusClient = () => ({
    async createStreamingMountpoint() {
        return { ok: true };
    },
    async createAudioBridgeRoom() {
        return { ok: true };
    },
    async destroyStreamingMountpoint() {
        return { ok: true };
    },
    async destroyAudioBridgeRoom() {
        return { ok: true };
    },
});

test('RoomStore creates and deletes rooms with Janus metadata', async () => {
    const roomStore = new RoomStore({ janusClient: createMockJanusClient(), portRangeStart: 5004, portRangeEnd: 5008 });
    const room = await roomStore.createRoom({ roomId: 'alpha', name: 'Alpha Room' });

    assert.equal(room.roomId, 'alpha');
    assert.equal(room.janus.streamingPort, 5004);
    assert.equal(room.janus.streamingMountpointId, 4100);
    assert.equal(room.janus.audioBridgeRoomId, 3100);

    const removed = await roomStore.deleteRoom('alpha');
    assert.equal(removed, true);
    assert.equal(roomStore.getRoom('alpha'), null);
});

test('RoomStore manages participant state, PTT locks, and call lifecycle', async () => {
    const roomStore = new RoomStore({ janusClient: createMockJanusClient(), portRangeStart: 5004, portRangeEnd: 5008 });
    await roomStore.createRoom({ roomId: 'alpha', name: 'Alpha Room' });

    const first = roomStore.addParticipant({ roomId: 'alpha', socketId: 's1', displayName: 'Alice', mode: 'walkie-talkie' });
    const second = roomStore.addParticipant({ roomId: 'alpha', socketId: 's2', displayName: 'Bob', mode: 'phone-call' });

    assert.equal(first.displayName, 'Alice');
    assert.equal(second.displayName, 'Bob');
    assert.equal(roomStore.claimPtt('alpha', 's1'), true);
    assert.equal(roomStore.claimPtt('alpha', 's2'), false);
    roomStore.releasePtt('alpha', 's1');
    assert.equal(roomStore.claimPtt('alpha', 's2'), true);

    const target = roomStore.startCall('alpha', 's1');
    assert.equal(target.socketId, 's2');
    const call = roomStore.acceptCall('alpha', 's2');
    assert.equal(call.status, 'in-call');

    roomStore.endCall('alpha');
    const room = roomStore.getRoom('alpha');
    assert.equal(room.call.status, 'idle');

    const external = roomStore.addExternalRtpParticipant('alpha', {
        externalParticipantId: 'ext-1',
        displayName: 'VLC RTP Endpoint',
        codec: 'opus',
        remoteHost: '127.0.0.1',
        remotePort: 7000,
        janusRtp: { host: 'janus', port: 12000, payloadType: 111 },
        createdAt: new Date().toISOString(),
    });
    assert.equal(external.externalParticipantId, 'ext-1');
    assert.equal(roomStore.removeExternalRtpParticipant('alpha', 'ext-1')?.externalParticipantId, 'ext-1');
});

test('RoomStore manages external walkie participants and external PTT owners', async () => {
    const roomStore = new RoomStore({
        janusClient: createMockJanusClient(),
        portRangeStart: 5004,
        portRangeEnd: 5008,
        externalWalkiePortStart: 7004,
        externalWalkiePortEnd: 7008,
    });
    await roomStore.createRoom({ roomId: 'alpha', name: 'Alpha Room' });

    const ingestPort = roomStore.allocateExternalWalkiePort();
    const participant = roomStore.addExternalWalkieParticipant('alpha', {
        externalParticipantId: 'vlc-1',
        displayName: 'VLC Desk Mic',
        inputCodec: 'pcmu',
        payloadType: 0,
        ingestHost: '127.0.0.1',
        ingestPort,
        createdAt: new Date().toISOString(),
    });

    assert.equal(participant.ingestPort, 7004);

    const ownerId = createExternalWalkieOwnerId(participant.externalParticipantId);
    assert.equal(roomStore.claimPtt('alpha', ownerId), true);

    const room = roomStore.serializeRoom(roomStore.getRoom('alpha'));
    assert.equal(room.activePttSpeaker, ownerId);
    assert.deepEqual(room.activePttSource, {
        type: 'external-walkie',
        externalParticipantId: 'vlc-1',
        displayName: 'VLC Desk Mic',
    });
    assert.equal(room.externalWalkieParticipants.length, 1);
    assert.equal(room.externalWalkieParticipants[0].isTransmitting, true);

    assert.equal(roomStore.removeExternalWalkieParticipant('alpha', 'vlc-1')?.externalParticipantId, 'vlc-1');
    assert.equal(roomStore.getRoom('alpha').activePttSpeaker, null);
    assert.equal(roomStore.allocateExternalWalkiePort(), 7004);
});

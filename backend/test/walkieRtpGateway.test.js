import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WalkieRtpGateway } from '../src/services/walkieRtpGateway.js';

const createSpawnStub = () => {
    const calls = [];
    let activeChild = null;

    const spawnProcess = (command, args) => {
        calls.push({ command, args });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {
            queueMicrotask(() => {
                child.emit('close', 0, null);
            });
            return true;
        };
        activeChild = child;
        return child;
    };

    return {
        calls,
        getActiveChild: () => activeChild,
        spawnProcess,
    };
};

test('WalkieRtpGateway builds an SDP-backed ffmpeg pipeline and cleans it up on stop', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'walkie-rtp-gateway-'));
    const { calls, spawnProcess } = createSpawnStub();
    const gateway = new WalkieRtpGateway({
        ffmpegPath: 'ffmpeg',
        inputHost: '0.0.0.0',
        outputHost: 'janus',
        tempDirectory,
        spawnProcess,
    });

    const session = await gateway.startSession({
        roomId: 'alpha',
        participantId: 'vlc-1',
        inputPort: 7004,
        inputCodec: 'pcmu',
        inputPayloadType: 0,
        outputPort: 5004,
    });

    assert.equal(session.inputCodec, 'pcmu');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'ffmpeg');
    assert.ok(calls[0].args.includes('-progress'));
    assert.ok(calls[0].args.includes('pipe:1'));
    assert.ok(calls[0].args.includes('-protocol_whitelist'));
    assert.ok(calls[0].args.includes('file,udp,rtp'));
    assert.ok(calls[0].args.includes('-listen_timeout'));
    assert.ok(calls[0].args.includes('300'));
    assert.ok(calls[0].args.includes('rtp://janus:5004?pkt_size=1200'));

    const inputIndex = calls[0].args.indexOf('-i');
    assert.ok(inputIndex >= 0);

    const sdpPath = calls[0].args[inputIndex + 1];
    const sdp = await fs.readFile(sdpPath, 'utf8');
    assert.match(sdp, /m=audio 7004 RTP\/AVP 0/);
    assert.match(sdp, /a=rtpmap:0 PCMU\/8000/);

    assert.deepEqual(gateway.getSession('vlc-1'), {
        roomId: 'alpha',
        participantId: 'vlc-1',
        inputPort: 7004,
        inputCodec: 'pcmu',
        inputPayloadType: 0,
        outputPort: 5004,
    });

    assert.equal(await gateway.stopSession('vlc-1'), true);
    await assert.rejects(() => fs.readFile(sdpPath, 'utf8'));
    assert.equal(gateway.getSession('vlc-1'), null);
    assert.equal(await gateway.stopSession('vlc-1'), false);
});

test('WalkieRtpGateway force-finalizes a session when ffmpeg does not exit', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'walkie-rtp-gateway-'));
    const killSignals = [];
    const spawnProcess = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = (signal) => {
            killSignals.push(signal);
            return true;
        };
        return child;
    };
    const gateway = new WalkieRtpGateway({
        ffmpegPath: 'ffmpeg',
        outputHost: 'janus',
        tempDirectory,
        spawnProcess,
        stopGraceMs: 1,
        stopKillGraceMs: 1,
    });

    await gateway.startSession({
        roomId: 'alpha',
        participantId: 'stuck-vlc',
        inputPort: 7004,
        outputPort: 5004,
    });

    assert.equal(await gateway.stopSession('stuck-vlc'), true);
    assert.deepEqual(killSignals, ['SIGTERM', 'SIGKILL']);
    assert.equal(gateway.getSession('stuck-vlc'), null);
});

test('WalkieRtpGateway auto-stops a session after RTP media goes idle', async () => {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'walkie-rtp-gateway-'));
    let activeChild = null;
    const killSignals = [];
    const spawnProcess = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = (signal) => {
            killSignals.push(signal);
            queueMicrotask(() => child.emit('close', 0, signal));
            return true;
        };
        activeChild = child;
        return child;
    };
    const gateway = new WalkieRtpGateway({
        ffmpegPath: 'ffmpeg',
        outputHost: 'janus',
        tempDirectory,
        spawnProcess,
        mediaIdleTimeoutMs: 1,
    });

    await gateway.startSession({
        roomId: 'alpha',
        participantId: 'idle-vlc',
        inputPort: 7004,
        outputPort: 5004,
    });

    activeChild.stdout.emit('data', Buffer.from('out_time_ms=1000\nprogress=continue\n'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(killSignals, ['SIGTERM']);
    assert.equal(gateway.getSession('idle-vlc'), null);
});
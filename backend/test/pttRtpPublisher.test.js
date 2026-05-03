import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { PttRtpPublisher } from '../src/services/pttRtpPublisher.js';

const createSpawnStub = () => {
    const calls = [];
    const spawnProcess = (command, args) => {
        calls.push({ command, args });
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
            child.emit('close', 0);
        });
        return child;
    };
    return { spawnProcess, calls };
};

test('PttRtpPublisher runs ffmpeg with RTP output arguments', async () => {
    const { spawnProcess, calls } = createSpawnStub();
    const publisher = new PttRtpPublisher({
        ffmpegPath: 'ffmpeg',
        host: 'janus',
        tempDirectory: path.join(os.tmpdir(), 'rtp-voice-app-tests'),
        spawnProcess,
    });

    await publisher.publishClip({
        roomId: 'alpha',
        port: 5004,
        audioBuffer: Buffer.from([1, 2, 3]),
        mimeType: 'audio/webm;codecs=opus',
        durationMs: 500,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'ffmpeg');
    assert.ok(calls[0].args.includes('rtp://janus:5004?pkt_size=1200'));
    assert.ok(calls[0].args.includes('-ac'));
    assert.ok(calls[0].args.includes('1'));
    assert.ok(calls[0].args.includes('-b:a'));
    assert.ok(calls[0].args.includes('48k'));
    assert.ok(calls[0].args.includes('-payload_type'));
    assert.ok(calls[0].args.includes('111'));
});
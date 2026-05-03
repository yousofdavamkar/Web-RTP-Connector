import { useEffect, useRef, useState } from 'react';

import { SOCKET_EVENTS } from '../constants.js';
import { requestVoiceAudioStream } from '../media.js';

const preferredMimeTypes = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
];

const getRecorderMimeType = () => preferredMimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? '';
const getUserMediaOrThrow = () => {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access is blocked on plain HTTP. Use HTTPS or localhost, or launch Chrome/Edge with the HTTP mic override for this URL.');
    }

    return navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
};

export const usePushToTalk = ({ socket, roomId, activeSpeakerSocketId }) => {
    const [isRecording, setIsRecording] = useState(false);
    const [publishState, setPublishState] = useState('idle');
    const [error, setError] = useState('');
    const [liveStream, setLiveStream] = useState(null);

    const recorderRef = useRef(null);
    const chunksRef = useRef([]);
    const startedAtRef = useRef(0);
    const streamRef = useRef(null);
    const pressActiveRef = useRef(false);
    const pendingStopRef = useRef(false);
    const startRequestIdRef = useRef(0);

    const resetCaptureRefs = () => {
        recorderRef.current = null;
        chunksRef.current = [];
        startedAtRef.current = 0;
        pressActiveRef.current = false;
        pendingStopRef.current = false;
    };

    const releaseStream = () => {
        if (!streamRef.current) {
            return;
        }
        for (const track of streamRef.current.getTracks()) {
            track.stop();
        }
        streamRef.current = null;
        setLiveStream(null);
    };

    const stopTalking = async () => {
        pressActiveRef.current = false;
        if (!recorderRef.current) {
            pendingStopRef.current = true;
            return;
        }
        if (recorderRef.current.state === 'inactive') {
            return;
        }
        if (typeof recorderRef.current.requestData === 'function') {
            recorderRef.current.requestData();
        }
        recorderRef.current.stop();
    };

    const startTalking = async () => {
        if (!socket || !roomId || isRecording || pressActiveRef.current) {
            return;
        }
        if (activeSpeakerSocketId && activeSpeakerSocketId !== socket.id) {
            setError('Another participant currently holds the push-to-talk lock.');
            return;
        }

        setError('');
        setPublishState('capturing');
        pressActiveRef.current = true;
        pendingStopRef.current = false;
        startRequestIdRef.current += 1;
        const requestId = startRequestIdRef.current;

        try {
            const getUserMedia = getUserMediaOrThrow();
            const stream = await requestVoiceAudioStream(getUserMedia);

            if (startRequestIdRef.current !== requestId || !pressActiveRef.current || pendingStopRef.current) {
                for (const track of stream.getTracks()) {
                    track.stop();
                }
                setPublishState('idle');
                resetCaptureRefs();
                return;
            }

            streamRef.current = stream;
            setLiveStream(stream);
            chunksRef.current = [];
            startedAtRef.current = performance.now();

            const mimeType = getRecorderMimeType();
            const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
            recorderRef.current = recorder;

            recorder.addEventListener('dataavailable', (event) => {
                if (event.data.size > 0) {
                    chunksRef.current.push(event.data);
                }
            });

            recorder.addEventListener('stop', async () => {
                try {
                    setPublishState('publishing');
                    const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
                    if (blob.size === 0) {
                        throw new Error('No audio was captured. Check microphone permission and input device, then hold to talk again.');
                    }
                    const durationMs = Math.max(0, Math.round(performance.now() - startedAtRef.current));
                    const payload = new Uint8Array(await blob.arrayBuffer());
                    socket.emit(SOCKET_EVENTS.PTT_STOP, {
                        roomId,
                        mimeType: blob.type,
                        durationMs,
                        audioBuffer: payload,
                    });
                } catch (caughtError) {
                    setError(caughtError.message || 'Failed to publish the push-to-talk clip.');
                    setPublishState('idle');
                } finally {
                    setIsRecording(false);
                    resetCaptureRefs();
                    releaseStream();
                }
            });

            recorder.addEventListener('error', (event) => {
                setError(event.error?.message || 'Microphone recording failed before the clip could be sent.');
                setPublishState('idle');
                setIsRecording(false);
                resetCaptureRefs();
                releaseStream();
            });

            socket.emit(SOCKET_EVENTS.PTT_START, { roomId });
            recorder.start();
            setIsRecording(true);

            if (!pressActiveRef.current || pendingStopRef.current) {
                recorder.stop();
            }
        } catch (caughtError) {
            setError(caughtError.message || 'Failed to access the microphone.');
            setPublishState('idle');
            setIsRecording(false);
            resetCaptureRefs();
            releaseStream();
        }
    };

    useEffect(() => {
        if (!socket || !roomId) {
            return undefined;
        }

        const handleBusy = (payload) => {
            if (payload.roomId === roomId) {
                setError('Push-to-talk is currently busy.');
                setPublishState('idle');
            }
        };
        const handlePlaybackStarted = (payload) => {
            if (payload.roomId === roomId) {
                setPublishState('playing');
            }
        };
        const handlePlaybackEnded = (payload) => {
            if (payload.roomId === roomId) {
                setPublishState('idle');
            }
        };

        socket.on(SOCKET_EVENTS.PTT_BUSY, handleBusy);
        socket.on(SOCKET_EVENTS.PTT_PLAYBACK_STARTED, handlePlaybackStarted);
        socket.on(SOCKET_EVENTS.PTT_PLAYBACK_ENDED, handlePlaybackEnded);

        return () => {
            socket.off(SOCKET_EVENTS.PTT_BUSY, handleBusy);
            socket.off(SOCKET_EVENTS.PTT_PLAYBACK_STARTED, handlePlaybackStarted);
            socket.off(SOCKET_EVENTS.PTT_PLAYBACK_ENDED, handlePlaybackEnded);
            releaseStream();
        };
    }, [roomId, socket]);

    return {
        error,
        isRecording,
        liveStream,
        publishState,
        startTalking,
        stopTalking,
    };
};

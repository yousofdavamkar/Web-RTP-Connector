import { useEffect, useRef, useState } from 'react';

import { ROOM_MODES, SOCKET_EVENTS } from '../constants.js';

const rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

const getUserMediaOrThrow = () => {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone access is blocked on plain HTTP. Open the app over HTTPS or localhost. The custom Chrome/Edge HTTP override is only a fallback.');
    }

    return navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
};

const stopStreamTracks = (stream) => {
    if (!stream) {
        return;
    }
    for (const track of stream.getTracks()) {
        track.stop();
    }
};

const bindPeerConnectionState = (peerConnection, setConnectionState, setRemoteStream) => {
    if (!peerConnection?.addEventListener) {
        return;
    }

    const updateFromPeerConnection = () => {
        const connectionState = peerConnection.connectionState;
        const iceConnectionState = peerConnection.iceConnectionState;

        if (connectionState === 'failed' || iceConnectionState === 'failed') {
            setConnectionState('error');
            return;
        }
        if (connectionState === 'connected' || iceConnectionState === 'connected' || iceConnectionState === 'completed') {
            setConnectionState('connected');
            return;
        }
        if (connectionState === 'connecting' || iceConnectionState === 'checking') {
            setConnectionState('connecting');
            return;
        }
        if (connectionState === 'closed' || iceConnectionState === 'closed') {
            setConnectionState('idle');
            setRemoteStream(null);
        }
    };

    peerConnection.addEventListener('connectionstatechange', updateFromPeerConnection);
    peerConnection.addEventListener('iceconnectionstatechange', updateFromPeerConnection);
};

const bindRemoteTrack = (peerConnection, setConnectionState, setRemoteStream) => {
    const fallbackRemoteStream = new MediaStream();

    peerConnection.addEventListener('track', (event) => {
        const [streamFromEvent] = event.streams;
        if (streamFromEvent) {
            setRemoteStream(streamFromEvent);
            setConnectionState('connected');
            return;
        }

        fallbackRemoteStream.addTrack(event.track);
        setRemoteStream(fallbackRemoteStream);
        setConnectionState('connected');
    });
};

export const useWebRTC = ({ socket, roomId, mode }) => {
    const [remoteStream, setRemoteStream] = useState(null);
    const [localStream, setLocalStream] = useState(null);
    const [connectionState, setConnectionState] = useState('idle');

    const walkieConnectionRef = useRef(null);
    const pendingWalkieCandidatesRef = useRef([]);
    const phoneConnectionRef = useRef(null);
    const pendingPhoneCandidatesRef = useRef([]);
    const localStreamRef = useRef(null);

    const destroyPeer = (stopLocalTracks = false) => {
        if (walkieConnectionRef.current) {
            walkieConnectionRef.current.ontrack = null;
            walkieConnectionRef.current.onicecandidate = null;
            walkieConnectionRef.current.close();
            walkieConnectionRef.current = null;
        }
        pendingWalkieCandidatesRef.current = [];
        if (phoneConnectionRef.current) {
            phoneConnectionRef.current.ontrack = null;
            phoneConnectionRef.current.onicecandidate = null;
            phoneConnectionRef.current.close();
            phoneConnectionRef.current = null;
        }
        pendingPhoneCandidatesRef.current = [];
        setRemoteStream(null);
        setConnectionState('idle');
        if (stopLocalTracks && localStreamRef.current) {
            stopStreamTracks(localStreamRef.current);
            localStreamRef.current = null;
            setLocalStream(null);
        }
    };

    const requestLocalAudioStream = async () => {
        if (localStreamRef.current) {
            return localStreamRef.current;
        }

        const getUserMedia = getUserMediaOrThrow();
        const stream = await getUserMedia({
            audio: {
                channelCount: 2,
                sampleRate: 48000,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
            video: false,
        });

        localStreamRef.current = stream;
        setLocalStream(stream);
        return stream;
    };

    const startPhoneSession = async () => {
        if (phoneConnectionRef.current && phoneConnectionRef.current.signalingState !== 'closed') {
            return { peerConnection: phoneConnectionRef.current, warning: '' };
        }

        let stream = null;
        let warning = '';

        try {
            stream = await requestLocalAudioStream();
        } catch (error) {
            warning = `${error.message || 'Microphone access failed.'} Joined the call in listen-only mode.`;
        }

        const peerConnection = new RTCPeerConnection(rtcConfig);

        phoneConnectionRef.current = peerConnection;
        setConnectionState('connecting');
        bindPeerConnectionState(peerConnection, setConnectionState, setRemoteStream);
        bindRemoteTrack(peerConnection, setConnectionState, setRemoteStream);

        peerConnection.addEventListener('icecandidate', (event) => {
            socket.emit(SOCKET_EVENTS.ICE_CANDIDATE, {
                roomId,
                mode: ROOM_MODES.PHONE_CALL,
                candidate: event.candidate ? event.candidate.toJSON() : { completed: true },
            });
        });

        if (stream) {
            for (const track of stream.getTracks()) {
                peerConnection.addTrack(track, stream);
            }
        } else if (typeof peerConnection.addTransceiver === 'function') {
            peerConnection.addTransceiver('audio', { direction: 'recvonly' });
        } else {
            const unsupportedError = new Error('This browser cannot join the call without microphone access.');
            if (phoneConnectionRef.current === peerConnection) {
                phoneConnectionRef.current = null;
            }
            peerConnection.close();
            throw unsupportedError;
        }

        try {
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: false,
            });
            await peerConnection.setLocalDescription(offer);
            socket.emit(SOCKET_EVENTS.OFFER, {
                roomId,
                mode: ROOM_MODES.PHONE_CALL,
                jsep: {
                    type: peerConnection.localDescription.type,
                    sdp: peerConnection.localDescription.sdp,
                },
            });
            return { peerConnection, warning };
        } catch (error) {
            if (phoneConnectionRef.current === peerConnection) {
                phoneConnectionRef.current = null;
            }
            peerConnection.close();
            throw error;
        }
    };

    useEffect(() => {
        if (!socket || !roomId) {
            return undefined;
        }

        const handleOffer = async (payload) => {
            if (payload.roomId !== roomId || payload.mode !== ROOM_MODES.WALKIE_TALKIE) {
                return;
            }

            if (walkieConnectionRef.current) {
                walkieConnectionRef.current.close();
                walkieConnectionRef.current = null;
            }
            pendingWalkieCandidatesRef.current = [];

            const peerConnection = new RTCPeerConnection(rtcConfig);
            walkieConnectionRef.current = peerConnection;
            setConnectionState('connecting');
            bindPeerConnectionState(peerConnection, setConnectionState, setRemoteStream);
            bindRemoteTrack(peerConnection, setConnectionState, setRemoteStream);

            peerConnection.addEventListener('icecandidate', (event) => {
                socket.emit(SOCKET_EVENTS.ICE_CANDIDATE, {
                    roomId,
                    mode: ROOM_MODES.WALKIE_TALKIE,
                    candidate: event.candidate ? event.candidate.toJSON() : { completed: true },
                });
            });

            try {
                await peerConnection.setRemoteDescription(payload.jsep);
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);

                for (const candidate of pendingWalkieCandidatesRef.current) {
                    await peerConnection.addIceCandidate(candidate?.completed ? null : candidate);
                }
                pendingWalkieCandidatesRef.current = [];

                socket.emit(SOCKET_EVENTS.ANSWER, {
                    roomId,
                    mode: ROOM_MODES.WALKIE_TALKIE,
                    jsep: {
                        type: peerConnection.localDescription.type,
                        sdp: peerConnection.localDescription.sdp,
                    },
                });
            } catch {
                setConnectionState('error');
            }
        };

        const handleAnswer = async (payload) => {
            if (payload.roomId !== roomId || payload.mode !== ROOM_MODES.PHONE_CALL || !phoneConnectionRef.current || phoneConnectionRef.current.signalingState === 'closed') {
                return;
            }

            try {
                await phoneConnectionRef.current.setRemoteDescription(payload.jsep);
                for (const candidate of pendingPhoneCandidatesRef.current) {
                    await phoneConnectionRef.current.addIceCandidate(candidate?.completed ? null : candidate);
                }
                pendingPhoneCandidatesRef.current = [];
            } catch {
                setConnectionState('error');
            }
        };

        const handleIceCandidate = (payload) => {
            if (payload.roomId !== roomId) {
                return;
            }

            if (payload.mode === ROOM_MODES.PHONE_CALL) {
                if (!phoneConnectionRef.current || phoneConnectionRef.current.signalingState === 'closed' || !phoneConnectionRef.current.remoteDescription) {
                    pendingPhoneCandidatesRef.current.push(payload.candidate ?? { completed: true });
                    return;
                }

                phoneConnectionRef.current.addIceCandidate(payload.candidate?.completed ? null : payload.candidate).catch(() => {
                    setConnectionState('error');
                });
                return;
            }

            if (
                !walkieConnectionRef.current
                || walkieConnectionRef.current.signalingState === 'closed'
                || !walkieConnectionRef.current.remoteDescription
            ) {
                pendingWalkieCandidatesRef.current.push(payload.candidate ?? { completed: true });
                return;
            }

            walkieConnectionRef.current.addIceCandidate(payload.candidate?.completed ? null : payload.candidate).catch(() => {
                setConnectionState('error');
            });
        };

        const handleCallEnded = (payload) => {
            if (payload.roomId === roomId && mode === ROOM_MODES.PHONE_CALL) {
                destroyPeer(true);
            }
        };

        socket.on(SOCKET_EVENTS.OFFER, handleOffer);
        socket.on(SOCKET_EVENTS.ANSWER, handleAnswer);
        socket.on(SOCKET_EVENTS.ICE_CANDIDATE, handleIceCandidate);
        socket.on(SOCKET_EVENTS.CALL_ENDED, handleCallEnded);

        return () => {
            socket.off(SOCKET_EVENTS.OFFER, handleOffer);
            socket.off(SOCKET_EVENTS.ANSWER, handleAnswer);
            socket.off(SOCKET_EVENTS.ICE_CANDIDATE, handleIceCandidate);
            socket.off(SOCKET_EVENTS.CALL_ENDED, handleCallEnded);
            destroyPeer(mode === ROOM_MODES.PHONE_CALL);
        };
    }, [mode, roomId, socket]);

    return {
        connectionState,
        destroyPeer,
        localStream,
        remoteStream,
        requestLocalAudioStream,
        startPhoneSession,
    };
};

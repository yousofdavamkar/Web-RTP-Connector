import { useEffect, useRef, useState } from 'react';

import { ROOM_MODES, SOCKET_EVENTS } from '../constants.js';
import { requestVoiceAudioStream } from '../media.js';

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

const setDebugWalkiePeer = (peerConnection) => {
    if (typeof window === 'undefined') {
        return;
    }
    window.__walkiePc = peerConnection ?? null;
};

export const useWebRTC = ({ socket, roomId, mode }) => {
    const [remoteStream, setRemoteStream] = useState(null);
    const [localStream, setLocalStream] = useState(null);
    const [connectionState, setConnectionState] = useState('idle');

    const walkieConnectionRef = useRef(null);
    const pendingWalkieCandidatesRef = useRef([]);
    const walkieNegotiationInProgressRef = useRef(false);
    const queuedWalkieOfferRef = useRef(null);
    const phoneConnectionRef = useRef(null);
    const pendingPhoneCandidatesRef = useRef([]);
    const localStreamRef = useRef(null);

    const flushPendingWalkieCandidates = async (peerConnection) => {
        if (!peerConnection || !peerConnection.remoteDescription) {
            return;
        }

        const candidates = pendingWalkieCandidatesRef.current;
        pendingWalkieCandidatesRef.current = [];
        for (const candidate of candidates) {
            await peerConnection.addIceCandidate(candidate?.completed ? null : candidate).catch(() => {
                // Ignore candidate timing races during renegotiation.
            });
        }
    };

    const destroyPeer = (stopLocalTracks = false) => {
        if (walkieConnectionRef.current) {
            walkieConnectionRef.current.ontrack = null;
            walkieConnectionRef.current.onicecandidate = null;
            walkieConnectionRef.current.close();
            walkieConnectionRef.current = null;
            setDebugWalkiePeer(null);
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
        const stream = await requestVoiceAudioStream(getUserMedia);

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

            queuedWalkieOfferRef.current = payload;
            if (walkieNegotiationInProgressRef.current) {
                console.debug('[walkie-webrtc] Offer queued while renegotiation is in progress.', {
                    roomId,
                    signalingState: walkieConnectionRef.current?.signalingState,
                    connectionState: walkieConnectionRef.current?.connectionState,
                });
                return;
            }

            walkieNegotiationInProgressRef.current = true;
            try {
                while (queuedWalkieOfferRef.current) {
                    const activePayload = queuedWalkieOfferRef.current;
                    queuedWalkieOfferRef.current = null;

                    console.debug('[walkie-webrtc] Offer received.', {
                        roomId,
                        signalingState: walkieConnectionRef.current?.signalingState,
                        connectionState: walkieConnectionRef.current?.connectionState,
                    });

                    // If an active peer connection exists, renegotiate on it rather than tearing it down.
                    // Janus sends a new offer when a new RTP stream starts on the mountpoint - destroying
                    // the existing connection at that moment causes the exact audio gap we're trying to fix.
                    const existing = walkieConnectionRef.current;
                    const canRenegotiate = existing
                        && existing.connectionState !== 'closed'
                        && existing.connectionState !== 'failed'
                        && existing.signalingState === 'stable';

                    if (canRenegotiate) {
                        try {
                            console.debug('[walkie-webrtc] Renegotiation started.', { roomId });
                            await existing.setRemoteDescription(activePayload.jsep);
                            await flushPendingWalkieCandidates(existing);
                            const answer = await existing.createAnswer();
                            await existing.setLocalDescription(answer);
                            socket.emit(SOCKET_EVENTS.ANSWER, {
                                roomId,
                                mode: ROOM_MODES.WALKIE_TALKIE,
                                jsep: {
                                    type: existing.localDescription.type,
                                    sdp: existing.localDescription.sdp,
                                },
                            });
                            console.debug('[walkie-webrtc] Renegotiation completed.', { roomId });
                            continue;
                        } catch (error) {
                            // Renegotiation failed - fall through to create a fresh connection below.
                            console.warn('[walkie-webrtc] Renegotiation failed, recreating peer.', {
                                roomId,
                                message: error?.message,
                            });
                            existing.close();
                            walkieConnectionRef.current = null;
                            setDebugWalkiePeer(null);
                            pendingWalkieCandidatesRef.current = [];
                        }
                    } else if (existing && existing.connectionState !== 'closed' && existing.connectionState !== 'failed') {
                        console.debug('[walkie-webrtc] Offer arrived while signaling not stable; waiting for next offer.', {
                            roomId,
                            signalingState: existing.signalingState,
                            connectionState: existing.connectionState,
                        });
                        continue;
                    } else {
                        if (existing) {
                            existing.close();
                            walkieConnectionRef.current = null;
                            setDebugWalkiePeer(null);
                        }
                        pendingWalkieCandidatesRef.current = [];
                    }

                    console.debug('[walkie-webrtc] Creating fresh walkie peer connection.', { roomId });
                    const peerConnection = new RTCPeerConnection(rtcConfig);
                    walkieConnectionRef.current = peerConnection;
                    setDebugWalkiePeer(peerConnection);
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
                        await peerConnection.setRemoteDescription(activePayload.jsep);
                        await flushPendingWalkieCandidates(peerConnection);
                        const answer = await peerConnection.createAnswer();
                        await peerConnection.setLocalDescription(answer);

                        socket.emit(SOCKET_EVENTS.ANSWER, {
                            roomId,
                            mode: ROOM_MODES.WALKIE_TALKIE,
                            jsep: {
                                type: peerConnection.localDescription.type,
                                sdp: peerConnection.localDescription.sdp,
                            },
                        });
                    } catch (error) {
                        if (walkieConnectionRef.current === peerConnection) {
                            walkieConnectionRef.current = null;
                            setDebugWalkiePeer(null);
                        }
                        peerConnection.close();
                        pendingWalkieCandidatesRef.current = [];
                        console.error('[walkie-webrtc] Failed to establish walkie peer from offer.', {
                            roomId,
                            message: error?.message,
                        });
                        setConnectionState('error');
                    }
                }
            } finally {
                walkieNegotiationInProgressRef.current = false;
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

import { useEffect, useRef, useState } from 'react';

import { ROOM_MODES, SOCKET_EVENTS } from '../constants.js';
import { useWebRTC } from './useWebRTC.js';

export const usePhoneCall = ({ socket, roomId }) => {
    const [callState, setCallState] = useState('idle');
    const [incomingCallerId, setIncomingCallerId] = useState(null);
    const [error, setError] = useState('');
    const [isMuted, setIsMuted] = useState(false);

    const { connectionState, destroyPeer, localStream, remoteStream, startPhoneSession } = useWebRTC({
        socket,
        roomId,
        mode: ROOM_MODES.PHONE_CALL,
    });

    const destroyPeerRef = useRef(destroyPeer);
    const startPhoneSessionRef = useRef(startPhoneSession);

    useEffect(() => {
        destroyPeerRef.current = destroyPeer;
        startPhoneSessionRef.current = startPhoneSession;
    }, [destroyPeer, startPhoneSession]);

    useEffect(() => {
        if (!socket || !roomId) {
            return undefined;
        }

        const handleIncomingCall = ({ roomId: incomingRoomId, fromSocketId }) => {
            if (incomingRoomId !== roomId) {
                return;
            }
            setIncomingCallerId(fromSocketId);
            setCallState('ringing');
        };

        const handleCallState = ({ roomId: stateRoomId, status }) => {
            if (stateRoomId === roomId) {
                setCallState(status);
            }
        };

        const handleCallAccepted = async ({ roomId: acceptedRoomId }) => {
            if (acceptedRoomId !== roomId) {
                return;
            }
            setError('');
            setIncomingCallerId(null);
            setCallState('connecting');
            try {
                const result = await startPhoneSessionRef.current();
                if (result?.warning) {
                    setError(result.warning);
                }
            } catch (caughtError) {
                setError(caughtError.message || 'Failed to initialize the Janus phone call session.');
                setCallState('idle');
            }
        };

        const handleCallRejected = ({ roomId: rejectedRoomId }) => {
            if (rejectedRoomId !== roomId) {
                return;
            }
            destroyPeerRef.current(true);
            setIncomingCallerId(null);
            setCallState('idle');
        };

        const handleCallEnded = ({ roomId: endedRoomId }) => {
            if (endedRoomId !== roomId) {
                return;
            }
            destroyPeerRef.current(true);
            setIncomingCallerId(null);
            setCallState('idle');
            setIsMuted(false);
        };

        socket.on(SOCKET_EVENTS.INCOMING_CALL, handleIncomingCall);
        socket.on('call-state', handleCallState);
        socket.on(SOCKET_EVENTS.CALL_ACCEPTED, handleCallAccepted);
        socket.on(SOCKET_EVENTS.CALL_REJECTED, handleCallRejected);
        socket.on(SOCKET_EVENTS.CALL_ENDED, handleCallEnded);

        return () => {
            socket.off(SOCKET_EVENTS.INCOMING_CALL, handleIncomingCall);
            socket.off('call-state', handleCallState);
            socket.off(SOCKET_EVENTS.CALL_ACCEPTED, handleCallAccepted);
            socket.off(SOCKET_EVENTS.CALL_REJECTED, handleCallRejected);
            socket.off(SOCKET_EVENTS.CALL_ENDED, handleCallEnded);
            destroyPeerRef.current(true);
        };
    }, [roomId, socket]);

    useEffect(() => {
        if (connectionState === 'connected') {
            setCallState('in-call');
        }
    }, [connectionState]);

    const requestCall = () => {
        setError('');
        setIncomingCallerId(null);
        setCallState('calling');
        socket.emit(SOCKET_EVENTS.CALL_REQUEST, { roomId });
    };

    const acceptCall = () => {
        setError('');
        socket.emit(SOCKET_EVENTS.CALL_ACCEPT, { roomId });
    };

    const rejectCall = () => {
        socket.emit(SOCKET_EVENTS.CALL_REJECT, { roomId });
        setIncomingCallerId(null);
        setCallState('idle');
    };

    const endCall = () => {
        socket.emit(SOCKET_EVENTS.CALL_END, { roomId });
        destroyPeer(true);
        setIncomingCallerId(null);
        setCallState('idle');
        setIsMuted(false);
    };

    const toggleMute = () => {
        const nextMuted = !isMuted;
        if (localStream) {
            for (const track of localStream.getAudioTracks()) {
                track.enabled = !nextMuted;
            }
        }
        socket.emit(SOCKET_EVENTS.CALL_MUTE, { roomId, muted: nextMuted });
        setIsMuted(nextMuted);
    };

    return {
        callState,
        connectionState,
        endCall,
        error,
        incomingCallerId,
        isMuted,
        localStream,
        remoteStream,
        requestCall,
        acceptCall,
        rejectCall,
        toggleMute,
    };
};

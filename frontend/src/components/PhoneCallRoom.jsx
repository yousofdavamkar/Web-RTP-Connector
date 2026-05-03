import { useEffect, useRef } from 'react';

import { ROOM_MODES, SOCKET_EVENTS } from '../constants.js';
import { usePhoneCall } from '../hooks/usePhoneCall.js';
import { AudioVisualizer } from './AudioVisualizer.jsx';

export const PhoneCallRoom = ({ room, socket, onLeave }) => {
    const remoteAudioRef = useRef(null);
    const playbackContextRef = useRef(null);
    const playbackSourceRef = useRef(null);
    const { acceptCall, callState, connectionState, endCall, error, incomingCallerId, isMuted, localStream, remoteStream, rejectCall, requestCall, toggleMute } = usePhoneCall({
        socket,
        roomId: room.roomId,
    });

    const unlockRemotePlayback = async () => {
        const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextConstructor) {
            if (remoteAudioRef.current) {
                remoteAudioRef.current.muted = false;
                await remoteAudioRef.current.play().catch(() => { });
            }
            return;
        }

        if (!playbackContextRef.current) {
            playbackContextRef.current = new AudioContextConstructor();
        }
        if (playbackContextRef.current.state === 'suspended') {
            await playbackContextRef.current.resume().catch(() => { });
        }
    };

    useEffect(() => {
        socket.emit(SOCKET_EVENTS.JOIN_ROOM, {
            roomId: room.roomId,
            displayName: room.displayName,
            mode: ROOM_MODES.PHONE_CALL,
        });

        return () => {
            socket.emit(SOCKET_EVENTS.LEAVE_ROOM, { roomId: room.roomId });
        };
    }, [room.displayName, room.roomId, socket]);

    useEffect(() => {
        if (playbackSourceRef.current) {
            playbackSourceRef.current.disconnect();
            playbackSourceRef.current = null;
        }
        if (remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = remoteStream;
            remoteAudioRef.current.volume = 1;
            const playbackContext = playbackContextRef.current;
            if (remoteStream && playbackContext && playbackContext.state !== 'closed') {
                if (playbackContext.state === 'suspended') {
                    playbackContext.resume().catch(() => { });
                }
                try {
                    playbackSourceRef.current = playbackContext.createMediaStreamSource(remoteStream);
                    playbackSourceRef.current.connect(playbackContext.destination);
                    remoteAudioRef.current.muted = true;
                    return undefined;
                } catch {
                    remoteAudioRef.current.muted = false;
                }
            }
            remoteAudioRef.current.muted = false;
            remoteAudioRef.current.play().catch(() => { });
        }
        return undefined;
    }, [remoteStream]);

    useEffect(() => () => {
        if (playbackSourceRef.current) {
            playbackSourceRef.current.disconnect();
            playbackSourceRef.current = null;
        }
        if (playbackContextRef.current && playbackContextRef.current.state !== 'closed') {
            playbackContextRef.current.close().catch(() => { });
            playbackContextRef.current = null;
        }
    }, []);

    const handleRequestCall = async () => {
        await unlockRemotePlayback();
        requestCall();
    };

    const handleAcceptCall = async () => {
        await unlockRemotePlayback();
        acceptCall();
    };

    const incomingCallerName = room.participants.find((participant) => participant.socketId === incomingCallerId)?.displayName ?? incomingCallerId;

    return (
        <section className="mode-shell">
            <div className="mode-header">
                <div>
                    <p className="eyebrow">Phone Call</p>
                    <h2>{room.name}</h2>
                    <p>AudioBridge room {room.janus.audioBridgeRoomId}</p>
                </div>
                <button className="ghost-button" onClick={onLeave} type="button">
                    Leave room
                </button>
            </div>

            <div className="mode-grid">
                <div className="panel action-panel">
                    <div className="call-state-badge">{callState}</div>
                    <div className="call-actions">
                        <button className="primary-button" onClick={handleRequestCall} type="button">
                            Start Call
                        </button>
                        <button className="secondary-button" disabled={!localStream || (callState !== 'in-call' && callState !== 'connecting')} onClick={toggleMute} type="button">
                            {isMuted ? 'Unmute' : 'Mute'}
                        </button>
                        <button className="danger-button" disabled={callState === 'idle'} onClick={endCall} type="button">
                            Hang Up
                        </button>
                    </div>

                    {callState === 'ringing' && incomingCallerId ? (
                        <div className="incoming-call-card">
                            <p>Incoming call from {incomingCallerName}.</p>
                            <div className="call-actions">
                                <button className="primary-button" onClick={handleAcceptCall} type="button">
                                    Accept
                                </button>
                                <button className="ghost-button" onClick={rejectCall} type="button">
                                    Reject
                                </button>
                            </div>
                        </div>
                    ) : null}

                    <AudioVisualizer active={callState === 'in-call' || callState === 'connecting'} stream={localStream} />

                    <div className="status-grid">
                        <div>
                            <label>WebRTC</label>
                            <strong>{connectionState}</strong>
                        </div>
                        <div>
                            <label>Muted</label>
                            <strong>{isMuted ? 'yes' : 'no'}</strong>
                        </div>
                        <div>
                            <label>Participants</label>
                            <strong>{room.participants.length}</strong>
                        </div>
                    </div>
                    {error ? <p className="inline-error">{error}</p> : null}
                    <audio autoPlay playsInline ref={remoteAudioRef} />
                </div>

                <div className="panel participants-panel">
                    <h3>Call participants</h3>
                    <ul className="participant-list">
                        {room.participants.map((participant) => (
                            <li key={participant.socketId}>
                                <strong>{participant.displayName}</strong>
                                <span>{participant.mode}</span>
                                <span>{participant.muted ? 'Muted' : 'Live'}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </section>
    );
};

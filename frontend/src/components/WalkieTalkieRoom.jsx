import { useEffect, useRef } from 'react';

import { ROOM_MODES, SOCKET_EVENTS } from '../constants.js';
import { usePushToTalk } from '../hooks/usePushToTalk.js';
import { useWebRTC } from '../hooks/useWebRTC.js';
import { AudioVisualizer } from './AudioVisualizer.jsx';

export const WalkieTalkieRoom = ({ room, socket, onLeave }) => {
    const audioRef = useRef(null);
    const { connectionState, remoteStream } = useWebRTC({ socket, roomId: room.roomId, mode: ROOM_MODES.WALKIE_TALKIE });
    const { error, isRecording, liveStream, publishState, startTalking, stopTalking } = usePushToTalk({
        socket,
        roomId: room.roomId,
        activeSpeakerSocketId: room.activePttSpeaker,
    });
    const isOwnPlayback = publishState === 'playing' && room.activePttSpeaker === socket.id;

    const handlePointerDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }

        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        startTalking();
    };

    const handlePointerUp = (event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture?.(event.pointerId);
        }

        stopTalking();
    };

    useEffect(() => {
        socket.emit(SOCKET_EVENTS.JOIN_ROOM, {
            roomId: room.roomId,
            displayName: room.displayName,
            mode: ROOM_MODES.WALKIE_TALKIE,
        });

        return () => {
            socket.emit(SOCKET_EVENTS.LEAVE_ROOM, { roomId: room.roomId });
        };
    }, [room.displayName, room.roomId, socket]);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.srcObject = remoteStream;
            audioRef.current.muted = isOwnPlayback;
            audioRef.current.volume = 1;
            audioRef.current.play().catch(() => { });
        }
    }, [isOwnPlayback, remoteStream]);

    const heldByOtherParticipant = room.activePttSpeaker && room.activePttSpeaker !== socket.id;

    return (
        <section className="mode-shell">
            <div className="mode-header">
                <div>
                    <p className="eyebrow">Walkie-Talkie</p>
                    <h2>{room.name}</h2>
                    <p>Mountpoint {room.janus.streamingMountpointId} on UDP {room.janus.streamingPort}</p>
                </div>
                <button className="ghost-button" onClick={onLeave} type="button">
                    Leave room
                </button>
            </div>

            <div className="mode-grid">
                <div className="panel action-panel">
                    <button
                        className={`ptt-button ${isRecording ? 'recording' : ''}`}
                        disabled={heldByOtherParticipant}
                        onContextMenu={(event) => event.preventDefault()}
                        onLostPointerCapture={stopTalking}
                        onPointerCancel={handlePointerUp}
                        onPointerDown={handlePointerDown}
                        onPointerUp={handlePointerUp}
                        type="button"
                    >
                        <span>Hold to Talk</span>
                        <strong>{isRecording ? 'Recording...' : heldByOtherParticipant ? 'Channel busy' : 'Press + hold'}</strong>
                    </button>

                    <AudioVisualizer active={isRecording} stream={liveStream} />

                    <div className="status-grid">
                        <div>
                            <label>Subscription</label>
                            <strong>{connectionState}</strong>
                        </div>
                        <div>
                            <label>Publisher</label>
                            <strong>{publishState}</strong>
                        </div>
                        <div>
                            <label>Participants</label>
                            <strong>{room.participants.length}</strong>
                        </div>
                    </div>
                    {error ? <p className="inline-error">{error}</p> : null}
                    <audio autoPlay playsInline ref={audioRef} />
                </div>

                <div className="panel participants-panel">
                    <h3>Room traffic</h3>
                    <ul className="participant-list">
                        {room.participants.map((participant) => (
                            <li key={participant.socketId}>
                                <strong>{participant.displayName}</strong>
                                <span>{participant.mode}</span>
                                <span>{room.activePttSpeaker === participant.socketId ? 'Speaking now' : 'Listening'}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </section>
    );
};

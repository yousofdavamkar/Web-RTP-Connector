import { useEffect, useRef, useState } from 'react';

import { ROOM_MODES, SOCKET_EVENTS } from '../constants.js';
import { resumePrimedAudio } from '../audioPlayback.js';
import { usePushToTalk } from '../hooks/usePushToTalk.js';
import { useWebRTC } from '../hooks/useWebRTC.js';
import { AudioVisualizer } from './AudioVisualizer.jsx';

export const WalkieTalkieRoom = ({ room, socket, onLeave }) => {
    const audioRef = useRef(null);
    const audioUnlockedRef = useRef(true);
    const boostedPlaybackRef = useRef({
        audioContext: null,
        gainNode: null,
        sourceNode: null,
        stream: null,
    });
    const [playbackBlocked, setPlaybackBlocked] = useState(false);
    const externalWalkieParticipants = room.externalWalkieParticipants ?? [];
    const trafficParticipants = [
        ...room.participants.map((participant) => ({
            key: participant.socketId,
            displayName: participant.displayName,
            label: participant.mode,
            isSpeaking: room.activePttSpeaker === participant.socketId,
        })),
        ...externalWalkieParticipants.map((participant) => ({
            key: `external-${participant.externalParticipantId}`,
            displayName: participant.displayName,
            label: `rtp ${participant.inputCodec}`,
            isSpeaking: participant.isTransmitting,
        })),
    ];
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

    const unlockRemotePlayback = async () => {
        if (!audioRef.current) {
            return;
        }

        audioUnlockedRef.current = true;
        audioRef.current.muted = false;
        audioRef.current.volume = 1;
        setPlaybackBlocked(false);

        try {
            await audioRef.current.play();
        } catch {
            // play() rejection after explicit user gesture is unusual; audio will
            // still play when the next srcObject is attached or the track delivers data.
        }
    };

    const stopBoostedPlayback = async () => {
        const { audioContext, gainNode, sourceNode } = boostedPlaybackRef.current;
        sourceNode?.disconnect();
        gainNode?.disconnect();
        if (audioContext) {
            await audioContext.close().catch(() => { });
        }
        boostedPlaybackRef.current = {
            audioContext: null,
            gainNode: null,
            sourceNode: null,
            stream: null,
        };
    };

    const tryStartBoostedPlayback = async (stream) => {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass || !stream) {
            return false;
        }

        if (boostedPlaybackRef.current.stream === stream && boostedPlaybackRef.current.audioContext?.state !== 'closed') {
            return true;
        }

        await stopBoostedPlayback();

        try {
            const audioContext = new AudioContextClass();
            const sourceNode = audioContext.createMediaStreamSource(stream);
            const gainNode = audioContext.createGain();
            gainNode.gain.value = 3;

            sourceNode.connect(gainNode);
            gainNode.connect(audioContext.destination);
            await audioContext.resume();

            boostedPlaybackRef.current = {
                audioContext,
                gainNode,
                sourceNode,
                stream,
            };

            return true;
        } catch {
            await stopBoostedPlayback();
            return false;
        }
    };

    useEffect(() => {
        const joinRoom = () => {
            socket.emit(SOCKET_EVENTS.JOIN_ROOM, {
                roomId: room.roomId,
                displayName: room.displayName,
                mode: ROOM_MODES.WALKIE_TALKIE,
            });
        };

        joinRoom();
        socket.on('connect', joinRoom);

        return () => {
            socket.off('connect', joinRoom);
            socket.emit(SOCKET_EVENTS.LEAVE_ROOM, { roomId: room.roomId });
        };
    }, [room.displayName, room.roomId, socket]);

    useEffect(() => {
        let cancelled = false;

        const applyPlayback = async () => {
            if (!audioRef.current) {
                return;
            }

            audioRef.current.srcObject = remoteStream;
            audioRef.current.volume = 1;

            if (!remoteStream || isOwnPlayback) {
                await stopBoostedPlayback();
                if (cancelled) {
                    return;
                }
                if (isOwnPlayback) {
                    // Mute own loopback so the speaker doesn't hear themselves.
                    audioRef.current.muted = true;
                    setPlaybackBlocked(false);
                    audioRef.current.play().catch(() => { });
                }
                return;
            }

            if (audioUnlockedRef.current) {
                void resumePrimedAudio();
                const boosted = await tryStartBoostedPlayback(remoteStream);
                if (cancelled) {
                    return;
                }

                if (boosted) {
                    // Route through an explicit gain node to make low-level RTP audio audible.
                    audioRef.current.muted = true;
                    setPlaybackBlocked(false);
                    return;
                }

                audioRef.current.muted = false;
                audioRef.current.play().catch(() => {
                    audioUnlockedRef.current = false;
                    setPlaybackBlocked(true);
                });
                setPlaybackBlocked(false);
            } else {
                // Start muted so autoplay always succeeds, then ask the user to unmute.
                audioRef.current.muted = true;
                audioRef.current.play().catch(() => { });
                setPlaybackBlocked(true);
            }
        };

        void applyPlayback();

        return () => {
            cancelled = true;
            void stopBoostedPlayback();
        };
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

                    {playbackBlocked ? (
                        <div className="incoming-call-card">
                            <p><strong>Browser blocked automatic audio.</strong> Click once to allow playback.</p>
                            <button className="secondary-button" onClick={unlockRemotePlayback} type="button">
                                Enable audio
                            </button>
                        </div>
                    ) : null}

                    <AudioVisualizer active={Boolean(remoteStream) && !playbackBlocked} stream={remoteStream} />

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
                            <strong>{trafficParticipants.length}</strong>
                        </div>
                    </div>
                    {error ? <p className="inline-error">{error}</p> : null}
                    <audio playsInline ref={audioRef} />
                </div>

                <div className="panel participants-panel">
                    <h3>Room traffic</h3>
                    <ul className="participant-list">
                        {trafficParticipants.map((participant) => (
                            <li key={participant.key}>
                                <strong>{participant.displayName}</strong>
                                <span>{participant.label}</span>
                                <span>{participant.isSpeaking ? 'Speaking now' : 'Listening'}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </section>
    );
};

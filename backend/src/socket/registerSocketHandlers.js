import { roomModes, socketEventNames } from '../config.js';

const emitSocketError = (socket, error) => {
    socket.emit(socketEventNames.error, { message: error.message });
};

const emitRoomState = (io, roomStore, roomId) => {
    const room = roomStore.getRoom(roomId);
    if (room) {
        io.to(roomId).emit(socketEventNames.roomState, roomStore.serializeRoom(room));
    }
};

export const registerSocketHandlers = ({ io, roomStore, janusClient, pttPublisher }) => {
    const streamingCallbacks = (socket, roomId, socketId) => ({
        onEvent: (message) => {
            if (message.jsep) {
                socket.emit(socketEventNames.offer, {
                    roomId,
                    mode: roomModes.WALKIE_TALKIE,
                    jsep: message.jsep,
                });
            }
            if (message.plugindata?.data?.status) {
                socket.emit('janus-status', {
                    roomId,
                    mode: roomModes.WALKIE_TALKIE,
                    status: message.plugindata.data.status,
                    socketId,
                });
            }
        },
        onTrickle: (candidate) => {
            socket.emit(socketEventNames.iceCandidate, {
                roomId,
                mode: roomModes.WALKIE_TALKIE,
                candidate,
            });
        },
        onHangup: (message) => {
            socket.emit('peer-hangup', {
                roomId,
                mode: roomModes.WALKIE_TALKIE,
                reason: message.reason,
            });
        },
    });

    const audioBridgeCallbacks = (socket, roomId, socketId) => ({
        onEvent: (message) => {
            const data = message.plugindata?.data;
            if (data?.id) {
                roomStore.setJanusParticipantId(socketId, data.id);
            }
            if (message.jsep) {
                socket.emit(socketEventNames.answer, {
                    roomId,
                    mode: roomModes.PHONE_CALL,
                    jsep: message.jsep,
                });
            }
            if (data?.participants || data?.leaving) {
                emitRoomState(io, roomStore, roomId);
            }
        },
        onTrickle: (candidate) => {
            socket.emit(socketEventNames.iceCandidate, {
                roomId,
                mode: roomModes.PHONE_CALL,
                candidate,
            });
        },
        onHangup: (message) => {
            socket.emit(socketEventNames.callEnded, {
                roomId,
                reason: message.reason,
            });
        },
    });

    const ensureStreamingSubscription = async (socket, roomId) => {
        const room = roomStore.getRoom(roomId);
        const { participant } = roomStore.findParticipant(socket.id);
        if (!room || !participant || participant.streamingHandleId) {
            return;
        }

        const handleId = await janusClient.createHandle(
            'janus.plugin.streaming',
            streamingCallbacks(socket, roomId, socket.id),
        );
        roomStore.setStreamingHandle(socket.id, handleId);
        await janusClient.pluginMessage(handleId, {
            request: 'watch',
            id: room.janus.streamingMountpointId,
        });
    };

    const ensureAudioBridgeHandle = async (socket, roomId) => {
        const { room, participant } = roomStore.findParticipant(socket.id);
        if (!room || room.roomId !== roomId || !participant) {
            throw new Error('The user is not joined to the requested room.');
        }
        if (participant.audioBridgeHandleId) {
            return participant.audioBridgeHandleId;
        }

        const handleId = await janusClient.createHandle(
            'janus.plugin.audiobridge',
            audioBridgeCallbacks(socket, roomId, socket.id),
        );
        roomStore.setAudioBridgeHandle(socket.id, handleId);
        return handleId;
    };

    const cleanupParticipantHandles = async (participant) => {
        if (!participant) {
            return;
        }
        await janusClient.detachHandle(participant.streamingHandleId);
        await janusClient.detachHandle(participant.audioBridgeHandleId);
    };

    pttPublisher.on('playback-started', ({ roomId, durationMs }) => {
        io.to(roomId).emit(socketEventNames.pttPlaybackStarted, { roomId, durationMs });
    });
    pttPublisher.on('playback-ended', ({ roomId, durationMs }) => {
        io.to(roomId).emit(socketEventNames.pttPlaybackEnded, { roomId, durationMs });
    });

    io.on('connection', (socket) => {
        socket.on(socketEventNames.joinRoom, async (payload = {}) => {
            try {
                const room = roomStore.getRoom(payload.roomId);
                if (!room) {
                    throw new Error(`Room ${payload.roomId} does not exist. Create it first through the REST API.`);
                }

                const existingMembership = roomStore.findParticipant(socket.id);
                if (
                    existingMembership.room?.roomId === payload.roomId
                    && existingMembership.participant?.mode === payload.mode
                ) {
                    socket.join(payload.roomId);
                    socket.emit(socketEventNames.roomJoined, roomStore.serializeRoom(roomStore.getRoom(payload.roomId)));
                    emitRoomState(io, roomStore, payload.roomId);
                    return;
                }

                if (existingMembership.participant) {
                    const previousRoomId = existingMembership.room?.roomId;
                    roomStore.removeParticipant(socket.id);
                    await cleanupParticipantHandles(existingMembership.participant);
                    if (previousRoomId) {
                        socket.leave(previousRoomId);
                        emitRoomState(io, roomStore, previousRoomId);
                    }
                }

                roomStore.addParticipant({
                    roomId: payload.roomId,
                    socketId: socket.id,
                    displayName: payload.displayName,
                    mode: payload.mode,
                });

                socket.join(payload.roomId);
                if (payload.mode === roomModes.WALKIE_TALKIE) {
                    await ensureStreamingSubscription(socket, payload.roomId);
                }
                socket.emit(socketEventNames.roomJoined, roomStore.serializeRoom(roomStore.getRoom(payload.roomId)));
                emitRoomState(io, roomStore, payload.roomId);
            } catch (error) {
                emitSocketError(socket, error);
            }
        });

        socket.on(socketEventNames.leaveRoom, async ({ roomId }) => {
            const { room, participant } = roomStore.removeParticipant(socket.id);
            socket.leave(roomId);
            await cleanupParticipantHandles(participant);
            if (room) {
                emitRoomState(io, roomStore, room.roomId);
            }
        });

        socket.on(socketEventNames.offer, async ({ roomId, mode, jsep }) => {
            try {
                if (mode !== roomModes.PHONE_CALL) {
                    throw new Error('Browser offers are only expected for phone call mode.');
                }
                const room = roomStore.getRoom(roomId);
                const { participant } = roomStore.findParticipant(socket.id);
                if (!room || !participant) {
                    throw new Error('Join the room before starting a call.');
                }

                const handleId = await ensureAudioBridgeHandle(socket, roomId);
                const joinedBefore = Boolean(participant.janusParticipantId);
                if (joinedBefore) {
                    await janusClient.pluginMessage(handleId, { request: 'configure', muted: participant.muted }, jsep);
                } else {
                    await janusClient.pluginMessage(
                        handleId,
                        {
                            request: 'join',
                            room: room.janus.audioBridgeRoomId,
                            display: participant.displayName,
                            codec: 'opus',
                            muted: participant.muted,
                        },
                        jsep,
                    );
                }
            } catch (error) {
                emitSocketError(socket, error);
            }
        });

        socket.on(socketEventNames.answer, async ({ mode, jsep }) => {
            try {
                if (mode !== roomModes.WALKIE_TALKIE) {
                    throw new Error('Browser answers are only expected for walkie-talkie streaming subscriptions.');
                }
                const { participant } = roomStore.findParticipant(socket.id);
                if (!participant?.streamingHandleId) {
                    throw new Error('There is no active Janus streaming subscription for this socket.');
                }
                await janusClient.pluginMessage(participant.streamingHandleId, { request: 'start' }, jsep);
            } catch (error) {
                emitSocketError(socket, error);
            }
        });

        socket.on(socketEventNames.iceCandidate, async ({ roomId, mode, candidate }) => {
            try {
                const { participant } = roomStore.findParticipant(socket.id);
                if (!participant) {
                    throw new Error('Join a room before sending ICE candidates.');
                }

                let handleId = participant.streamingHandleId;
                if (mode === roomModes.PHONE_CALL) {
                    handleId = participant.audioBridgeHandleId ?? await ensureAudioBridgeHandle(socket, roomId);
                }

                if (!handleId) {
                    throw new Error(`No Janus handle is available for ${mode}.`);
                }
                await janusClient.trickle(handleId, candidate ?? { completed: true });
            } catch (error) {
                emitSocketError(socket, error);
            }
        });

        socket.on(socketEventNames.pttStart, ({ roomId }) => {
            try {
                const claimed = roomStore.claimPtt(roomId, socket.id);
                if (!claimed) {
                    socket.emit(socketEventNames.pttBusy, { roomId, holder: roomStore.getRoom(roomId)?.activePttSpeaker });
                    return;
                }
                io.to(roomId).emit(socketEventNames.pttStart, { roomId, speakerSocketId: socket.id });
                emitRoomState(io, roomStore, roomId);
            } catch (error) {
                emitSocketError(socket, error);
            }
        });

        socket.on(socketEventNames.pttStop, async ({ roomId, mimeType, audioBuffer, durationMs }) => {
            try {
                const room = roomStore.getRoom(roomId);
                if (!room) {
                    throw new Error(`Room ${roomId} does not exist.`);
                }
                if (room.activePttSpeaker !== socket.id) {
                    throw new Error('This socket does not currently own the push-to-talk lock.');
                }
                const normalizedBuffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer ?? []);
                await pttPublisher.publishClip({
                    roomId,
                    port: room.janus.streamingPort,
                    audioBuffer: normalizedBuffer,
                    mimeType,
                    durationMs,
                });
            } catch (error) {
                emitSocketError(socket, error);
            } finally {
                roomStore.releasePtt(roomId, socket.id);
                emitRoomState(io, roomStore, roomId);
            }
        });

        socket.on(socketEventNames.callRequest, ({ roomId }) => {
            try {
                const target = roomStore.startCall(roomId, socket.id);
                io.to(target.socketId).emit(socketEventNames.incomingCall, { roomId, fromSocketId: socket.id });
                io.to(socket.id).emit('call-state', { roomId, status: 'calling' });
                emitRoomState(io, roomStore, roomId);
            } catch (error) {
                emitSocketError(socket, error);
            }
        });

        socket.on(socketEventNames.callAccept, ({ roomId }) => {
            try {
                const call = roomStore.acceptCall(roomId, socket.id);
                io.to(roomId).emit(socketEventNames.callAccepted, {
                    roomId,
                    callerSocketId: call.pendingCallerId,
                    acceptedBy: call.acceptedBy,
                });
                emitRoomState(io, roomStore, roomId);
            } catch (error) {
                emitSocketError(socket, error);
            }
        });

        socket.on(socketEventNames.callReject, ({ roomId }) => {
            try {
                const previous = roomStore.rejectCall(roomId);
                io.to(roomId).emit(socketEventNames.callRejected, {
                    roomId,
                    callerSocketId: previous.pendingCallerId,
                });
                emitRoomState(io, roomStore, roomId);
            } catch (error) {
                emitSocketError(socket, error);
            }
        });

        socket.on(socketEventNames.callEnd, async ({ roomId }) => {
            try {
                const previous = roomStore.endCall(roomId);
                io.to(roomId).emit(socketEventNames.callEnded, {
                    roomId,
                    callerSocketId: previous.pendingCallerId,
                    acceptedBy: previous.acceptedBy,
                });

                const room = roomStore.getRoom(roomId);
                if (room) {
                    for (const participant of room.participants.values()) {
                        await janusClient.detachHandle(participant.audioBridgeHandleId);
                        participant.audioBridgeHandleId = null;
                        participant.janusParticipantId = null;
                    }
                }
                emitRoomState(io, roomStore, roomId);
            } catch (error) {
                emitSocketError(socket, error);
            }
        });

        socket.on(socketEventNames.callMute, async ({ muted }) => {
            try {
                const { participant } = roomStore.findParticipant(socket.id);
                if (!participant?.audioBridgeHandleId) {
                    throw new Error('Join a phone call before toggling mute.');
                }
                roomStore.setMuted(socket.id, Boolean(muted));
                await janusClient.pluginMessage(participant.audioBridgeHandleId, {
                    request: 'configure',
                    muted: Boolean(muted),
                });
            } catch (error) {
                emitSocketError(socket, error);
            }
        });

        socket.on('disconnect', async () => {
            const { room, participant } = roomStore.removeParticipant(socket.id);
            await cleanupParticipantHandles(participant);
            if (room) {
                emitRoomState(io, roomStore, room.roomId);
            }
        });
    });
};

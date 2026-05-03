import { useEffect, useState } from 'react';

import { PhoneCallRoom } from './components/PhoneCallRoom.jsx';
import { RoomSelector } from './components/RoomSelector.jsx';
import { WalkieTalkieRoom } from './components/WalkieTalkieRoom.jsx';
import { ROOM_MODES, SOCKET_EVENTS } from './constants.js';
import { apiBaseUrl, ensureSocketConnected, socket } from './socket.js';

const fetchJson = async (url, options = {}) => {
    const response = await fetch(url, {
        headers: {
            'Content-Type': 'application/json',
        },
        ...options,
    });

    if (response.status === 204) {
        return null;
    }

    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload.error || 'Request failed.');
    }
    return payload;
};

const buildSession = ({ displayName, mode, roomId, roomName }) => ({
    displayName,
    mode,
    roomId,
    name: roomName || roomId,
    participants: [],
    activePttSpeaker: null,
    janus: {},
    call: { status: 'idle' },
});

export default function App() {
    const [rooms, setRooms] = useState([]);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [session, setSession] = useState(null);

    const loadRooms = async () => {
        try {
            const payload = await fetchJson(`${apiBaseUrl}/api/rooms`);
            setRooms(payload.rooms);
        } catch (caughtError) {
            setError(caughtError.message || 'Failed to load rooms from the signaling server.');
        }
    };

    useEffect(() => {
        loadRooms();
    }, []);

    useEffect(() => {
        const handleRoomState = (payload) => {
            setSession((current) => {
                if (!current || payload.roomId !== current.roomId) {
                    return current;
                }
                return {
                    ...current,
                    ...payload,
                    displayName: current.displayName,
                    mode: current.mode,
                };
            });
        };

        const handleRoomJoined = (payload) => {
            setSession((current) => {
                if (!current || payload.roomId !== current.roomId) {
                    return current;
                }
                return {
                    ...current,
                    ...payload,
                    displayName: current.displayName,
                    mode: current.mode,
                };
            });
        };

        const handleAppError = (payload) => {
            setError(payload.message || 'Unexpected realtime error.');
        };

        socket.on(SOCKET_EVENTS.ROOM_STATE, handleRoomState);
        socket.on(SOCKET_EVENTS.ROOM_JOINED, handleRoomJoined);
        socket.on(SOCKET_EVENTS.APP_ERROR, handleAppError);

        return () => {
            socket.off(SOCKET_EVENTS.ROOM_STATE, handleRoomState);
            socket.off(SOCKET_EVENTS.ROOM_JOINED, handleRoomJoined);
            socket.off(SOCKET_EVENTS.APP_ERROR, handleAppError);
        };
    }, []);

    const handleJoin = async ({ displayName, mode, roomId, roomName }) => {
        setPending(true);
        setError('');

        try {
            try {
                await fetchJson(`${apiBaseUrl}/api/rooms`, {
                    method: 'POST',
                    body: JSON.stringify({ roomId, name: roomName }),
                });
            } catch (caughtError) {
                if (!caughtError.message.includes('already exists')) {
                    throw caughtError;
                }
            }

            ensureSocketConnected();
            setSession(buildSession({ displayName, mode, roomId, roomName }));
            await loadRooms();
        } catch (caughtError) {
            setError(caughtError.message || 'Failed to prepare the selected room.');
        } finally {
            setPending(false);
        }
    };

    const handleLeave = () => {
        if (session) {
            socket.emit(SOCKET_EVENTS.LEAVE_ROOM, { roomId: session.roomId });
        }
        setSession(null);
        setError('');
        loadRooms();
    };

    return (
        <main className="app-shell">
            <div className="app-background" />
            <div className="app-content">
                {session && error ? <p className="inline-error">{error}</p> : null}
                {!session ? <RoomSelector error={error} onJoin={handleJoin} pending={pending} rooms={rooms} /> : null}
                {session?.mode === ROOM_MODES.WALKIE_TALKIE ? <WalkieTalkieRoom onLeave={handleLeave} room={session} socket={socket} /> : null}
                {session?.mode === ROOM_MODES.PHONE_CALL ? <PhoneCallRoom onLeave={handleLeave} room={session} socket={socket} /> : null}
            </div>
        </main>
    );
}

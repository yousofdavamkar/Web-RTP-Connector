import { io } from 'socket.io-client';

const getDefaultBaseUrl = () => {
    if (typeof window === 'undefined') {
        return 'http://localhost:4000';
    }

    const { hostname, origin, port, protocol } = window.location;
    if (!port || !['4173', '5173'].includes(port)) {
        return origin;
    }

    return `${protocol}//${hostname}:4000`;
};

const defaultBaseUrl = getDefaultBaseUrl();
const socketUrl = import.meta.env.VITE_SOCKET_URL || defaultBaseUrl;

export const socket = io(socketUrl, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
});

export const ensureSocketConnected = () => {
    if (!socket.connected) {
        socket.connect();
    }
    return socket;
};

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || defaultBaseUrl;

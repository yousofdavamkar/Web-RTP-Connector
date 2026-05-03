import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const JANUS_PROTOCOL = 'janus-protocol';

const randomTransaction = () => Math.random().toString(36).slice(2, 14);

export class JanusClient extends EventEmitter {
    constructor({ wsUrl, apiSecret = '', streamingAdminKey, audioBridgeAdminKey }) {
        super();
        this.wsUrl = wsUrl;
        this.apiSecret = apiSecret;
        this.streamingAdminKey = streamingAdminKey;
        this.audioBridgeAdminKey = audioBridgeAdminKey;
        this.socket = null;
        this.sessionId = null;
        this.keepaliveTimer = null;
        this.transactionHandlers = new Map();
        this.handleCallbacks = new Map();
        this.adminHandles = new Map();
        this.connectPromise = null;
    }

    async ensureSession() {
        if (this.sessionId && this.socket?.readyState === WebSocket.OPEN) {
            return this.sessionId;
        }
        if (!this.connectPromise) {
            this.connectPromise = this.#connect().finally(() => {
                this.connectPromise = null;
            });
        }
        return this.connectPromise;
    }

    async close() {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
        this.adminHandles.clear();
        this.handleCallbacks.clear();
        this.sessionId = null;
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.socket.close();
        }
        this.socket = null;
    }

    getState() {
        return {
            connected: this.socket?.readyState === WebSocket.OPEN,
            sessionId: this.sessionId,
        };
    }

    async createHandle(plugin, callbacks = {}) {
        await this.ensureSession();
        const response = await this.#send({ janus: 'attach', plugin });
        const handleId = response.data.id;
        this.handleCallbacks.set(handleId, callbacks);
        return handleId;
    }

    async detachHandle(handleId) {
        if (!handleId || !this.sessionId) {
            return;
        }
        try {
            await this.#send({ janus: 'detach', handle_id: handleId });
        } catch {
            // Detach failures during cleanup are safe to ignore.
        }
        this.handleCallbacks.delete(handleId);
        for (const [plugin, adminHandle] of this.adminHandles.entries()) {
            if (adminHandle === handleId) {
                this.adminHandles.delete(plugin);
            }
        }
    }

    async pluginMessage(handleId, body, jsep) {
        const request = { janus: 'message', handle_id: handleId, body };
        if (jsep) {
            request.jsep = jsep;
        }
        return this.#send(request);
    }

    async trickle(handleId, candidate) {
        return this.#send({ janus: 'trickle', handle_id: handleId, candidate });
    }

    async createStreamingMountpoint({ id, name, description, audioPort }) {
        const handleId = await this.#ensureAdminHandle('janus.plugin.streaming');
        const response = await this.pluginMessage(handleId, {
            request: 'create',
            admin_key: this.streamingAdminKey,
            type: 'rtp',
            id,
            name,
            description,
            permanent: false,
            is_private: false,
            media: [
                {
                    type: 'audio',
                    mid: 'a',
                    label: 'Audio',
                    port: audioPort,
                    pt: 111,
                    codec: 'opus',
                    fmtp: 'minptime=10;useinbandfec=1;stereo=0;maxaveragebitrate=48000',
                },
            ],
        });
        return response.plugindata?.data ?? response;
    }

    async destroyStreamingMountpoint(id) {
        const handleId = await this.#ensureAdminHandle('janus.plugin.streaming');
        return this.pluginMessage(handleId, {
            request: 'destroy',
            id,
            permanent: false,
        });
    }

    async createAudioBridgeRoom({ room, description }) {
        const handleId = await this.#ensureAdminHandle('janus.plugin.audiobridge');
        const response = await this.pluginMessage(handleId, {
            request: 'create',
            admin_key: this.audioBridgeAdminKey,
            room,
            description,
            sampling_rate: 48000,
            default_bitrate: 128000,
            opus_fec: true,
            audiolevel_ext: true,
            audiolevel_event: true,
            allow_rtp_participants: true,
            record: false,
            mjrs: false,
            permanent: false,
        });
        return response.plugindata?.data ?? response;
    }

    async destroyAudioBridgeRoom(room) {
        const handleId = await this.#ensureAdminHandle('janus.plugin.audiobridge');
        return this.pluginMessage(handleId, {
            request: 'destroy',
            room,
            permanent: false,
        });
    }

    async createAudioBridgeForwarder({ room, host, port, codec = 'opus', ptype = 111, alwaysOn = true }) {
        const handleId = await this.#ensureAdminHandle('janus.plugin.audiobridge');
        const response = await this.pluginMessage(handleId, {
            request: 'rtp_forward',
            room,
            host,
            port,
            codec,
            ptype,
            always_on: alwaysOn,
        });
        return response.plugindata?.data ?? response;
    }

    async stopAudioBridgeForwarder({ room, streamId }) {
        const handleId = await this.#ensureAdminHandle('janus.plugin.audiobridge');
        return this.pluginMessage(handleId, {
            request: 'stop_rtp_forward',
            room,
            stream_id: streamId,
        });
    }

    async createAudioBridgeRtpParticipant({ room, display, codec = 'opus', host, port, payloadType = 111, muted = false }) {
        const joined = await new Promise(async (resolve, reject) => {
            const handleId = await this.createHandle('janus.plugin.audiobridge', {
                onEvent: (message) => {
                    const data = message.plugindata?.data;
                    if (data?.audiobridge === 'joined') {
                        resolve({ handleId, data });
                    }
                },
                onHangup: (message) => {
                    reject(new Error(message.reason ?? 'Janus hung up the RTP participant.'));
                },
            });

            try {
                const body = {
                    request: 'join',
                    room,
                    display,
                    codec,
                    muted,
                    rtp: {
                        payload_type: payloadType,
                    },
                };
                if (host && port) {
                    body.rtp.ip = host;
                    body.rtp.port = port;
                    body.rtp.fec = true;
                }
                await this.pluginMessage(handleId, body);
            } catch (error) {
                await this.detachHandle(handleId);
                reject(error);
            }

            setTimeout(async () => {
                await this.detachHandle(handleId);
                reject(new Error('Timed out waiting for Janus AudioBridge RTP participant setup.'));
            }, 10000);
        });

        return {
            handleId: joined.handleId,
            janusParticipantId: joined.data.id,
            janusRtp: {
                host: joined.data.rtp?.ip,
                port: joined.data.rtp?.port,
                payloadType: joined.data.rtp?.payload_type ?? payloadType,
            },
            display: joined.data.display ?? display,
        };
    }

    async #ensureAdminHandle(plugin) {
        const existing = this.adminHandles.get(plugin);
        if (existing) {
            return existing;
        }
        const handleId = await this.createHandle(plugin, {});
        this.adminHandles.set(plugin, handleId);
        return handleId;
    }

    async #connect() {
        await this.close();

        const socket = new WebSocket(this.wsUrl, JANUS_PROTOCOL);
        this.socket = socket;

        await new Promise((resolve, reject) => {
            const onOpen = () => {
                socket.off('error', onError);
                resolve();
            };
            const onError = (error) => {
                socket.off('open', onOpen);
                reject(error);
            };
            socket.once('open', onOpen);
            socket.once('error', onError);
        });

        socket.on('message', (payload) => {
            const parsed = JSON.parse(payload.toString());
            const messages = Array.isArray(parsed) ? parsed : [parsed];
            for (const message of messages) {
                this.#handleMessage(message);
            }
        });
        socket.on('close', () => {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
            this.sessionId = null;
            this.adminHandles.clear();
            this.emit('disconnected');
        });

        const response = await this.#send({ janus: 'create' }, { includeSession: false });
        this.sessionId = response.data.id;
        this.keepaliveTimer = setInterval(() => {
            if (this.socket?.readyState === WebSocket.OPEN && this.sessionId) {
                this.#send({ janus: 'keepalive' }).catch(() => { });
            }
        }, 25000);

        this.emit('connected', this.getState());
        return this.sessionId;
    }

    #handleMessage(message) {
        if (message.transaction && this.transactionHandlers.has(message.transaction)) {
            const handler = this.transactionHandlers.get(message.transaction);
            this.transactionHandlers.delete(message.transaction);
            if (message.janus === 'error') {
                handler.reject(new Error(message.error?.reason ?? 'Unknown Janus error.'));
            } else {
                handler.resolve(message);
            }
        }

        const handleId = message.sender;
        if (!handleId) {
            return;
        }
        const callbacks = this.handleCallbacks.get(handleId);
        if (!callbacks) {
            return;
        }

        if (message.janus === 'detached' && callbacks.onDetached) {
            callbacks.onDetached(message);
            return;
        }
        if (message.janus === 'trickle' && callbacks.onTrickle) {
            callbacks.onTrickle(message.candidate);
            return;
        }
        if (message.janus === 'hangup' && callbacks.onHangup) {
            callbacks.onHangup(message);
            return;
        }
        if (callbacks.onEvent) {
            callbacks.onEvent(message);
        }
    }

    async #send(request, { includeSession = true } = {}) {
        await this.ensureSessionIfNeeded(request, includeSession);
        const transaction = randomTransaction();
        const payload = {
            transaction,
            ...request,
        };
        if (includeSession && this.sessionId) {
            payload.session_id = this.sessionId;
        }
        if (includeSession && request.handle_id) {
            payload.handle_id = request.handle_id;
        }
        if (this.apiSecret) {
            payload.apisecret = this.apiSecret;
        }

        return new Promise((resolve, reject) => {
            this.transactionHandlers.set(transaction, { resolve, reject });
            this.socket.send(JSON.stringify(payload), (error) => {
                if (error) {
                    this.transactionHandlers.delete(transaction);
                    reject(error);
                }
            });
        });
    }

    async ensureSessionIfNeeded(request, includeSession) {
        if (request.janus === 'create') {
            return;
        }
        if (!includeSession) {
            return;
        }
        await this.ensureSession();
    }
}

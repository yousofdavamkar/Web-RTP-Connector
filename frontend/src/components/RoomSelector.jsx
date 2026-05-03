import { ROOM_MODES } from '../constants.js';

export const RoomSelector = ({ rooms, onJoin, pending, error }) => {
    const handleSubmit = (event) => {
        event.preventDefault();
        const formData = new FormData(event.currentTarget);
        onJoin({
            displayName: formData.get('displayName')?.toString() ?? '',
            roomId: formData.get('roomId')?.toString() ?? '',
            roomName: formData.get('roomName')?.toString() ?? '',
            mode: formData.get('mode')?.toString() ?? ROOM_MODES.WALKIE_TALKIE,
        });
    };

    return (
        <section className="selector-shell">
            <div className="selector-card hero-card">
                <p className="eyebrow">Janus RTP Voice System</p>
                <h1>Push-to-talk dispatch and full-duplex calls over Janus RTP.</h1>
                <p className="lead">
                    The browser captures audio, Node orchestrates the signaling, and Janus bridges every conversation through RTP.
                </p>
                <div className="architecture-pill-grid">
                    <span>React + WebRTC</span>
                    <span>Node + Socket.io</span>
                    <span>Janus Streaming</span>
                    <span>Janus AudioBridge</span>
                </div>
            </div>

            <div className="selector-card form-card">
                <form className="room-form" onSubmit={handleSubmit}>
                    <label>
                        Display Name
                        <input defaultValue="Operator" name="displayName" placeholder="Operator name" required />
                    </label>
                    <label>
                        Room ID
                        <input defaultValue="ops-room" name="roomId" placeholder="ops-room" required />
                    </label>
                    <label>
                        Room Name
                        <input defaultValue="Operations" name="roomName" placeholder="Readable room name" />
                    </label>
                    <label>
                        Mode
                        <select defaultValue={ROOM_MODES.WALKIE_TALKIE} name="mode">
                            <option value={ROOM_MODES.WALKIE_TALKIE}>Walkie-Talkie Mode</option>
                            <option value={ROOM_MODES.PHONE_CALL}>Phone Call Mode</option>
                        </select>
                    </label>

                    <button className="primary-button" disabled={pending} type="submit">
                        {pending ? 'Preparing room...' : 'Enter room'}
                    </button>
                    {error ? <p className="inline-error">{error}</p> : null}
                </form>

                <div className="room-list">
                    <div className="room-list-header">
                        <h2>Known rooms</h2>
                        <p>Backed by the Express room API.</p>
                    </div>
                    <ul>
                        {rooms.length === 0 ? <li>No rooms created yet.</li> : null}
                        {rooms.map((room) => (
                            <li key={room.roomId}>
                                <strong>{room.name}</strong>
                                <span>{room.roomId}</span>
                                <span>{room.participants.length} participant(s)</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </section>
    );
};

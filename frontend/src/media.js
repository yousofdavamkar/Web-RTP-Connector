const preferredVoiceConstraints = {
    channelCount: { ideal: 1 },
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
};

export const requestVoiceAudioStream = async (getUserMedia) => {
    try {
        return await getUserMedia({
            audio: preferredVoiceConstraints,
            video: false,
        });
    } catch {
        return getUserMedia({
            audio: true,
            video: false,
        });
    }
};
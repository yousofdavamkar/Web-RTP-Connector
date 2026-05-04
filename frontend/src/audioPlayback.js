let sharedAudioContext = null;

export const primeAudioPlayback = () => {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
        return Promise.resolve(false);
    }

    sharedAudioContext ??= new AudioContextClass();

    const gain = sharedAudioContext.createGain();
    gain.gain.value = 0;
    gain.connect(sharedAudioContext.destination);

    const oscillator = sharedAudioContext.createOscillator();
    oscillator.connect(gain);
    oscillator.start();
    oscillator.stop(sharedAudioContext.currentTime + 0.01);

    return sharedAudioContext.resume()
        .then(() => true)
        .catch(() => false)
        .finally(() => {
            oscillator.disconnect();
            gain.disconnect();
        });
};

export const resumePrimedAudio = () => {
    if (!sharedAudioContext || sharedAudioContext.state !== 'suspended') {
        return Promise.resolve(true);
    }

    return sharedAudioContext.resume()
        .then(() => true)
        .catch(() => false);
};

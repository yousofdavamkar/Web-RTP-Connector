import { useEffect, useRef, useState } from 'react';

const BAR_COUNT = 18;

export const AudioVisualizer = ({ stream, active = false }) => {
    const [bars, setBars] = useState(() => Array.from({ length: BAR_COUNT }, () => 0.12));
    const animationFrameRef = useRef(0);

    useEffect(() => {
        if (!stream || !active) {
            setBars(Array.from({ length: BAR_COUNT }, (_, index) => (index % 3 === 0 ? 0.35 : 0.12)));
            return undefined;
        }

        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
            analyser.getByteFrequencyData(data);
            const nextBars = Array.from({ length: BAR_COUNT }, (_unused, index) => {
                const start = index * Math.floor(data.length / BAR_COUNT);
                const slice = data.slice(start, start + Math.floor(data.length / BAR_COUNT));
                const avg = slice.reduce((total, value) => total + value, 0) / Math.max(1, slice.length);
                return Math.max(0.08, avg / 255);
            });
            setBars(nextBars);
            animationFrameRef.current = requestAnimationFrame(tick);
        };

        tick();

        return () => {
            cancelAnimationFrame(animationFrameRef.current);
            source.disconnect();
            analyser.disconnect();
            audioContext.close();
        };
    }, [active, stream]);

    return (
        <div className="visualizer" aria-hidden="true">
            {bars.map((bar, index) => (
                <span
                    className="visualizer-bar"
                    key={`bar-${index}`}
                    style={{ transform: `scaleY(${bar})` }}
                />
            ))}
        </div>
    );
};

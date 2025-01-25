// Импортируем оригинал
import {AudioClient} from './audio.js';

export class BlackHoleAudioClient extends AudioClient {
    constructor(endpoint, callbacks) {
        super(endpoint, callbacks);
        this.blackholeInput = null;
        this.blackholeOutput = null;
    }

    async setupAudio() {
        try {
            // 1. Создаем аудио контекст
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

            // 2. Находим BlackHole устройства
            const devices = await navigator.mediaDevices.enumerateDevices();
            console.log('[BlackHole] Available devices:', devices);

            // Ищем оба устройства BlackHole
            const blackhole = devices.find(d => d.label.includes('BlackHole 2ch'));
            if (!blackhole) {
                throw new Error('BlackHole 2ch not found');
            }

            // 3. Создаем поток из BlackHole для входа
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: {exact: blackhole.deviceId},
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });

            // 4. Настраиваем AudioWorklet
            const blob = new Blob([workletCode], {type: "application/javascript"});
            const blobURL = URL.createObjectURL(blob);

            await this.audioContext.audioWorklet.addModule(blobURL);
            this.audioNode = new AudioWorkletNode(this.audioContext, "capture-and-playback-processor");

            // 5. Важно! Настраиваем выход в BlackHole
            await this.audioContext.setSinkId(blackhole.deviceId);

            // 6. Подключаем аудиограф
            const source = this.audioContext.createMediaStreamSource(this.stream);
            source.connect(this.audioNode);
            this.audioNode.connect(this.audioContext.destination);

            // 7. Добавляем анализатор для мониторинга
            const analyzer = this.audioContext.createAnalyser();
            this.audioNode.connect(analyzer);

            // 8. Логируем аудиопотоки
            const monitorAudio = () => {
                const dataArray = new Float32Array(analyzer.frequencyBinCount);
                analyzer.getFloatTimeDomainData(dataArray);

                // Считаем RMS чтобы увидеть, есть ли сигнал
                const rms = Math.sqrt(
                    dataArray.reduce((acc, val) => acc + val * val, 0) / dataArray.length
                );

                if (rms > 0.01) {
                    console.log('[BlackHole] Audio activity detected:', {
                        rms,
                        peak: Math.max(...dataArray),
                        deviceId: blackhole.deviceId
                    });
                }

                requestAnimationFrame(monitorAudio);
            };
            monitorAudio();

            console.log('[BlackHole] Audio setup complete');
            URL.revokeObjectURL(blobURL);

        } catch (error) {
            console.error('[BlackHole] Setup failed:', error);
            throw error;
        }
    }

    // Переопределяем метод отправки аудио в WebSocket
    sendAudioToServer(audioData) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            console.log('[BlackHole] Sending audio to server:', audioData.length);
            this.ws.send(audioData);
        }
    }
}
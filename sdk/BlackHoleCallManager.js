// Импортируем оригинал и наш новый BlackHoleAudioClient
import { CallManager } from './sdk.js';
import { BlackHoleAudioClient } from './BlackHoleAudioClient.js';

export class BlackHoleCallManager extends CallManager {
    async handleCall(callId, partner, character) {
        // Подменяем стандартный AudioClient на BlackHoleAudioClient
        this.client = new BlackHoleAudioClient(this.config);

        // Всё остальное (создание звонка, WebSocket подписки) остаётся без изменений
        return super.handleCall(callId, partner, character);
    }
}
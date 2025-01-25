// sd.js

// 1. Глобальная константа для бэкенда
export const BACKEND_URL = 'https://backend.funtimewithaisolutions.com';

// 2. Firebase: логин по почте/паролю
export function getFirebaseToken(login, password, key) {
  return fetch(
    `https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: login,
        password: password,
        returnSecureToken: true
      })
    }
  )
    .then(async response => {
      if (!response.ok) {
        const errorData = await response.json();
        console.error('Full error response:', errorData);
        throw new Error(
          `Firebase API error: ${errorData.error?.message || response.statusText}`
        );
      }
      return response.json();
    })
    .then(data => data.idToken)
    .catch(error => {
      console.error('There was a problem with the fetch operation:', error);
      throw error;
    });
}

// 3. Firebase: анонимная авторизация
export function getFirebaseTokenAnonymous(key) {
  return fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        returnSecureToken: true
      })
    }
  )
    .then(async response => {
      if (!response.ok) {
        const errorData = await response.json();
        console.error('Full error response:', errorData);
        throw new Error(
          `Firebase API error: ${errorData.error?.message || response.statusText}`
        );
      }
      return response.json();
    })
    .then(data => data.idToken)
    .catch(error => {
      console.error('There was a problem with the fetch operation:', error);
      throw error;
    });
}

// 4. Базовый класс AudioClient
export class AudioClient {
  constructor(connectionUrl, callbacks) {
    this.connectionUrl = connectionUrl;
    this.callbacks = callbacks;
    this.stream = null;
    this.ws = null;
  }

  async startAudio() {
    if (this.callbacks?.onStatusUpdate) {
      this.callbacks.onStatusUpdate('Connecting WebSocket...');
    }

    // Открываем WebSocket
    this.ws = new WebSocket(this.connectionUrl);

    this.ws.onopen = () => {
      if (this.callbacks?.onStatusUpdate) {
        this.callbacks.onStatusUpdate('WebSocket connected!');
      }
      if (this.callbacks?.onConnected) {
        this.callbacks.onConnected();
      }
    };

    this.ws.onclose = () => {
      if (this.callbacks?.onDisconnected) {
        this.callbacks.onDisconnected();
      }
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    // Вызываем метод, где наследники могут подхватить getUserMedia
    await this.setupAudio();
  }

  // Переопределяется в наследниках (при необходимости)
  async setupAudio() {
    // По умолчанию пусто
  }

  stopAudio() {
    // Останавливаем стрим
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    // Закрываем WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// 4.1. Класс BlackHoleAudioClient (наследник), для использования BlackHole 2ch
export class BlackHoleAudioClient extends AudioClient {
  async setupAudio() {
    console.log('[BlackHoleAudioClient] Поиск устройства "BlackHole 2ch"...');
    const devices = await navigator.mediaDevices.enumerateDevices();
    console.log('[BlackHoleAudioClient] Обнаруженные устройства:', devices);

    const blackhole = devices.find(d => d.label.includes('BlackHole 2ch'));
    if (!blackhole) {
      console.error('[BlackHoleAudioClient] Устройство BlackHole 2ch не найдено!');
      throw new Error('BlackHole device not found');
    }

    console.log('[BlackHoleAudioClient] Найдено устройство BlackHole 2ch:', blackhole);

    // Запрашиваем поток из BlackHole
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: blackhole.deviceId },
        echoCancellation: false,
        noiseSuppression: false
      }
    });
    console.log('[BlackHoleAudioClient] Получили поток getUserMedia:', this.stream);

    // Вызовем родительский setupAudio (если там понадобится доп. логика)
    const result = await super.setupAudio();
    console.log('[BlackHoleAudioClient] super.setupAudio() завершён');

    return result;
  }
}

// 5. Функция initiateCall (создаёт звонок на бэкенде, ждёт статус ongoing)
export async function initiateCall(token, onStatusUpdate, partner, character) {
  if (!token) {
    throw new Error('Token is required for initiating call');
  }

  try {
    // Make initial POST request to create call
    onStatusUpdate('Creating call...');
    // Collect metadata about the user session
    const metadata = {
      currentUrl: window.location.href,
      referrer: document.referrer,
      systemTime: new Date().toISOString(),
      language: navigator.language,
      userAgent: navigator.userAgent
    };

    const createResponse = await fetch(`${BACKEND_URL}/v1/calls`, {
      method: 'POST',
      mode: 'cors',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `character=${encodeURIComponent(partner + '/' + character)}&metadata=${encodeURIComponent(JSON.stringify(metadata))}`
    });

    const createData = await createResponse.json();
    const callId = createData.data.id; // напр. "/v1/calls/123"

    // Poll the call status until we get an endpoint
    while (true) {
      try {
        const statusResponse = await fetch(`${BACKEND_URL}${callId}`, {
          method: 'GET',
          mode: 'cors',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
          }
        });

        const statusData = await statusResponse.json();
        onStatusUpdate(statusData.data.state);

        if (statusData.data.state === 'ongoing' && statusData.data.endpoint) {
          // Clean up callId by removing the /v1/calls/ prefix
          const cleanCallId = createData.data.id.replace('/v1/calls/', '');
          return {
            endpoint: statusData.data.endpoint,
            callId: cleanCallId
          };
        }

        if (statusData.data.state === 'error') {
          throw new Error('Call failed');
        }

        // Wait a bit before polling again
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error('Error polling status:', error);
        throw error;
      }
    }
  } catch (error) {
    console.error('Error initiating call:', error);
    throw error;
  }
}

// 6. Класс CallManager, теперь использует BlackHoleAudioClient вместо обычного AudioClient
export class CallManager {
  constructor(callbacks) {
    this.client = null;
    this.callbacks = callbacks;
  }

  async handleCall(key, partner, character) {
    // Вызываем onCallStart(), если есть
    if (this.callbacks?.onCallStart) {
      this.callbacks.onCallStart();
    }

    try {
      // Get Firebase token
      if (this.callbacks?.onStatusUpdate) {
        this.callbacks.onStatusUpdate('Getting token...');
      }
      const currentToken = await getFirebaseTokenAnonymous(key);

      // Get endpoint and callId from initiateCall
      const { endpoint: baseEndpoint, callId } = await initiateCall(
        currentToken,
        (state) => {
          if (this.callbacks?.onStatusUpdate) {
            this.callbacks.onStatusUpdate(state);
          }
        },
        partner,
        character
      );

      console.log('Base endpoint:', baseEndpoint);
      console.log('Call ID:', callId);

      let attempt = 1;
      let connected = false;

      while (!connected && attempt <= 5) {
        try {
          if (this.callbacks?.onStatusUpdate) {
            this.callbacks.onStatusUpdate(`Connection attempt ${attempt}...`);
          }

          // Construct URL with attempt number and token
          let connectionUrl = new URL(baseEndpoint);
          connectionUrl.pathname = `${connectionUrl.pathname}${callId}/${attempt}`;
          connectionUrl.searchParams.append('token', currentToken);

          console.log('Attempting connection with URL:', connectionUrl.href);

          const audioCallbacks = {
            onStatusUpdate: this.callbacks?.onStatusUpdate,
            onConnected: () => {
              console.log('[CallManager] AudioClient connected!');
            },
            onDisconnected: () => {
              console.log('[CallManager] AudioClient disconnected');
              if (this.callbacks?.onCallError) {
                this.callbacks.onCallError('Disconnected');
              }
            }
          };

          // Заменяем класс AudioClient на BlackHoleAudioClient
          this.client = new BlackHoleAudioClient(connectionUrl.href, audioCallbacks);
          await this.client.startAudio();
          connected = true;

        } catch (error) {
          console.log(`Attempt ${attempt} failed:`, error);
          attempt++;
          if (attempt > 5) {
            throw new Error('Failed to connect after 5 attempts');
          }
          // Wait a bit before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } catch (error) {
      if (this.callbacks?.onStatusUpdate) {
        this.callbacks.onStatusUpdate(`Error: ${error.message}`);
      }
      if (this.callbacks?.onCallError) {
        this.callbacks.onCallError(error);
      }
    }
  }

  hangUp() {
    if (this.client) {
      this.client.stopAudio();
      this.client = null;
    }
    if (this.callbacks?.onHangUp) {
      this.callbacks.onHangUp();
    }
  }
}
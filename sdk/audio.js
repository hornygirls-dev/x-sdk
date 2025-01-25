const workletCode = `
class CaptureAndPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.audioData = [];
    this.currentSample = 0;
    this.lastChunkReceived = false;
    this.isPlaying = false;
    this.inputResampler = new Resampler(sampleRate, 16000, 1);
    this.outputResampler = new Resampler(24000, sampleRate, 1);
    this.port.onmessage = (e) => {
      if (e.data === "stop") {
        this.audioData = [];
        this.currentSample = 0;
        this.isPlaying = false;
        this.port.postMessage("stop");
      } else if (e.data === "start") {
        if (this.audioData.length == 0) {
          this.lastChunkReceived = false;
        }
        this.isPlaying = true;
      } else if (e.data === "last_chunk_received") {
        this.lastChunkReceived = true;
      } else if (e.data.length > 0) {
        this.lastChunkReceived = false;
        this.audioData.push(this.convertUint8ToFloat32(e.data));
      }
    };
  }

  convertUint8ToFloat32(array) {
    const targetArray = new Float32Array(array.byteLength / 2);
    const sourceDataView = new DataView(array.buffer);
    for (let i = 0; i < targetArray.length; i++) {
      targetArray[i] = sourceDataView.getInt16(i * 2, true) / 32768;
    }
    return targetArray;
  }

  convertFloat32ToUint8(array) {
    const buffer = new ArrayBuffer(array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < array.length; i++) {
      const value = array[i] * 32768;
      view.setInt16(i * 2, value, true);
    }
    return new Uint8Array(buffer);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const inputChannel = input[0];
    
    // Resample input from mic
    var resampledInput = [];
    // check if there is data in the input channel, and if input channel is not undefined
    if (inputChannel && inputChannel.length > 0) {
      resampledInput = this.inputResampler.resampler(inputChannel);
    }
    this.port.postMessage(["capture", this.convertFloat32ToUint8(resampledInput)]);
    this.port.postMessage(["user_speaking", inputChannel]);

    const output = outputs[0];
    const outputChannelLeft = output[0];
    const outputChannelRight = output[1];
    if (this.isPlaying && this.audioData.length > 0) {
      let remainingSamples = outputChannelLeft.length;
      let outputIndex = 0;

      while (remainingSamples > 0 && this.audioData.length > 0) {
        if (this.currentSample === 0) {
          // Resample the next chunk of audio data
          this.resampledOutput = this.outputResampler.resampler(this.audioData[0]);
        }

        const availableSamples = this.resampledOutput.length - this.currentSample;
        const samplesToWrite = Math.min(availableSamples, remainingSamples);

        outputChannelLeft.set(this.resampledOutput.subarray(this.currentSample, this.currentSample + samplesToWrite), outputIndex);
        if (outputChannelRight)
          outputChannelRight.set(this.resampledOutput.subarray(this.currentSample, this.currentSample + samplesToWrite), outputIndex);

        this.currentSample += samplesToWrite;
        outputIndex += samplesToWrite;
        remainingSamples -= samplesToWrite;

        if (this.currentSample === this.resampledOutput.length) {
          this.audioData.shift();
          this.currentSample = 0;
        }
      }

      if (remainingSamples > 0) {
        outputChannelLeft.fill(0, outputIndex);
        if (outputChannelRight)
          outputChannelRight.fill(0, outputIndex);
      }
      this.port.postMessage(["robot_speaking", outputChannelLeft]);

      // Notify when playback has finished
      if (this.isPlaying && this.audioData.length === 0 && this.lastChunkReceived) {
        this.isPlaying = false;
        this.lastChunkReceived = false;
        this.port.postMessage("playback_finished");
      }
    } else {
      outputChannelLeft.fill(0);
      if (outputChannelRight)
        outputChannelRight.fill(0);
    }

    return true;
  }
}

// Resampler class
class Resampler {
  constructor(fromSampleRate, toSampleRate, channels) {
    this.fromSampleRate = fromSampleRate;
    this.toSampleRate = toSampleRate;
    this.channels = channels;
    this.initialize();
  }

  initialize() {
    if (this.fromSampleRate == this.toSampleRate) {
      this.resampler = (buffer) => buffer;
      this.ratioWeight = 1;
    } else {
      this.ratioWeight = this.fromSampleRate / this.toSampleRate;
      this.resampler = this.linearInterpolate;
    }
  }

  linearInterpolate(buffer) {
    const outputBufferLength = Math.ceil(buffer.length / this.ratioWeight);
    const outputBuffer = new Float32Array(outputBufferLength);

    for (let i = 0; i < outputBufferLength; i++) {
      const position = i * this.ratioWeight;
      const lowerIndex = Math.floor(position);
      const upperIndex = Math.min(Math.ceil(position), buffer.length - 1);
      const fraction = position - lowerIndex;

      outputBuffer[i] = (1 - fraction) * buffer[lowerIndex] + fraction * buffer[upperIndex];
    }

    return outputBuffer;
  }
}
registerProcessor("capture-and-playback-processor", CaptureAndPlaybackProcessor);
`;


export class AudioClient {
  constructor(endpoint, callbacks) {
    this.endpoint = endpoint;
    this.ws = null;
    this.audioContext = null;
    this.audioNode = null;
    this.stream = null;
    this.callbacks = callbacks;
    this.microphoneName = "Unknown microphone"; // Store microphone name
    
    // Reconnection settings
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.baseReconnectDelay = 1000; // Start with 1 second
    this.maxReconnectDelay = 5; // Max 5 seconds
    this.reconnectTimer = null;
    this.isReconnecting = false;
    this.wasConnected = false; // Track if we had a successful connection

    // For secondary track management
    this.secondaryAllowed = false;
    this.secondaryPlaying = false;
    this.secondaryPlaybackPosition = 0;
    this.mainTrackPlaying = false;
    this.secondarySourceNode = null;
    this.secondaryAudioBuffer = null;
    this.secondaryStartTime = 0;

    // Latency measurement
    this.latencyCheckInterval = null;
    this.latencyStats = {
      last: 0,
      min: Infinity,
      max: 0,
      avg: 0,
      count: 0
    };
  }

  startLatencyMeasurement(intervalMs = 1000) {
    this.stopLatencyMeasurement(); // Clear any existing interval
    this.latencyStats = {
      last: 0,
      min: Infinity,
      max: 0,
      avg: 0,
      count: 0
    };
    this.latencyCheckInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const timestamp = performance.now();
        const pingMessage = new TextEncoder().encode(`ping${timestamp}`);
        this.ws.send(pingMessage);
      }
    }, intervalMs);
  }

  stopLatencyMeasurement() {
    if (this.latencyCheckInterval) {
      clearInterval(this.latencyCheckInterval);
      this.latencyCheckInterval = null;
    }
  }

  updateLatencyStats(latency) {
    this.latencyStats.last = latency;
    this.latencyStats.min = Math.min(this.latencyStats.min, latency);
    this.latencyStats.max = Math.max(this.latencyStats.max, latency);
    this.latencyStats.count++;
    this.latencyStats.avg = (this.latencyStats.avg * (this.latencyStats.count - 1) + latency) / this.latencyStats.count;
    
    // Log latency stats
    console.log(`network roundtrip (ms) - Last: ${Math.round(this.latencyStats.last)}, Min: ${Math.round(this.latencyStats.min)}, Max: ${Math.round(this.latencyStats.max)}, Avg: ${Math.round(this.latencyStats.avg)}`);
  }

  async initialize() {
    try {
      // Check if we're in a secure context (HTTPS or localhost)
      if (!window.isSecureContext) {
        const href = window.location.href;
        if (!href.startsWith('http://localhost') && !href.startsWith('https://')) {
          throw new Error("AudioWorklet requires a secure context (HTTPS) unless running on localhost");
        }
      }

      // Check browser compatibility
      if (!window.AudioContext && !window.webkitAudioContext) {
        throw new Error("AudioContext not supported in this browser");
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("getUserMedia not supported in this browser");
      }

      this.callbacks.onStatusUpdate("Setting up audio...");
      await this.setupAudio();
      this.callbacks.onStatusUpdate("Audio setup complete. Connecting to WebSocket...");
      this.setupWebSocket();
    } catch (err) {
      console.error("Initialization failed:", err);
      this.callbacks.onStatusUpdate("Error: " + err.message);
      throw err;
    }
  }

  async setupAudio() {
    try {
      // Create audio context
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.callbacks.onStatusUpdate("Audio context created...");

      // First get initial permission with basic audio
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Now we can enumerate devices since we have permission
      const devices = await navigator.mediaDevices.enumerateDevices();
      const microphones = devices.filter(device => device.kind === 'audioinput');
      console.log("\nAvailable microphones:", microphones.map(m => `${m.label} (${m.deviceId})`));

      // Try to find the microphone with "default" in its name
      const defaultMic = microphones.find(mic => 
        mic.label && mic.label.toLowerCase().includes('default')
      );
      
      // Stop the initial stream
      this.stream.getTracks().forEach(track => track.stop());
      
      // Now get the stream with proper constraints
      try {
        const constraints = {
          audio: {
            ...(defaultMic ? { deviceId: { exact: defaultMic.deviceId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 2,
            sampleRate: { ideal: 48000 },
            autoGainControl: false
          }
        };
        
        console.log("Using audio constraints:", constraints);
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        console.warn("Failed with ideal constraints, trying fallback:", err);
        // Fallback to basic audio constraints
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: true
        });
      }
      
      // Log audio devices and track settings
      const audioTrack = this.stream.getAudioTracks()[0];
      const settings = audioTrack.getSettings();
      console.log("Audio track settings:", settings);
      console.log("Audio track constraints:", audioTrack.getConstraints());
      
      // Log all available audio devices
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        console.log("\n=== Available Audio Devices ===");
        
        console.log("\nInput Devices (Microphones):");
        devices.filter(d => d.kind === 'audioinput').forEach(device => {
          const isSelected = settings.deviceId === device.deviceId;
          console.log(`${isSelected ? '> ' : '  '}${device.label || 'Unnamed Device'} (${device.deviceId})`);
          if (isSelected) {
            this.microphoneName = device.label || 'Unnamed Device';
            this.callbacks.onStatusUpdate(`Using microphone: ${this.microphoneName}`);
          }
        });
        
        console.log("\nOutput Devices (Speakers):");
        devices.filter(d => d.kind === 'audiooutput').forEach(device => {
          console.log(`  ${device.label || 'Unnamed Device'} (${device.deviceId})`);
        });
        
        console.log("\nSelected Sample Rate:", this.audioContext.sampleRate);
        console.log("Selected Channel Count:", settings.channelCount);
        console.log("Auto Gain Control:", settings.autoGainControl);
        console.log("Echo Cancellation:", settings.echoCancellation);
        console.log("Noise Suppression:", settings.noiseSuppression);
      } catch (err) {
        console.error("Failed to enumerate audio devices:", err);
      }
      
      this.callbacks.onStatusUpdate("Microphone access granted...");

      // Set up audio worklet
      let blobURL = null;
      try {
        const blob = new Blob([workletCode], { type: "application/javascript" });
        blobURL = URL.createObjectURL(blob);
        
        await this.audioContext.audioWorklet.addModule(blobURL).catch(err => {
          console.error("Failed to load audio worklet:", err);
          throw new Error("Failed to initialize audio processing. Please ensure you're using a modern browser with AudioWorklet support.");
        });
        this.callbacks.onStatusUpdate("Audio worklet loaded...");
        
        this.audioNode = new AudioWorkletNode(this.audioContext, "capture-and-playback-processor");
        this.callbacks.onStatusUpdate("Audio processor created...");
      } catch (err) {
        console.error("Failed to initialize audio worklet:", err);
        throw new Error("Failed to initialize audio processing. Please ensure you're using a modern browser with AudioWorklet support.");
      } finally {
        // Clean up the blob URL
        if (blobURL) {
          URL.revokeObjectURL(blobURL);
        }
      }

      // Add error handler for the audio node
      this.audioNode.onprocessorerror = (err) => {
        console.error("Audio processor error:", err);
        // this.statusText.textContent = "Audio processing error. Please refresh the page.";
      };

      // Set up message handling for the audio node
      this.audioNode.port.onmessage = (e) => {
        try {
          const data = e.data;
          if (Array.isArray(data)) {
            const eventName = data[0];
            if (eventName === "capture") {
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(data[1]);
              }
            } else if (eventName === "robot_speaking" && data[1]) {
              if (typeof robotSoundform !== 'undefined' && robotSoundform) {
                robotSoundform.update(data[1]);
              }
            } else if (eventName === "user_speaking" && data[1]) {
              if (typeof userSoundform !== 'undefined' && userSoundform) {
                userSoundform.update(data[1]);
              }
            }
          } else if (data === "stop") {
            console.log("Audio stopped playing");
            this.mainTrackPlaying = false;
            if (this.secondaryAllowed && !this.secondaryPlaying) {
              this.playSecondaryTrack();
            }
          } else if (data === "playback_finished") {
            console.log("Main track playback finished");
            this.mainTrackPlaying = false;
            if (this.secondaryAllowed && !this.secondaryPlaying) {
              this.playSecondaryTrack();
            }
          }
        } catch (err) {
          console.error("Error in audio processor message handler:", err);
          // this.statusText.textContent = "Audio processing error. Please refresh the page.";
        }
      };

      // Set up audio routing
      try {
        const source = this.audioContext.createMediaStreamSource(this.stream);
        source.connect(this.audioNode);
        this.audioNode.connect(this.audioContext.destination);
        this.callbacks.onStatusUpdate("Audio setup complete...");
      } catch (err) {
        console.error("Failed to set up audio routing:", err);
        throw new Error("Failed to connect audio components. Please refresh the page.");
      }
    } catch (err) {
      console.error("Audio setup failed:", err);
      this.callbacks.onStatusUpdate("Error: " + err.message);
      throw err;
    }
  }

  async loadSecondaryTrack(url) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    this.secondaryAudioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    // Set secondaryPlaybackPosition to a random time within the track duration
    this.secondaryPlaybackPosition = Math.random() * this.secondaryAudioBuffer.duration;
  }

  playSecondaryTrack() {
    if (this.secondaryAudioBuffer) {
      if (this.secondaryPlaybackPosition >= this.secondaryAudioBuffer.duration) {
        this.secondaryPlaybackPosition = 0;
      }
      this.secondarySourceNode = this.audioContext.createBufferSource();
      this.secondarySourceNode.buffer = this.secondaryAudioBuffer;
      this.secondarySourceNode.loop = true;
      this.secondarySourceNode.loopStart = 0;
      this.secondarySourceNode.loopEnd = this.secondaryAudioBuffer.duration;
      this.secondarySourceNode.connect(this.audioContext.destination);
      this.secondarySourceNode.start(0, this.secondaryPlaybackPosition);
      this.secondaryStartTime = this.audioContext.currentTime;
      this.secondaryPlaying = true;

      // No need for onended handler since we're looping
    }
  }

  pauseSecondaryTrack() {
    if (this.secondarySourceNode) {
      this.secondarySourceNode.stop();
      const elapsedTime = this.audioContext.currentTime - this.secondaryStartTime;
      this.secondaryPlaybackPosition = (this.secondaryPlaybackPosition + elapsedTime) % this.secondaryAudioBuffer.duration;
      this.secondarySourceNode.disconnect();
      this.secondarySourceNode = null;
      this.secondaryPlaying = false;
    }
  }

  setupWebSocket() {
    if (this.ws) {
      // Clean up existing connection if any
      this.ws.onclose = null; // Remove existing onclose handler
      this.ws.close();
    }

    this.ws = new WebSocket(this.endpoint);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      console.log("WebSocket connection opened");
      this.callbacks.onStatusUpdate(`WebSocket connected v3, ${this.microphoneName})`);
      this.callbacks.onConnected();
      this.wasConnected = true;
      this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
      this.isReconnecting = false;
      
      // Start latency measurement when connection is established
      this.startLatencyMeasurement();
    };

    this.ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        // Check for pong message
        if (event.data.startsWith('pong')) {
          const timestamp = parseFloat(event.data.slice(4));
          const latency = performance.now() - timestamp;
          this.updateLatencyStats(latency);
        } else if (event.data === "stop") {
          this.audioNode.port.postMessage("stop");
          this.mainTrackPlaying = false;
          console.log("Stop audio playback");
          if (this.secondaryAllowed && !this.secondaryPlaying) {
            this.playSecondaryTrack();
          }
        } else if (event.data === "start") {
          this.audioNode.port.postMessage("start");
          this.mainTrackPlaying = true;
          console.log("Start audio playback");
          if (this.secondaryPlaying) {
            this.pauseSecondaryTrack();
          }
        } else if (event.data === "last_chunk_received") {
          this.audioNode.port.postMessage("last_chunk_received");
          console.log("last_chunk_received");
        } else if (event.data.startsWith("loadSecondary:")) {
          // Load secondary track
          this.loadSecondaryTrack(
            event.data.substring("loadSecondary:".length) + '/secondary.mp3'
          );
        } else if (event.data === "allowSecondary") {
          this.secondaryAllowed = true;
          console.log("allowSecondary received. this.mainTrackPlaying:", this.mainTrackPlaying, "this.secondaryPlaying:", this.secondaryPlaying);
          if (!this.mainTrackPlaying && !this.secondaryPlaying) {
            console.log("Trying to play secondary track");
            this.playSecondaryTrack();
            console.log("Secondary track started");
          }
        } else if (event.data === "disallowSecondary") {
          this.secondaryAllowed = false;
          console.log("disallowSecondary received. this.secondaryPlaying:", this.secondaryPlaying);
          if (this.secondaryPlaying) {
            this.pauseSecondaryTrack();
            console.log("Secondary track paused");
          }
        } else {
          try {
            const data = JSON.parse(event.data);
              if (data && data.role && (data.txt !== undefined) && Number.isFinite(data.green)) {
                // Only update messages if history functions are available
                if (typeof update_or_create_message !== 'undefined' && 
                    typeof create_role_html !== 'undefined' && 
                    typeof create_cowsay_html !== 'undefined' &&
                    typeof update_info !== 'undefined') {
                  if (data.role === 'robot') {
                    update_or_create_message(data.id, create_role_html("Robot", "", data.txt + "\n\n", data.green), "robot-message")
                  } else if (data.role === 'human') {
                    update_or_create_message(data.id, create_role_html("Person", data.txt, "", 0), "human-message")
                  } else if (data.role === 'system') {
                    update_or_create_message(data.id, create_cowsay_html(data.txt, "green"), "system-message")
                  } else if (data.role === 'info') {
                    update_info(data.txt)
                  }
                }
            } else {
              console.error('Invalid JSON data:', event.data);
            }
          }
          catch (e) {
            console.error("Invalid JSON data", e);
          }
        }
      } else if (event.data instanceof ArrayBuffer) {
        const audio = new Uint8Array(event.data);
        console.log("Received audio data:", audio.length);
        this.audioNode.port.postMessage(audio);
        // Since we received audio data, main track is playing
        this.mainTrackPlaying = true;
        if (this.secondaryPlaying) {
          this.pauseSecondaryTrack();
        }
      }
    };

    this.ws.onclose = (event) => {
      console.log("WebSocket connection closed", event.code);
      
      // Stop latency measurement
      this.stopLatencyMeasurement();
      
      // Only attempt reconnection if we were previously connected and not manually stopping
      if (this.wasConnected && !this.isReconnecting && event.code !== 1000) {
        this.callbacks.onStatusUpdate("Connection lost. Attempting to reconnect...");
        this.attemptReconnection();
      } else if (event.code === 1000) {
        // Manual close or hangup
        this.callbacks.onStatusUpdate("Call ended");
        this.callbacks.onDisconnected();
      } else {
        this.callbacks.onStatusUpdate("Connection closed unexpectedly");
        this.callbacks.onDisconnected();
      }
    };

    this.ws.onerror = (event) => {
      console.error("WebSocket error:", event);
      // Don't update status here as onclose will be called immediately after
      // and we want to show the reconnection status instead
      this.callbacks.onDisconnected();
    };
  }

  async startAudio() {
    await this.initialize();
  }

  stopAudio() {
    // Stop latency measurement
    this.stopLatencyMeasurement();
    
    // Clear any pending reconnection attempts
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.wasConnected = false;
    this.isReconnecting = false;
    
    this.ws && this.ws.close(1000, "Hangup");
    this.audioContext && this.audioContext.close();
    this.audioNode && this.audioNode.disconnect();
    this.stream && this.stream.getTracks().forEach((track) => track.stop());
    if (this.secondarySourceNode) {
      this.secondarySourceNode.stop();
      this.secondarySourceNode.disconnect();
      this.secondarySourceNode = null;
    }
  }

  attemptReconnection() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log("Max reconnection attempts reached");
      this.callbacks.onStatusUpdate("Unable to reconnect. Please try calling again.");
      this.isReconnecting = false;
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    console.log(`Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay/1000}s`);
    this.callbacks.onStatusUpdate(`Reconnecting in ${delay/1000}s... (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.callbacks.onStatusUpdate(`Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      console.log("Reconnecting...");
      this.setupWebSocket();
    }, delay);
  }
}

// Usage
// const endpoint = "ws://your.websocket.endpoint";
// const client = new AudioClient(endpoint, statusTextElement, callButtonElement, hangUpButtonElement);
// client.startAudio();
// To stop:
// client.stopAudio();

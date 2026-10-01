import {
  GoogleGenAI,
  Modality,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import {
  buildSystemInstruction,
  INITIAL_GREETING_PROMPT,
} from "./arabic-instructions";
import {
  GEMINI_API_KEY_CANDIDATES,
  getGeminiApiKey,
  resolveGeminiLiveModels,
} from "./gemini-key";

export type AgentStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";

export interface TranscriptEntry {
  id: string;
  role: "user" | "agent";
  text: string;
}

export interface GeminiLiveCallbacks {
  onStatusChange: (status: AgentStatus, detail?: string) => void;
  onTranscriptUpdate?: (entries: TranscriptEntry[]) => void;
  onError?: (errorMessage: string) => void;
}

function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(
    int16.buffer,
    int16.byteOffset,
    int16.byteLength
  );
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

function downsampleTo16kHz(
  input: Float32Array,
  inputSampleRate: number
): Int16Array {
  const targetRate = 16000;
  if (inputSampleRate === targetRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  const ratio = inputSampleRate / targetRate;
  const newLength = Math.round(input.length / ratio);
  const result = new Int16Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }
    const sample =
      count > 0
        ? sum / count
        : input[Math.min(start, input.length - 1)] || 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    result[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }

  return result;
}

export class GeminiLiveVoiceClient {
  private session: Session | null = null;
  private micStream: MediaStream | null = null;
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private isConnected = false;
  private callbacks: GeminiLiveCallbacks;
  private transcripts: TranscriptEntry[] = [];
  private currentUserText = "";
  private currentAgentText = "";

  constructor(callbacks: GeminiLiveCallbacks) {
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (this.isConnected) {
      await this.stop();
    }

    this.callbacks.onStatusChange("connecting", "Connecting...");
    this.transcripts = [];
    this.currentUserText = "";
    this.currentAgentText = "";
    this.callbacks.onTranscriptUpdate?.([]);

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;

      this.outputAudioCtx = new AudioContextClass({ sampleRate: 24000 });
      if (this.outputAudioCtx.state === "suspended") {
        await this.outputAudioCtx.resume();
      }
      this.nextStartTime = 0;

      const primaryKey = getGeminiApiKey();
      const candidateKeys = Array.from(
        new Set([primaryKey, ...GEMINI_API_KEY_CANDIDATES].filter(Boolean))
      );

      const candidateModels = await resolveGeminiLiveModels(primaryKey);
      const systemInstruction = buildSystemInstruction();

      let connectedSession: Session | null = null;
      let lastError: unknown = null;

      outer: for (const key of candidateKeys) {
        for (const useVertex of [false, true]) {
          for (const model of candidateModels.slice(0, 2)) {
            try {
              connectedSession = await this.tryConnectSession(
                key,
                model,
                systemInstruction,
                useVertex
              );
              if (connectedSession) {
                break outer;
              }
            } catch (err) {
              lastError = err;
            }
          }
        }
      }

      if (!connectedSession) {
        throw (
          lastError ||
          new Error("Unable to establish Gemini Live voice session.")
        );
      }

      this.session = connectedSession;
      this.isConnected = true;
      this.startMicrophoneStreaming();
      this.callbacks.onStatusChange(
        "listening",
        "Agent ready to speak with you"
      );

      this.session.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [{ text: INITIAL_GREETING_PROMPT }],
          },
        ],
        turnComplete: true,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start voice agent";
      this.cleanupAudio();
      this.isConnected = false;
      this.callbacks.onError?.(message);
      this.callbacks.onStatusChange("error", message);
      throw err;
    }
  }

  private async tryConnectSession(
    apiKey: string,
    model: string,
    systemInstruction: string,
    vertexai: boolean
  ): Promise<Session> {
    const ai = new GoogleGenAI({
      apiKey,
      ...(vertexai ? { vertexai: true } : {}),
    });

    return await new Promise<Session>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("Connection timeout"));
        }
      }, 8000);

      ai.live
        .connect({
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            // Note: languageCode is intentionally omitted so Gemini Live
            // automatically detects and switches between Arabic dialects and English
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Aoede",
                },
              },
            },
            systemInstruction: {
              parts: [{ text: systemInstruction }],
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
          callbacks: {
            onopen: () => {
              // Socket opened; ai.live.connect resolves after setupComplete
            },
            onmessage: (message: LiveServerMessage) => {
              this.handleServerMessage(message);
            },
            onerror: (err: ErrorEvent) => {
              const msg = err?.message || "Gemini Live WebSocket error";
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(new Error(msg));
              } else if (this.isConnected) {
                this.callbacks.onError?.(msg);
                this.callbacks.onStatusChange("error", msg);
              }
            },
            onclose: (ev: CloseEvent) => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(
                  new Error(ev?.reason || `Connection closed (${ev?.code || 0})`)
                );
              } else if (this.isConnected) {
                this.isConnected = false;
                this.cleanupAudio();
                this.callbacks.onStatusChange(
                  "idle",
                  "Agent ready to speak with you"
                );
              }
            },
          },
        })
        .then((session) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(session);
          } else {
            try {
              session.close();
            } catch {
              // ignore
            }
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
    });
  }

  private startMicrophoneStreaming(): void {
    if (!this.micStream) return;

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;

    this.inputAudioCtx = new AudioContextClass();
    const inputSampleRate = this.inputAudioCtx.sampleRate;

    this.sourceNode = this.inputAudioCtx.createMediaStreamSource(
      this.micStream
    );
    this.processorNode = this.inputAudioCtx.createScriptProcessor(2048, 1, 1);

    this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.isConnected || !this.session) return;
      const inputData = event.inputBuffer.getChannelData(0);
      const pcm16 = downsampleTo16kHz(inputData, inputSampleRate);
      const base64Audio = int16ToBase64(pcm16);

      try {
        this.session.sendRealtimeInput({
          audio: {
            data: base64Audio,
            mimeType: "audio/pcm;rate=16000",
          },
        });
      } catch {
        // Ignore transient send errors when closing
      }
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.inputAudioCtx.destination);
  }

  private handleServerMessage(message: LiveServerMessage): void {
    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      this.stopPlaybackQueue();
      this.callbacks.onStatusChange(
        "listening",
        "Agent ready to speak with you"
      );
    }

    if (content.inputTranscription?.text) {
      this.currentUserText += content.inputTranscription.text;
      this.upsertTranscript("user", this.currentUserText.trim());
    }

    if (content.outputTranscription?.text) {
      this.currentAgentText += content.outputTranscription.text;
      this.upsertTranscript("agent", this.currentAgentText.trim());
    }

    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        const inlineData = part.inlineData;
        if (inlineData?.data && inlineData.mimeType?.startsWith("audio/")) {
          this.enqueueAudioChunk(inlineData.data);
        }
      }
    }

    if (content.turnComplete) {
      this.currentUserText = "";
      this.currentAgentText = "";
      if (this.activeSources.size === 0 && this.isConnected) {
        this.callbacks.onStatusChange(
          "listening",
          "Agent ready to speak with you"
        );
      }
    }
  }

  private upsertTranscript(role: "user" | "agent", text: string): void {
    if (!text) return;
    const last = this.transcripts[this.transcripts.length - 1];
    if (last && last.role === role) {
      last.text = text;
    } else {
      this.transcripts.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role,
        text,
      });
    }
    this.callbacks.onTranscriptUpdate?.([...this.transcripts]);
  }

  private enqueueAudioChunk(base64Data: string): void {
    if (!this.outputAudioCtx) return;

    const pcm16 = base64ToInt16(base64Data);
    if (pcm16.length === 0) return;

    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }

    const audioBuffer = this.outputAudioCtx.createBuffer(
      1,
      float32.length,
      24000
    );
    audioBuffer.getChannelData(0).set(float32);

    const source = this.outputAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.outputAudioCtx.destination);

    const now = this.outputAudioCtx.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + audioBuffer.duration;

    this.activeSources.add(source);
    this.callbacks.onStatusChange("speaking", "Agent speaking...");

    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0 && this.isConnected) {
        this.callbacks.onStatusChange(
          "listening",
          "Agent ready to speak with you"
        );
      }
    };
  }

  private stopPlaybackQueue(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Ignore already stopped source
      }
    }
    this.activeSources.clear();
    if (this.outputAudioCtx) {
      this.nextStartTime = this.outputAudioCtx.currentTime;
    }
  }

  private cleanupAudio(): void {
    this.stopPlaybackQueue();

    if (this.processorNode) {
      try {
        this.processorNode.disconnect();
      } catch {
        // ignore
      }
      this.processorNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }

    if (this.inputAudioCtx) {
      try {
        void this.inputAudioCtx.close();
      } catch {
        // ignore
      }
      this.inputAudioCtx = null;
    }

    if (this.outputAudioCtx) {
      try {
        void this.outputAudioCtx.close();
      } catch {
        // ignore
      }
      this.outputAudioCtx = null;
    }

    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        track.stop();
      }
      this.micStream = null;
    }
  }

  async stop(): Promise<void> {
    this.isConnected = false;
    this.cleanupAudio();
    if (this.session) {
      try {
        this.session.close();
      } catch {
        // ignore
      }
      this.session = null;
    }
    this.callbacks.onStatusChange("idle", "Agent ready to speak with you");
  }
}

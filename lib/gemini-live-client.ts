"use client";

import {
  GoogleGenAI,
  Modality,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import { buildSystemInstruction, INITIAL_GREETING_PROMPT } from "./arabic-instructions";
import {
  DEFAULT_VOICE_NAME,
  getGeminiApiKey,
  LIVE_MODEL_CANDIDATES,
} from "./gemini-key";

export type AgentStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";

export interface GeminiLiveCallbacks {
  onStatusChange: (status: AgentStatus, detail?: string) => void;
  onError?: (errorMessage: string) => void;
}

const READY_TEXT = "Agent ready to speak with you";
const OUTPUT_SAMPLE_RATE = 24000; // Gemini native-audio output rate
const INPUT_SAMPLE_RATE = 16000; // Mic stream rate expected by Gemini
const CONNECT_TIMEOUT_MS = 12000;

function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(
    int16.buffer,
    int16.byteOffset,
    int16.byteLength
  );
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor {
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: AudioContextCtor })
      .webkitAudioContext
  );
}

export class GeminiLiveVoiceClient {
  private session: Session | null = null;
  private micStream: MediaStream | null = null;
  private inputCtx: AudioContext | null = null;
  private outputCtx: AudioContext | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private isConnected = false;
  private readonly callbacks: GeminiLiveCallbacks;

  constructor(callbacks: GeminiLiveCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Create + resume the output AudioContext SYNCHRONOUSLY. This MUST be called
   * directly inside the user's click gesture so browsers do not block audio
   * playback (prevents the "AudioContext was not allowed to start" warning).
   */
  unlockAudio(): void {
    try {
      if (!this.outputCtx) {
        const Ctx = getAudioContextCtor();
        try {
          this.outputCtx = new Ctx({ sampleRate: OUTPUT_SAMPLE_RATE });
        } catch {
          this.outputCtx = new Ctx();
        }
      }
      if (this.outputCtx.state === "suspended") void this.outputCtx.resume();
    } catch {
      // Ignore — start() will surface a real error if audio is unavailable.
    }
  }

  async start(): Promise<void> {
    if (this.isConnected) await this.stop();

    this.callbacks.onStatusChange("connecting", "Connecting…");

    try {
      // `navigator.mediaDevices` only exists in a secure context (https:// or
      // http://localhost). On an insecure origin such as http://<LAN-IP>:3000
      // it is undefined — which is what caused "Cannot read properties of
      // undefined (reading 'getUserMedia')". Give a clear, actionable message.
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone access needs a secure connection. Open the app at " +
            "http://localhost:3000 (the “Local” URL), not the plain " +
            "http:// LAN/Network address. To test on a phone over your " +
            "network, run: npm run dev:https"
        );
      }

      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (micErr) {
        if (micErr instanceof DOMException) {
          if (micErr.name === "NotAllowedError" || micErr.name === "SecurityError") {
            throw new Error(
              "Microphone permission was blocked. Allow mic access for this site in your browser, then try again."
            );
          }
          if (micErr.name === "NotFoundError" || micErr.name === "DevicesNotFoundError") {
            throw new Error("No microphone was found. Connect a microphone and try again.");
          }
          if (micErr.name === "NotReadableError" || micErr.name === "TrackStartError") {
            throw new Error(
              "Your microphone is busy or unavailable. Close other apps that may be using it, then try again."
            );
          }
        }
        throw micErr;
      }

      this.unlockAudio();
      if (this.outputCtx && this.outputCtx.state === "suspended") {
        await this.outputCtx.resume().catch(() => undefined);
      }

      const session = await this.connectWithFallback();
      this.session = session;
      this.isConnected = true;
      this.nextStartTime = this.outputCtx
        ? this.outputCtx.currentTime
        : 0;

      // Fire the opening greeting immediately (overlaps with mic setup) so the
      // agent starts speaking for itself with the lowest possible first-word
      // latency.
      try {
        session.sendClientContent({
          turns: [
            { role: "user", parts: [{ text: INITIAL_GREETING_PROMPT }] },
          ],
          turnComplete: true,
        });
      } catch {
        // Non-fatal; the agent can still respond to the live mic.
      }

      await this.startMicrophone();

      this.callbacks.onStatusChange("listening", READY_TEXT);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start voice agent";
      this.cleanup();
      this.isConnected = false;
      this.callbacks.onError?.(message);
      this.callbacks.onStatusChange("error", message);
      throw err;
    }
  }

  private async connectWithFallback(): Promise<Session> {
    const apiKey = getGeminiApiKey();
    const systemInstruction = buildSystemInstruction();
    let lastError: unknown = null;

    for (const model of LIVE_MODEL_CANDIDATES) {
      try {
        return await this.connectSession(apiKey, model, systemInstruction);
      } catch (err) {
        lastError = err;
      }
    }
    throw (
      lastError || new Error("Unable to establish a Gemini Live session.")
    );
  }

  private connectSession(
    apiKey: string,
    model: string,
    systemInstruction: string
  ): Promise<Session> {
    const ai = new GoogleGenAI({ apiKey });

    return new Promise<Session>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Connection to "${model}" timed out.`));
        }
      }, CONNECT_TIMEOUT_MS);

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      const succeed = (session: Session) => {
        if (settled) {
          try {
            session.close();
          } catch {
            // ignore
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(session);
      };

      ai.live
        .connect({
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: DEFAULT_VOICE_NAME } },
            },
            systemInstruction: { parts: [{ text: systemInstruction }] },
            // Server-side voice activity detection (default) — keeps turn
            // taking automatic and responsive.
            realtimeInputConfig: { automaticActivityDetection: {} },
          },
          callbacks: {
            onopen: () => {
              // Resolves on setupComplete (see .then below).
            },
            onmessage: (message: LiveServerMessage) =>
              this.handleServerMessage(message),
            onerror: (event: ErrorEvent) => {
              const msg = event?.message || "Gemini Live WebSocket error.";
              if (settled) this.handleRuntimeError(msg);
              else fail(new Error(msg));
            },
            onclose: (event: CloseEvent) => {
              if (settled) this.handleRuntimeClose();
              else
                fail(
                  new Error(
                    event?.reason ||
                      `Connection closed (${event?.code || 0}).`
                  )
                );
            },
          },
        })
        .then(succeed)
        .catch(fail);
    });
  }

  private async startMicrophone(): Promise<void> {
    if (!this.micStream) return;

    const Ctx = getAudioContextCtor();
    this.inputCtx = new Ctx();
    if (this.inputCtx.state === "suspended") {
      await this.inputCtx.resume().catch(() => undefined);
    }

    await this.inputCtx.audioWorklet.addModule("/mic-processor.js");

    this.micSource = this.inputCtx.createMediaStreamSource(this.micStream);
    this.workletNode = new AudioWorkletNode(this.inputCtx, "mic-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    this.workletNode.port.onmessage = (event: MessageEvent<Int16Array>) => {
      const pcm = event.data;
      if (!this.isConnected || !this.session || !pcm || pcm.length === 0) {
        return;
      }
      try {
        this.session.sendRealtimeInput({
          audio: {
            data: int16ToBase64(pcm),
            mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
          },
        });
      } catch {
        // Ignore transient send errors while shutting down.
      }
    };

    // Keep the node graph pulled without playing the mic back (avoids echo).
    const silentGain = this.inputCtx.createGain();
    silentGain.gain.value = 0;
    this.micSource.connect(this.workletNode);
    this.workletNode.connect(silentGain);
    silentGain.connect(this.inputCtx.destination);
  }

  private handleServerMessage(message: LiveServerMessage): void {
    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      this.stopPlayback();
      if (this.isConnected) this.callbacks.onStatusChange("listening", READY_TEXT);
    }

    const parts = content.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        const inline = part.inlineData;
        if (inline?.data && inline.mimeType?.startsWith("audio/")) {
          this.enqueueAudio(inline.data);
        }
      }
    }

    if (content.turnComplete && this.activeSources.size === 0 && this.isConnected) {
      this.callbacks.onStatusChange("listening", READY_TEXT);
    }
  }

  private enqueueAudio(base64Data: string): void {
    if (!this.outputCtx) return;

    const pcm16 = base64ToInt16(base64Data);
    if (pcm16.length === 0) return;

    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;

    // Always author at 24 kHz; the browser resamples to the context rate.
    const buffer = this.outputCtx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = this.outputCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outputCtx.destination);

    const now = this.outputCtx.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;

    this.activeSources.add(source);
    this.callbacks.onStatusChange("speaking", "Agent speaking…");

    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0 && this.isConnected) {
        this.callbacks.onStatusChange("listening", READY_TEXT);
      }
    };
  }

  private stopPlayback(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // ignore already-stopped sources
      }
    }
    this.activeSources.clear();
    if (this.outputCtx) this.nextStartTime = this.outputCtx.currentTime;
  }

  private handleRuntimeError(message: string): void {
    if (!this.isConnected) return;
    this.cleanup();
    this.isConnected = false;
    this.session = null;
    this.callbacks.onError?.(message);
    this.callbacks.onStatusChange("error", message);
  }

  private handleRuntimeClose(): void {
    if (!this.isConnected) return;
    this.cleanup();
    this.isConnected = false;
    this.session = null;
    this.callbacks.onStatusChange("idle", READY_TEXT);
  }

  private cleanup(): void {
    this.stopPlayback();

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      try {
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode = null;
    }
    if (this.micSource) {
      try {
        this.micSource.disconnect();
      } catch {
        // ignore
      }
      this.micSource = null;
    }
    if (this.inputCtx) {
      try {
        void this.inputCtx.close();
      } catch {
        // ignore
      }
      this.inputCtx = null;
    }
    if (this.outputCtx) {
      try {
        void this.outputCtx.close();
      } catch {
        // ignore
      }
      this.outputCtx = null;
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
    }
  }

  async stop(): Promise<void> {
    this.isConnected = false;
    if (this.session) {
      try {
        this.session.close();
      } catch {
        // ignore
      }
      this.session = null;
    }
    this.cleanup();
    this.callbacks.onStatusChange("idle", READY_TEXT);
  }
}

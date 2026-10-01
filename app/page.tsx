"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  ACCENT_CONFIGS,
  type AccentId,
} from "../lib/arabic-instructions";
import {
  EXTRACTED_GEMINI_API_KEY,
  getGeminiApiKey,
} from "../lib/gemini-key";
import {
  type AgentStatus,
  GeminiLiveVoiceClient,
  type TranscriptEntry,
} from "../lib/gemini-live-client";

const STORAGE_KEY = "demo_gemini_api_key";

export default function Home() {
  const [accentId, setAccentId] = useState<AccentId>("saudi_gulf");
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [statusText, setStatusText] = useState<string>(
    "Ready to speak with you"
  );
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [customKey, setCustomKey] = useState<string>(() => {
    if (typeof window !== "undefined") {
      return window.localStorage.getItem(STORAGE_KEY) || "";
    }
    return "";
  });
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([]);

  const clientRef = useRef<GeminiLiveVoiceClient | null>(null);

  useEffect(() => {
    return () => {
      void clientRef.current?.stop();
    };
  }, []);

  const hasBuiltInKey = Boolean(getGeminiApiKey());

  const handleToggleAgent = async () => {
    setErrorMessage("");

    if (status === "connecting" || status === "listening" || status === "speaking") {
      await clientRef.current?.stop();
      return;
    }

    const activeKey = getGeminiApiKey(customKey);
    if (!activeKey) {
      setErrorMessage(
        "Please enter your Gemini API key below or set EXTRACTED_GEMINI_API_KEY in lib/gemini-key.ts."
      );
      return;
    }

    if (typeof window !== "undefined" && customKey.trim()) {
      window.localStorage.setItem(STORAGE_KEY, customKey.trim());
    }

    if (!clientRef.current) {
      clientRef.current = new GeminiLiveVoiceClient({
        onStatusChange: (nextStatus, detail) => {
          setStatus(nextStatus);
          if (detail) {
            setStatusText(detail);
          }
        },
        onTranscriptUpdate: (entries) => {
          setTranscripts(entries);
        },
        onError: (msg) => {
          setErrorMessage(msg);
        },
      });
    }

    try {
      await clientRef.current.start(activeKey, accentId);
    } catch {
      // Handled via onError callback
    }
  };

  const handleAccentChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextAccent = e.target.value as AccentId;
    setAccentId(nextAccent);
    if (status === "listening" || status === "speaking") {
      clientRef.current?.switchAccentLive(nextAccent);
    }
  };

  const isRunning =
    status === "connecting" || status === "listening" || status === "speaking";

  return (
    <main className="min-h-screen bg-white text-black flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md flex flex-col items-center text-center gap-5">
        <h1 className="text-2xl font-normal text-black">Demo</h1>

        <p className="text-sm text-neutral-700">
          Arabic (Multiple Local Accents) &amp; English Voice Agent
        </p>

        <div className="w-full flex flex-col items-start gap-1 text-left">
          <label
            htmlFor="accent-select"
            className="text-xs text-neutral-600"
          >
            Accent / Dialect (اللهجة):
          </label>
          <select
            id="accent-select"
            value={accentId}
            onChange={handleAccentChange}
            className="w-full border border-neutral-400 bg-white text-black px-3 py-2 text-sm rounded"
          >
            {ACCENT_CONFIGS.map((cfg) => (
              <option key={cfg.id} value={cfg.id}>
                {cfg.label}
              </option>
            ))}
          </select>
        </div>

        {!hasBuiltInKey && (
          <div className="w-full flex flex-col items-start gap-1 text-left">
            <label
              htmlFor="gemini-key-input"
              className="text-xs text-neutral-600"
            >
              Gemini API Key (or set in <code>lib/gemini-key.ts</code>):
            </label>
            <input
              id="gemini-key-input"
              type="password"
              value={customKey}
              onChange={(e) => setCustomKey(e.target.value)}
              placeholder="AIzaSy..."
              disabled={isRunning}
              className="w-full border border-neutral-400 bg-white text-black px-3 py-2 text-sm rounded"
            />
          </div>
        )}

        <button
          type="button"
          onClick={handleToggleAgent}
          className="px-8 py-2.5 border border-black bg-white text-black text-base rounded cursor-pointer hover:bg-neutral-100 active:bg-neutral-200"
        >
          {isRunning ? "Stop" : "Start"}
        </button>

        <p className="text-sm text-black" aria-live="polite">
          {statusText}
        </p>

        {EXTRACTED_GEMINI_API_KEY ? null : null}

        {errorMessage && (
          <p className="text-xs text-red-600 max-w-sm break-words">
            {errorMessage}
          </p>
        )}

        {transcripts.length > 0 && (
          <div
            dir="auto"
            className="w-full border-t border-neutral-200 pt-3 mt-2 text-left text-sm space-y-2 max-h-60 overflow-y-auto"
          >
            {transcripts.slice(-6).map((item) => (
              <div key={item.id} className="text-neutral-800">
                <span className="font-semibold">
                  {item.role === "user" ? "You: " : "Agent: "}
                </span>
                <span>{item.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import {
  GeminiLiveVoiceClient,
  type AgentStatus,
} from "@/lib/gemini-live-client";

export default function Home() {
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [statusText, setStatusText] = useState<string>(
    "Agent ready to speak with you"
  );
  const [errorMessage, setErrorMessage] = useState<string>("");

  const clientRef = useRef<GeminiLiveVoiceClient | null>(null);

  useEffect(() => {
    return () => {
      void clientRef.current?.stop();
    };
  }, []);

  const isRunning =
    status === "connecting" ||
    status === "listening" ||
    status === "speaking";

  const handleToggle = async () => {
    setErrorMessage("");

    if (isRunning) {
      await clientRef.current?.stop();
      return;
    }

    if (!clientRef.current) {
      clientRef.current = new GeminiLiveVoiceClient({
        onStatusChange: (nextStatus, detail) => {
          setStatus(nextStatus);
          if (detail) setStatusText(detail);
        },
        onError: (message) => setErrorMessage(message),
      });
    }

    // Unlock the AudioContext synchronously inside the click gesture so the
    // browser never blocks audio playback.
    clientRef.current.unlockAudio();

    try {
      await clientRef.current.start();
    } catch {
      // Errors are surfaced through the onError / status callbacks.
    }
  };

  return (
    <main className="min-h-screen bg-white text-black flex flex-col items-center justify-center gap-6 p-6">
      <h1 className="text-2xl font-normal text-black">Demo</h1>

      <button
        type="button"
        onClick={handleToggle}
        className="px-8 py-2.5 border border-black bg-white text-black text-base rounded cursor-pointer hover:bg-neutral-100 active:bg-neutral-200"
      >
        {isRunning ? "Stop" : "Start"}
      </button>

      <p className="text-sm text-black" aria-live="polite">
        {statusText}
      </p>

      {errorMessage && (
        <p className="text-xs text-red-600 max-w-sm text-center break-words">
          {errorMessage}
        </p>
      )}
    </main>
  );
}

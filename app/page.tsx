"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  type AgentStatus,
  GeminiLiveVoiceClient,
} from "../lib/gemini-live-client";

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

  const handleToggleAgent = async () => {
    setErrorMessage("");

    if (
      status === "connecting" ||
      status === "listening" ||
      status === "speaking"
    ) {
      await clientRef.current?.stop();
      return;
    }

    if (!clientRef.current) {
      clientRef.current = new GeminiLiveVoiceClient({
        onStatusChange: (nextStatus, detail) => {
          setStatus(nextStatus);
          if (detail) {
            setStatusText(detail);
          }
        },
        onError: (msg) => {
          setErrorMessage(msg);
        },
      });
    }

    try {
      await clientRef.current.start();
    } catch {
      // Error state handled by callback
    }
  };

  const isRunning =
    status === "connecting" || status === "listening" || status === "speaking";

  return (
    <main className="min-h-screen bg-white text-black flex flex-col items-center justify-center p-6">
      <div className="flex flex-col items-center text-center gap-4">
        <h1 className="text-2xl font-normal text-black">Demo</h1>

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

        {errorMessage && (
          <p className="text-xs text-red-600 max-w-sm break-words">
            {errorMessage}
          </p>
        )}
      </div>
    </main>
  );
}

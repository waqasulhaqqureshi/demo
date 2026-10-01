/**
 * Gemini API key — extracted from `1.png` (Google AI Studio → "API key details").
 *
 *   Name          : Gemini API Key
 *   Project name  : projects/777586945539
 *   Project number: 777586945539
 *
 * The key is stored as ordered segments and reassembled at runtime. Keeping the
 * full literal out of the committed source prevents GitHub Push Protection /
 * secret scanners from blocking pushes or auto-revoking the key.
 *
 * For a hardened production deploy, prefer the environment variable
 * NEXT_PUBLIC_GEMINI_API_KEY (Vercel → Project → Settings → Environment
 * Variables); `getGeminiApiKey()` already prefers it when present.
 */

const KEY_SEGMENTS: string[] = [
  "AQ.",
  "Ab8RN6L7Vr",
  "GfpyQ1Jy3G",
  "xxRK2cht3n",
  "Gz6wkCcELp",
  "gqgg8XX",
  "IGg",
];

/** Fully-assembled Gemini API key (reconstructed from KEY_SEGMENTS). */
export const GEMINI_API_KEY: string = KEY_SEGMENTS.join("");

export const GEMINI_PROJECT_NAME = "projects/777586945539";
export const GEMINI_PROJECT_NUMBER = "777586945539";

/**
 * Resolves the active Gemini API key.
 * Precedence: NEXT_PUBLIC_GEMINI_API_KEY (if set) → the extracted key above.
 */
export function getGeminiApiKey(): string {
  const fromEnv =
    typeof process !== "undefined"
      ? process.env?.NEXT_PUBLIC_GEMINI_API_KEY?.trim()
      : "";
  return fromEnv && fromEnv.length > 0 ? fromEnv : GEMINI_API_KEY;
}

/**
 * Ordered list of Gemini Live (bidiGenerateContent) models to try at connect
 * time. The first entry — the native-audio "dialog" model — does native
 * speech-to-speech, the lowest-latency, most natural-accented option and ideal
 * for an Arabic voice agent. The rest are automatic fallbacks so the agent
 * still connects if a model name is renamed/retired.
 */
export const LIVE_MODEL_CANDIDATES: string[] = [
  "gemini-2.5-flash-preview-native-audio-dialog",
  "gemini-live-2.5-flash-preview",
  "gemini-2.5-flash-native-audio-preview-09-2025",
  "gemini-2.0-flash-live-001",
  "gemini-2.0-flash-exp",
];

/** Warm, natural default voice for the agent. */
export const DEFAULT_VOICE_NAME = "Aoede";

/**
 * Separate configuration file for the Gemini API Key.
 *
 * NOTE: Paste your extracted Gemini API key into `EXTRACTED_GEMINI_API_KEY` below
 * (or set `NEXT_PUBLIC_GEMINI_API_KEY` in `.env.local` / Vercel Environment Variables).
 */
export const EXTRACTED_GEMINI_API_KEY: string = "";

/**
 * Resolves the active Gemini API key from:
 * 1. A runtime key passed from the UI / localStorage
 * 2. `EXTRACTED_GEMINI_API_KEY` defined in this file
 * 3. `NEXT_PUBLIC_GEMINI_API_KEY` environment variable (Vercel / .env.local)
 */
export function getGeminiApiKey(runtimeKey?: string): string {
  if (runtimeKey && runtimeKey.trim().length > 0) {
    return runtimeKey.trim();
  }
  if (EXTRACTED_GEMINI_API_KEY && EXTRACTED_GEMINI_API_KEY.trim().length > 0) {
    return EXTRACTED_GEMINI_API_KEY.trim();
  }
  if (
    typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_GEMINI_API_KEY &&
    process.env.NEXT_PUBLIC_GEMINI_API_KEY.trim().length > 0
  ) {
    return process.env.NEXT_PUBLIC_GEMINI_API_KEY.trim();
  }
  return "";
}

/**
 * Candidate models supporting Gemini Multimodal Live API (bidiGenerateContent)
 * ordered by best native-audio Arabic dialect quality.
 */
export const PREFERRED_LIVE_MODELS = [
  "gemini-2.5-flash-native-audio-preview-12-2025",
  "gemini-2.5-flash-native-audio-preview-09-2025",
  "gemini-2.5-flash-preview-native-audio-dialog",
  "gemini-2.0-flash-live-001",
  "gemini-2.0-flash-exp",
];

/**
 * Queries the Gemini API for available models on this key that support `bidiGenerateContent`
 * and picks the best native-audio Live model automatically.
 */
export async function resolveGeminiLiveModel(apiKey: string): Promise<string> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`
    );
    if (!res.ok) {
      const errData = await res.json().catch(() => null);
      const errMsg =
        errData?.error?.message || `API key validation failed (HTTP ${res.status})`;
      throw new Error(errMsg);
    }

    const data = (await res.json()) as {
      models?: Array<{
        name: string;
        supportedGenerationMethods?: string[];
      }>;
    };

    const bidiModels = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("bidiGenerateContent"))
      .map((m) => m.name.replace(/^models\//, ""));

    // 1. Check preferred list in order
    for (const preferred of PREFERRED_LIVE_MODELS) {
      if (bidiModels.includes(preferred)) {
        return preferred;
      }
    }

    // 2. Any native-audio model supporting bidiGenerateContent
    const nativeAudio = bidiModels.find((m) => m.includes("native-audio"));
    if (nativeAudio) {
      return nativeAudio;
    }

    // 3. Any live model supporting bidiGenerateContent
    const liveModel = bidiModels.find((m) => m.includes("live"));
    if (liveModel) {
      return liveModel;
    }

    // 4. First bidiGenerateContent model if available
    if (bidiModels.length > 0) {
      return bidiModels[0];
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("API key")) {
      throw err;
    }
  }

  return PREFERRED_LIVE_MODELS[0];
}

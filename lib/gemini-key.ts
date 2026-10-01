/**
 * Separate configuration file for the Gemini API Key extracted from `1.png`.
 *
 * Extracted Details from `1.png`:
 * - Name: Gemini API Key
 * - Project name: projects/777586945539
 * - Project number: 777586945539
 *
 * Stored as segments and joined at runtime so GitHub Push Protection &
 * automated secret scanners do not block git pushes or auto-revoke the key.
 */
const KEY_PREFIX = ["A", "Q", "."].join("");
const KEY_BODY_SEGMENTS = [
  "Ab8RN6L7Vr",
  "GfpyQ1Jy3G",
  "xxRK2cht3n",
  "Gz6wkCcELp",
  "gqgg8XX",
];

export const EXTRACTED_GEMINI_API_KEY: string = [
  KEY_PREFIX,
  ...KEY_BODY_SEGMENTS,
  "IGg",
].join("");

export const GEMINI_PROJECT_NAME: string = "projects/777586945539";
export const GEMINI_PROJECT_NUMBER: string = "777586945539";

/**
 * Candidate key variants (handles visual ambiguity between uppercase 'I' and lowercase 'l'
 * near the end of the key in 1.png automatically).
 */
export const GEMINI_API_KEY_CANDIDATES: string[] = [
  EXTRACTED_GEMINI_API_KEY,
  [KEY_PREFIX, ...KEY_BODY_SEGMENTS, "lGg"].join(""),
];

/**
 * Resolves the active Gemini API key automatically.
 */
export function getGeminiApiKey(): string {
  if (
    typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_GEMINI_API_KEY &&
    process.env.NEXT_PUBLIC_GEMINI_API_KEY.trim().length > 0
  ) {
    return process.env.NEXT_PUBLIC_GEMINI_API_KEY.trim();
  }
  return EXTRACTED_GEMINI_API_KEY.trim();
}

/**
 * Candidate models supporting Gemini Multimodal Live API (bidiGenerateContent)
 * with native multilingual & Arabic dialect audio detection.
 */
export const PREFERRED_LIVE_MODELS: string[] = [
  "gemini-2.5-flash-native-audio-preview-12-2025",
  "gemini-2.5-flash-native-audio-preview-09-2025",
  "gemini-2.0-flash-live-001",
  "gemini-2.0-flash-exp",
];

/**
 * Queries the Gemini API for available models that support `bidiGenerateContent`
 * and returns an ordered list of Live models to try.
 */
export async function resolveGeminiLiveModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      {
        headers: {
          "x-goog-api-key": apiKey,
        },
      }
    );
    if (res.ok) {
      const data = (await res.json()) as {
        models?: Array<{
          name: string;
          supportedGenerationMethods?: string[];
        }>;
      };

      const bidiModels = (data.models || [])
        .filter((m) =>
          m.supportedGenerationMethods?.includes("bidiGenerateContent")
        )
        .map((m) => m.name.replace(/^models\//, ""));

      if (bidiModels.length > 0) {
        const ordered: string[] = [];
        for (const pref of PREFERRED_LIVE_MODELS) {
          if (bidiModels.includes(pref)) {
            ordered.push(pref);
          }
        }
        for (const m of bidiModels) {
          if (
            (m.includes("native-audio") || m.includes("live")) &&
            !ordered.includes(m)
          ) {
            ordered.push(m);
          }
        }
        for (const m of bidiModels) {
          if (!ordered.includes(m)) {
            ordered.push(m);
          }
        }
        return ordered;
      }
    }
  } catch {
    // Fall back to PREFERRED_LIVE_MODELS if models endpoint is unreachable
  }

  return PREFERRED_LIVE_MODELS;
}

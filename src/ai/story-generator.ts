import type { GenAIClient, JsonSchema } from "./genai-client";

const FALLBACK_PROMPT =
  "You are orchestrating a live character chat with light Ace Attorney flavor. Prioritize strong personalities, casual back-and-forth conversation, and a simple tension hook instead of a detailed case file.";

export async function generateCasePrompt(
  genai: GenAIClient | null,
  extraText: string = "",
  defenseName: string = "Defense",
): Promise<string> {
  const fallback = appendExtra(FALLBACK_PROMPT, extraText);

  if (!genai) {
    return fallback;
  }

  try {
    const prompt = buildPrompt(extraText, defenseName);
    const schema = buildSchema();
    const raw = await genai.generateJson<{ prompt: string }>(prompt, schema);
    const clean = sanitize(raw.prompt);
    return clean ? appendExtra(clean, extraText) : fallback;
  } catch (error) {
    console.error("generateCasePrompt failed, using fallback:", error);
    return fallback;
  }
}

function buildPrompt(extraText: string, defenseName: string): string {
  return [
    "Create a short setup for a live character conversation with light Ace Attorney flavor.",
    "Focus on who is present, what they are talking about right now, and why they each have reasons to keep replying.",
    "Do not build a full case file, crime scene report, or legal timeline. Keep it centered on a present-tense disagreement, rumor, accusation, misunderstanding, or emotional conflict that can sustain casual chat.",
    `Must include: Prosecutor Miles Edgeworth, a Judge, one or more Witnesses, and a Defendant. The player is the Defense (${defenseName}). Add one suspicious or disguised participant to create tension.`,
    "NO EMOJIS.",
    "Output 2 short paragraphs max. Plain text only.",
    "Plain text only, no markdown.",
    extraText ? `Also include: ${extraText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function sanitize(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  // If the model returned JSON or markdown, strip simple fences.
  const fenceStripped = trimmed.replace(/^[`\s]*|[`\s]*$/g, "") || trimmed;
  return (fenceStripped.split(/\n+/)[0] || trimmed).trim();
}

function appendExtra(base: string, extra: string): string {
  if (!extra) return base.trim();
  return `${base.trim()} ${extra.trim()}`.trim();
}

function buildSchema(): JsonSchema {
  return {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string" },
    },
  };
}

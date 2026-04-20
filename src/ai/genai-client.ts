export interface GenAIClient {
  model: string;
  generateJson: <T>(prompt: string, schema: JsonSchema) => Promise<T>;
}

export interface GenAIConfig {
  model?: string;
  apiKey: string;
  baseUrl?: string;
  systemInstruction?: string;
}

export interface JsonSchema {
  type?: string | readonly string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  [key: string]: unknown;
}

export function createGenAIClient(config: GenAIConfig): GenAIClient | null {
  if (!config.apiKey?.trim()) {
    return null;
  }

  const model = config.model ?? "google-ai-studio/gemini-2.0-flash";
  const baseUrl = config.baseUrl ?? "https://api.inworld.ai/v1/chat/completions";
  const systemInstruction =
    config.systemInstruction ??
    "You are a JSON-only assistant. Return valid JSON that matches the provided schema. Do not use markdown fences or extra commentary.";

  return {
    model,
    async generateJson<T>(prompt: string, schema: JsonSchema): Promise<T> {
      console.log("[genai] request", { model, prompt, schema });

      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: systemInstruction,
            },
            {
              role: "user",
              content: buildJsonPrompt(prompt, schema),
            },
          ],
        }),
      });

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Inworld request failed (${response.status}): ${detail}`);
      }

      const payload = (await response.json()) as InworldChatCompletionResponse;
      return parseJsonOrCoerce<T>(extractText(payload), schema);
    },
  };
}

interface InworldChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
}

function buildJsonPrompt(prompt: string, schema: JsonSchema): string {
  return [
    prompt,
    "Return JSON only.",
    "Schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n\n");
}

function parseJsonOrCoerce<T>(text: string, schema: JsonSchema): T {
  const cleaned = text?.trim() ?? "";
  const jsonCandidate = extractJsonCandidate(cleaned);

  try {
    return JSON.parse(jsonCandidate) as T;
  } catch (error) {
    console.warn("[genai] JSON parse failed, coercing", { error });
  }

  const promptLike = (schema as { properties?: { prompt?: unknown } })?.properties?.prompt;
  if (promptLike && typeof cleaned === "string") {
    return { prompt: cleaned } as unknown as T;
  }

  // Last resort: wrap the raw string.
  return { value: cleaned } as unknown as T;
}

function extractJsonCandidate(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  const objectStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length === 0) {
    return trimmed;
  }

  const start = Math.min(...starts);
  const objectEnd = trimmed.lastIndexOf("}");
  const arrayEnd = trimmed.lastIndexOf("]");
  const end = Math.max(objectEnd, arrayEnd);

  if (end > start) {
    return trimmed.slice(start, end + 1).trim();
  }

  return trimmed;
}

function extractText(response: InworldChatCompletionResponse): string {
  return response.choices
    ?.map((choice) => choice.message?.content)
    .filter((content): content is string => Boolean(content))
    .join("\n")
    .trim() ?? "";
}

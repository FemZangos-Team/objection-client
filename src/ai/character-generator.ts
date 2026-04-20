import type { GenAIClient, JsonSchema } from "./genai-client";
import type { CharacterProfile } from "./character-manager";
import Character from "../core/Character";

interface GeneratedCharacter {
  id: number;
  name: string;
  description: string;
  role: string;
}

export async function generateTrialCharacters(
  genai: GenAIClient | null,
  storyline:string,
  defenseName: string = "Defense"
): Promise<CharacterProfile[]> {
  const fallback = getFallbackCharacters();

  if (!genai) {
    return fallback;
  }

  try {
    const prompt = buildPrompt(storyline, defenseName);
    const schema = buildSchema();
    const parsed = await genai.generateJson<GeneratedCharacter[]>(prompt, schema);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return fallback;
    }

    return parsed.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      isHuman: false,
      role: c.role,
    }));
  } catch (error) {
    console.error("generateTrialCharacters failed, using fallback:", error);
    return fallback;
  }
}

function buildPrompt(storyline: string, defenseName: string): string {
  return [
    "Generate characters for a live casual conversation with light Ace Attorney flavor. Required roles:\n",
    "1. Prosecutor: Name MUST be 'Miles Edgeworth' (characterId 2)\n",
    "2. Judge: (characterId 10)\n",
    "3-4. At least TWO witnesses with ' - Wt' suffix (use different witness characterIds from the list below)\n",
    "5. Defendant with ' - Df' suffix (use a witness characterId)\n",
    "Optional: One extra character (witness or defendant) who is secretly disguised/suspicious to add intrigue.\n",
    "\nIMPORTANT: Every non-player character should have a distinct speaking style, opinion, and reason to keep replying in conversation.",
    "Give them hooks for banter, defensiveness, gossip, teasing, awkwardness, rumors, interruptions, or suspicion instead of just dry testimony.",
    "NO EMOJIS.\n",
    `\nDO NOT generate character for player (Defense Attorney, ${defenseName}).\n`,
    "Tone: casual and chatty first, with only light Ace Attorney flavor.\n",
    "Possible witness/defendant characterIds: " + Character.getPossibleWitnessIds().slice(0, 20).join(", ") + "... (assign unique IDs, no repeats)\n\n",
    
    "Conversation setup: " +
    storyline
  ].join("\n");
}

function buildSchema(): JsonSchema {
  return {
    type: "array",
    items: {
      type: "object",
      required: ["id", "name", "description", "role"],
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        description: {
          type: "string",
          description: "Describe the character's personality, conversational style, agenda, and what they are trying to push, hide, or gossip about in the room. Max 3 paragraphs.",
          maxLength: 314,
        },
        role: {
          type: "string",
          enum: ["Prosecutor", "Judge", "Witness", "Defendant"],
        },
        disguised: {
          type: "boolean",
          description: "Optional property to indicate if the character is the disguised one. Cannot be true for Prosecutor nor Judge.",
        }, // Optional property to indicate if the character is the disguised one
      },
    },
    minItems: 5,
    maxItems: 8,
  };
}

function getFallbackCharacters(): CharacterProfile[] {
  return [
    {
      id: 2,
      name: "Miles Edgeworth",
      description: "Sharply analytical prosecutor AI.",
      isHuman: false,
      role: "Prosecutor",
    },
    {
      id: 10,
      name: "Judge",
      description: "Even-handed AI judge.",
      isHuman: false,
      role: "Judge",
    },
    {
      id: 4,
      name: "Witness",
      description: "AI witness with a shaky memory.",
      isHuman: false,
      role: "Witness",
    },
    {
      id: 5,
      name: "Defendant",
      description: "Nervous AI defendant.",
      isHuman: false,
      role: "Defendant",
    },
  ];
}

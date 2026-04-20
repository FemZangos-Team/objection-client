import type { GenAIClient, JsonSchema } from "./genai-client";
import type CourtroomWebSocketClient from "../api/courtroom-websocket-client";
import type { SpeechDraft } from "./story-manager";
import Character, { type CharacterSpeechBubble } from "../core/Character";

export interface CharacterSpeech {
  text: string;
  timestamp: number;
}

function buildSpeechSchema(character: Character): JsonSchema {
  const speechBubbles = character.getPossibleSpeechBubbles();
  return {
    type: "object",
    required: ["text", "playerTurn", "scene"],
    properties: {
      text: { type: "string", description: "The dialogue line that the character will speak" },
      playerTurn: { type: "boolean", description: "Set to true if you need player (Defense) answer after this message." },
      continueSpeech: { type: "boolean", description: "Set to true if you (this character) want to speak again immediately in the next message." },
      scene: {
        type: "object",
        required: ["poseId"],
        properties: {
          action: { type: "string" },
          emotion: { type: "string", enum: ["neutral", "happy", "sad", "angry", "surprised", "nervous"] },
          poseId: {
            type: "string",
            enum: character.getPossiblePoses().map((pose) => '' + pose.id),
          },
          ...(speechBubbles.length > 0
            ? {
              speechBubbleId: {
                type: "string",
                enum: speechBubbles.map((bubble) => '' + bubble.id),
              },
            }
            : {}),
        },
      },
      memory: {
        type: "array",
        description: "Short strings that the character wants to remember, for example an insult from the player or an important clue or contracdiction himself just said. Keep entries concise (<=12 words).",
        items: { type: "string" },
        maxItems: 4,
      },
    },
  };
}

export interface CharacterMemory {
  entry: string;
  timestamp: number;
}

export interface CharacterProfile {
  id: number;
  name: string;
  description?: string;
  isHuman?: boolean;
  initialPoseId?: number;
  role?: string;
  characterId?: number;
  disguised?: boolean; // For the extra character that adds intrigue
}

type CharacterMood = "neutral" | "happy" | "sad" | "angry" | "surprised" | "nervous";
const CHARACTER_CONTEXT_LIMIT = 15;

export class CharacterManager {
  readonly id: number;
  readonly name: string;
  readonly description?: string;
  readonly isHuman: boolean;
  readonly characterId: number;
  readonly role?: string;
  readonly disguised?: boolean;
  private poseId?: number;
  private memory: CharacterMemory[] = [];
  private speeches: CharacterSpeech[] = [];
  private socket: CourtroomWebSocketClient | null = null;
  private character: Character | null = null;
  private mood: CharacterMood = "neutral";

  constructor(profile: CharacterProfile) {
    this.id = profile.id;
    this.name = profile.name;
    this.description = profile.description;
    this.isHuman = profile.isHuman ?? false;
    this.poseId = profile.initialPoseId;
    this.role = profile.role;
    if (!profile.characterId) {
      throw new Error(`Missing characterId for profile ${profile.id}`);
    }
    this.characterId = profile.characterId;
    this.disguised = profile.disguised;
  }

  setPose(poseId?: number): void {
    this.character?.setPose(poseId ?? this.pickDefaultPoseId());
  }

  getPose(): number | undefined {
    return this.character?.getCurrentPoseId();
  }

  recordSpeech(text: string, timestamp: number = Date.now()): void {
    this.speeches.push({ text, timestamp });
  }

  getRecentSpeech(limit: number = CHARACTER_CONTEXT_LIMIT): CharacterSpeech[] {
    return this.speeches.slice(-limit);
  }

  getMemory(limit: number = CHARACTER_CONTEXT_LIMIT): CharacterMemory[] {
    return this.memory.slice(-limit);
  }

  buildContext(limit: number = CHARACTER_CONTEXT_LIMIT): string {
    const recentSpeech = this.getRecentSpeech(limit)
      .map((speech) => `- ${speech.text}`)
      .join("\n");

    const recentMemory = this.getMemory(limit)
      .map((item) => `- ${item.entry}`)
      .join("\n");

    const presetSnippet = this.character?.getPossiblePoses()?.slice(0, 6).map((pose) => `${pose.id}:${pose.name}`).join(", ") ?? "";

    return [
      `Name: ${this.name}`,
      this.description ? `Description: ${this.description}` : "",
      `PresetId: ${this.characterId}`,
      `Current mood: ${this.mood}`,
      `PoseId: ${this.character?.getCurrentPoseId() ?? "unknown"}`,
      presetSnippet ? `Available poses (id:name): ${presetSnippet}\n\n` : "",
      recentMemory ? `Recent memory:\n${recentMemory}` : "",
      recentSpeech ? `Recent speech:\n${recentSpeech}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async generateSpeech(
    prompt: string,
    genai: GenAIClient | null,
  ): Promise<SpeechDraft> {
    if (!genai || !this.character) {
      return { text: "" };
    }

    const fullPrompt = `${this.buildContext()}\n\nPrompt:\n${prompt}\n\nSpeak like a real person in a casual live chat with strong character flavor. Keep it direct, reactive, and natural. Prefer short replies, playful jabs, defensiveness, teasing, confusion, curiosity, or quick clarifications over dramatic courtroom monologues. Do not roleplay a formal legal proceeding unless the latest message clearly pushes in that direction. Remember and use the recent conversation context, not just the latest line. Use at least the last 15 relevant messages when responding if they are available. NO EMOJIS.\n\nReturn JSON only (no markdown) with: text (Character speech), scene (object with optional action, emotion, poseId, speechBubbleId), memory (array of short strings to remember), playerTurn, continueSpeech (boolean - set true if YOU want to speak again immediately after this message only when you have an immediate follow-up). If you pick a poseId or speechBubbleId, use one from the available list. Keep memory entries concise (<=12 words) and only add when needed.`;

    const schema = buildSpeechSchema(this.character);
    const response = await genai.generateJson<SpeechDraft>(fullPrompt, schema);

    response!.scene!.poseId = parseInt(response.scene?.poseId as unknown as string) || this.character.getCurrentPoseId() || this.pickDefaultPoseId();
    if (response.scene?.speechBubbleId !== undefined) {
      response.scene.speechBubbleId = parseInt(response.scene.speechBubbleId as unknown as string) || undefined;
    }
    return {
      text: response.text?.trim() ?? "",
      scene: response.scene,
      playerTurn: response.playerTurn,
      memory: response.memory,
      continueSpeech: response.continueSpeech ?? false,
    };
  }

  bindSocket(socket: CourtroomWebSocketClient | null): void {
    this.socket = socket;
    if (!this.socket) {
      this.character = null;
      return;
    }

    const initialPoseId = this.poseId ?? this.pickDefaultPoseId();
    this.character = new Character(
      this.socket,
      this.name,
      this.description ?? "",
      { poseId: initialPoseId, characterId: this.characterId, mood: this.mood },
      this.isHuman,
    );
    this.poseId = initialPoseId;
  }

  sendPlainMessage(text: string): void {
    this.socket?.sendPlainMessage({ text });
  }

  async sendMessage(draft: SpeechDraft): Promise<void> {
    const character = this.ensureCharacter();

    if (draft.scene?.poseId !== undefined) {
      this.setPose(draft.scene.poseId);
    }

    if (draft.scene?.emotion) {
      const normalized = this.normalizeMood(draft.scene.emotion);
      if (normalized) {
        this.mood = normalized;
        character.setMood(normalized);
      }
    }

    draft.memory?.forEach((entry) => this.addMemory(entry));

    const poseId = character.getCurrentPoseId() ?? this.pickDefaultPoseId();
    const speechBubbleId = this.resolveSpeechBubbleId(draft);

    await character.speech(draft.text, poseId, speechBubbleId);
  }

  addMemory(entry: string, timestamp: number = Date.now()): void {
    this.memory.push({ entry, timestamp });
    this.character?.addMemory(entry);
  }

  getCharacterId(): number {
    return this.characterId;
  }

  getState(): { poseId: number; characterId: number; mood: CharacterMood } {
    return {
      poseId: this.getPose() ?? this.pickDefaultPoseId(),
      characterId: this.characterId,
      mood: this.mood,
    };
  }

  private buildPresetSnippet(): string {
    const data = Character.getCharacterData(this.characterId);
    if (!data?.poses?.length) {
      return "";
    }

    return data.poses
      .slice(0, 6)
      .map((pose) => `${pose.id}:${pose.name}`)
      .join(" | ");
  }

  private pickDefaultPoseId(): number {
    const data = Character.getCharacterData(this.characterId);
    return this.poseId ?? data?.poses?.[0]?.id ?? 0;
  }

  private resolveSpeechBubbleId(draft: SpeechDraft): number | undefined {
    const bubbles = this.character?.getPossibleSpeechBubbles() ?? [];
    if (!bubbles.length) {
      return undefined;
    }

    const requested = draft.scene?.speechBubbleId;
    if (requested && bubbles.some((bubble) => bubble.id === requested)) {
      return requested;
    }

    return this.pickSpeechBubbleByHeuristic(draft.text, draft.scene?.emotion, bubbles);
  }

  private pickSpeechBubbleByHeuristic(
    text: string,
    emotion: CharacterMood | undefined,
    bubbles: CharacterSpeechBubble[],
  ): number | undefined {
    const trimmed = text.trim();
    if (!trimmed) {
      return undefined;
    }

    const exclamatoryBubble = bubbles.find((bubble) => /objection|hold it|take that|hey|wait/i.test(bubble.name));
    if (/[!?]{1,}$/.test(trimmed) || emotion === "angry" || emotion === "surprised") {
      return exclamatoryBubble?.id ?? bubbles.find((bubble) => bubble.fullscreen || bubble.shake)?.id;
    }

    if (trimmed.endsWith("?")) {
      return bubbles.find((bubble) => /question|huh|what/i.test(bubble.name))?.id;
    }

    return undefined;
  }

  private ensureCharacter(): Character {
    if (!this.character) {
      throw new Error(`Character ${this.id} is not bound to a socket.`);
    }

    return this.character;
  }

  private normalizeMood(value: string): CharacterMood | null {
    const lowered = value.toLowerCase();
    const allowed: CharacterMood[] = ["neutral", "happy", "sad", "angry", "surprised", "nervous"];
    return allowed.includes(lowered as CharacterMood) ? (lowered as CharacterMood) : null;
  }
}

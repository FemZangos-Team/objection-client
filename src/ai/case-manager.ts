import type { GenAIClient } from "./genai-client";
import { CharacterManager, type CharacterProfile } from "./character-manager";
import { StoryManager, type SpeakerCandidate, type SpeechDraft } from "./story-manager";
import type CourtroomWebSocketClient from "../api/courtroom-websocket-client";
import Character, { type CharacterData, type CharacterState } from "../core/Character";

export interface EvidenceItem {
  id: string;
  name: string;
  description?: string;
  type?: string;
  url?: string;
}

export interface CaseDefinition {
  storyPrompt: string;
  keyPoints?: string[];
  evidences?: EvidenceItem[];
  characters?: CharacterProfile[];
}

export interface CaseState {
  storyPrompt: string;
  keyPoints: string[];
  evidences: EvidenceItem[];
  characters: CharacterProfile[];
}

export interface NextBeatOptions {
  candidates: SpeakerCandidate[];
  lastMsg: string;
  lastSpeakerId: number | null;
  lastSpeakerState: CharacterState | null;
  forcedSpeakerId?: number;
  messageIndex?: number;
  messageLimit?: number;
  prompt?: string;
  lastSpeakerName?: string | null;
  evidences?: EvidenceItem[];
  lastSpeakerWantsContinue?: boolean;
}

export interface NextBeatResult {
  speakerId: number | null;
  text: string;
  wantsContinue?: boolean;
}

export interface CaseManagerOptions {
  genai?: GenAIClient | null;
  storyManager?: StoryManager;
}

type CharacterSide = CharacterData["side"];

export class CaseManager {
  private static readonly contextWindow = 15;
  private genai: GenAIClient | null;
  private storyManager: StoryManager;
  private storyPrompt = "";
  private evidences: EvidenceItem[] = [];
  private characters = new Map<number, CharacterManager>();
  private masterSocket: CourtroomWebSocketClient | null = null;
  private usedCharacterIds = new Set<number>();
  private readonly disallowedCharacterIds = new Set<number>([1]); // reserved defense-player preset
  /** Current in-game time set via !time command */
  private currentTime = "";
  /** Scene context set via !scene command */
  private sceneContext = "";

  constructor(options: CaseManagerOptions = {}) {
    this.genai = options.genai ?? null;
    this.storyManager = options.storyManager ?? new StoryManager({ genai: this.genai });
  }

  createCase(definition: CaseDefinition): CaseState {
    this.storyPrompt = definition.storyPrompt;
    this.evidences = definition.evidences ? [...definition.evidences] : [];
    this.storyManager.setKeyPoints(definition.keyPoints ?? []);
    this.createCharacterSet(definition.characters ?? []);

    return this.getCaseState();
  }

  getCaseState(): CaseState {
    return {
      storyPrompt: this.storyPrompt,
      keyPoints: [...this.getKeyPoints()],
      evidences: [...this.evidences],
      characters: Array.from(this.characters.values()).map((character) => ({
        id: character.id,
        name: character.name,
        description: character.description,
        isHuman: character.isHuman,
        initialPoseId: character.getPose(),
        characterId: character.getCharacterId(),
        role: character.role,
      })),
    };
  }

  getKeyPoints(): string[] {
    return this.storyManager.getKeyPoints();
  }

  addEvidence(evidence: EvidenceItem): void {
    this.evidences.push(evidence);
  }

  addCharacter(profile: CharacterProfile): CharacterManager {
    const hydrated = this.ensureCharacterId(profile);
    const manager = new CharacterManager(hydrated);
    this.characters.set(hydrated.id, manager);
    return manager;
  }

  getCharacter(id: number): CharacterManager | undefined {
    return this.characters.get(id);
  }

  /**
   * Reset conversation state: clear all character memories, speeches, story log, and key points.
   */
  public resetConversation(): void {
    this.storyManager.reset();
    this.characters.forEach((character) => character.clearAllMemory());
  }

  setMasterSocket(socket: CourtroomWebSocketClient | null): void {
    this.masterSocket = socket;
  }

  getCurrentTime(): string {
    return this.currentTime;
  }

  setCurrentTime(time: string): void {
    this.currentTime = time;
  }

  getSceneContext(): string {
    return this.sceneContext;
  }

  setSceneContext(context: string): void {
    this.sceneContext = context;
  }

  bindCharacterSocket(
    characterId: number,
    socket: CourtroomWebSocketClient | null,
  ): void {
    const character = this.characters.get(characterId);
    if (character) {
      character.bindSocket(socket);
    }
  }

  async nextBeat(options: NextBeatOptions): Promise<NextBeatResult> {
    // Gather character memories
    const characterMemories = new Map<number, Array<{ entry: string }>>();
    this.characters.forEach((char) => {
      characterMemories.set(char.id, char.getMemory(CaseManager.contextWindow));
    });

    const speaker = options.forcedSpeakerId !== undefined
      ? options.candidates.find((candidate) => candidate.id === options.forcedSpeakerId)
      : await this.storyManager.chooseSpeaker(options.candidates, {
          storyPrompt: this.storyPrompt,
          lastMsg: options.lastMsg,
          lastSpeakerId: options.lastSpeakerId,
          lastSpeakerName: options.lastSpeakerName ?? null,
          lastSpeakerWantsContinue: options.lastSpeakerWantsContinue ?? false,
          evidences: options.evidences ?? this.evidences,
          characterMemories,
        });

    if (!speaker) {
        return { speakerId: null, text: "" };
    }

    this.storyManager.recordSpeech(speaker.id);

    const character = this.characters.get(speaker.id);
    if (!character) {
      return { speakerId: speaker.id, text: "" };
    }

    const prompt = options.prompt ?? this.buildPromptFromState(options, character);

    // Include evidence image URLs when relevant evidence is mentioned in context
    const allEvidences = options.evidences ?? this.evidences;
    const contextText = [options.lastMsg, prompt].filter(Boolean).join(" ").toLowerCase();
    const anyEvidenceMentioned = allEvidences.some((e) => contextText.includes(e.name.toLowerCase()));
    const evidenceUrls = anyEvidenceMentioned
      ? allEvidences.filter((e) => e.url && e.url.length > 0).map((e) => e.url!)
      : [];

    const draft = await character.generateSpeech(prompt, this.genai, evidenceUrls);
    const refined: SpeechDraft = this.storyManager.refineSpeech(draft);

    // Process `[#evdN]` evidence tags in AI speech: present evidence and strip tags
    const processedText = this.processEvidenceTags(refined.text);
    refined.text = processedText;

    character.recordSpeech(refined.text);
    await character.sendMessage(refined);

    this.storyManager.logSpeech(
      speaker.id,
      character.name,
      refined.text,
      character.getState(),
    );
    
    // Always complete the AI turn after a message is sent
    this.storyManager.completeAiTurn();
    
    // If AI explicitly requests player turn, force it
    if (refined.playerTurn) {
      console.log('[turn management] AI requested player turn');
      this.storyManager.forcePlayerTurn();
    }

    // Debug logging (commented out to avoid cluttering the courtroom)
    // if (this.masterSocket) {
    //   this.masterSocket.sendPlainMessage({
    //     text: `[master] ${character.name} will speak next`,
    //   });
    // }

    return { 
      speakerId: speaker.id, 
      text: refined.text,
      wantsContinue: refined.continueSpeech ?? false,
    };
  }

  /**
   * Find `[#evdN]` tags in AI speech text, present matching evidence in the court record,
   * and return the text with all evidence tags stripped.
   */
  private processEvidenceTags(text: string): string {
    const cleaned = text.replace(/\[#evdi?\d+\]/gi, "").trim();

    const evdRegex = /\[#evdi?(\d+)\]/gi;
    let match: RegExpExecArray | null;
    while ((match = evdRegex.exec(text)) !== null) {
      const index = parseInt(match[1]!, 10) - 1;
      if (index < 0) continue;

      const evidence = this.evidences[index];
      if (!evidence) {
        console.warn(`[evidence] [#evd${match[1]}] no evidence at index ${index}`);
        continue;
      }

      console.log(`[evidence] AI triggered evidence #${match[1]}: ${evidence.name}`);
      this.masterSocket?.addEvidence({
        evidenceId: index + 1,
        name: evidence.name,
        description: evidence.description ?? "",
        iconUrl: evidence.url || "https://objection.lol/assets/icons/question.png",
        url: evidence.url,
        type: (evidence.type as "image" | "video") ?? "image",
      });
    }

    return cleaned;
  }

  private createCharacterSet(profiles: CharacterProfile[]): void {
    this.characters.clear();
    this.usedCharacterIds.clear();
    profiles.forEach((profile) => this.addCharacter(profile));
  }

  private buildPromptFromState(options: NextBeatOptions, speaker?: CharacterManager): string {
    const keyPoints = this.getKeyPoints();
    const messageIndex = options.messageIndex;
    const messageLimit = options.messageLimit;
    const messageCountLine =
      messageIndex && messageLimit
        ? `AI message ${messageIndex} of ${messageLimit}`
        : "";
    const evidences = options.evidences ?? this.evidences;
    
    // Only show evidence to prosecutors
    const isProsecutor = speaker?.role?.toLowerCase() === "prosecutor";
    const evidenceTitles = isProsecutor && evidences.length 
      ? `Available evidence: ${evidences.map((e) => e.name).join(", ")}` 
      : "";

    // Include memories from all characters for context
    const allMemories: string[] = [];
    this.characters.forEach((char) => {
      const memories = char.getMemory(CaseManager.contextWindow);
      if (memories.length > 0) {
        allMemories.push(`${char.name}: ${memories.map(m => m.entry).join("; ")}`);
      }
    });
    const memoriesContext = allMemories.length ? `Character memories:\n${allMemories.join("\n")}` : "";

    const roleLookup = new Map(
      Array.from(this.characters.values()).map((char) => [
        char.name,
        char.role ?? "Character",
      ]),
    );
    const transcript = this.storyManager.buildSpeechLogTranscript(roleLookup);
    const transcriptBlock = transcript ? `Recent transcript:\n${transcript}` : "";

    return [
      `Conversation setup: ${this.storyPrompt}`,
      this.currentTime ? `Current time: ${this.currentTime}` : "",
      this.sceneContext ? `Scene context: ${this.sceneContext}` : "",
      keyPoints.length ? `Key points: ${keyPoints.join(" | ")}` : "",
      evidenceTitles,
      memoriesContext,
      transcriptBlock,
      options.lastSpeakerId ? `Last speaker: ${options.lastSpeakerName ?? "unknown"} (id ${options.lastSpeakerId})` : "Last speaker: player",
      options.lastSpeakerState ? `Last speaker pose: ${options.lastSpeakerState.poseId}, mood: ${options.lastSpeakerState.mood}` : "",
      `Last message: "${options.lastMsg}"`,
      messageCountLine,
      "Use the recent transcript and memories as ongoing context. If available, remember at least the last 15 messages instead of responding only to the latest line.",
      "Reply in <=25 words. Stay in character, answer or react directly, and keep the exchange casual and conversational instead of roleplaying a formal courtroom scene. Do not mention Ace Attorney canon characters unless a human explicitly brings them up. Do not use emdashes. NO EMOJIS."
    ]
      .filter(Boolean)
      .join("\n");
  }

  private resolveCharacterSide(role?: string): CharacterSide | null {
    if (!role) {
      return null;
    }

    switch (role.toLowerCase()) {
      case "witness":
        return "witness";
      case "judge":
        return "judge";
      case "prosecutor":
        return "prosecution";
      case "defendant":
        return "defense";
      default:
        return null;
    }
  }

  private ensureCharacterId(profile: CharacterProfile): CharacterProfile {
    const preferredSide = this.resolveCharacterSide(profile.role);

    if (profile.characterId) {
      this.usedCharacterIds.add(profile.characterId);
      return profile;
    }

    const assignedId = this.pickUnusedCharacterId(preferredSide ?? undefined);
    const characterData = Character.getCharacterData(assignedId);
    if (!characterData) {
      throw new Error(`Character preset ${assignedId} not found in cache.`);
    }
    const initialPoseId = profile.initialPoseId ?? characterData?.poses?.[0]?.id;

    return {
      ...profile,
      characterId: assignedId,
      initialPoseId,
    };
  }

  private pickUnusedCharacterId(side?: CharacterSide): number {
    const cached = Character.getCachedCharacters();

    if (!cached.length) {
      throw new Error("Character presets not loaded. Call Character.fetchCharacterData() before creating a case.");
    }

    const pool = side ? cached.filter((preset) => preset.side === side) : cached;

    const available = pool.find(
      (preset) => !this.usedCharacterIds.has(preset.id) && !this.disallowedCharacterIds.has(preset.id),
    );

    if (!available) {
      throw new Error(
        side ? `No unused character presets available for side ${side}.` : "No unused character presets available.",
      );
    }

    this.usedCharacterIds.add(available.id);
    return available.id;
  }
}

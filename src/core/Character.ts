import type CourtroomWebSocketClient from "../api/courtroom-websocket-client";

export interface CharacterPose {
    id: number;
    name: string;
    characterId: number;
    iconUrl: string;
    order: number;
    idleImageUrl: string;
    speakImageUrl: string;
    poseAudioTicks: number[];
    poseFunctionTicks: number[];
    poseStates: any[];
}

export interface CharacterSpeechBubble {
    id: number;
    name: string;
    imageUrl: string;
    soundUrl: string;
    shake: boolean;
    fullscreen: boolean;
    duration: number;
    order: number;
}

export interface CharacterData {
    id: number;
    isPreset: boolean;
    name: string;
    nameplate: string;
    side: "defense"|"prosecution"|"witness"|"judge";
    backgroundId: number;
    blipUrl: string;
    alignment: any;
    galleryAJImageUrl: any;
    galleryImageUrl: string;
    iconUrl: string;
    limitWidth: boolean;
    offsetX: number;
    offsetY: number;
    userId: any;
    poses: CharacterPose[];
    speechBubbles?: CharacterSpeechBubble[];
}

export interface CharacterState {
    poseId: number;
    characterId: number;
    mood:"neutral" | "happy" | "sad" | "angry" | "surprised" | "nervous";
}

export default class Character {
    private static characterCache: CharacterData[] = [];

    private static upsertCharacterData(characterData: CharacterData): CharacterData {
        const existingIndex = this.characterCache.findIndex((char) => char.id === characterData.id);
        if (existingIndex >= 0) {
            this.characterCache[existingIndex] = characterData;
        } else {
            this.characterCache.push(characterData);
        }

        return characterData;
    }

    public readonly id: number;
    public readonly name: string;
    public readonly description: string;
    public readonly isHuman: boolean;
    private state: CharacterState;
    private memory: string[] = [];
    private courtroom: CourtroomWebSocketClient;

    /**
     * 
     * @param name fictional name
     * @param description fictional description
     * @param state character display state
     * @param isHuman is this character human?
     */
    constructor(courtroom:CourtroomWebSocketClient, name: string, description: string, state:CharacterState={poseId: 0, characterId: 0, mood: "neutral"}, isHuman: boolean=false) {
        const characterData = Character.characterCache.find(char => char.id === state.characterId);
        if (!characterData) {
            throw new Error(`Character with ID ${state.characterId} not found in cache.`);
        }

        this.courtroom = courtroom;
        this.id = characterData.id;
        this.state = state;
        this.name = name;
        this.description = description;
        this.isHuman = isHuman;
    }

    public static getCachedCharacters(): CharacterData[] {
        return this.characterCache;
    }

    public static getCharacterData(id: number): CharacterData | undefined {
        return this.characterCache.find((char) => char.id === id);
    }

    public static async fetchCharacterData() {
        if (this.characterCache.length > 0) {
            return this.characterCache;
        }

        //https://objection.lol/api/assets/character/getPreset
        const response = await fetch("https://objection.lol/api/assets/character/getPreset");
        ///@ts-ignore
        const data: CharacterData[] = await response.json();
        this.characterCache = data;
        return this.characterCache;
    }

    public static async fetchCharacterById(id: number): Promise<CharacterData | undefined> {
        const cached = this.getCharacterData(id);
        if (cached) {
            return cached;
        }

        const response = await fetch(`https://objection.lol/api/assets/character/${id}`);
        if (!response.ok) {
            return undefined;
        }

        ///@ts-ignore
        const characterData: CharacterData = await response.json();
        return this.upsertCharacterData(characterData);
    }

    public static async ensureCharacterIds(ids: number[]): Promise<CharacterData[]> {
        const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
        const resolved = await Promise.all(uniqueIds.map((id) => this.fetchCharacterById(id)));
        return resolved.filter((entry): entry is CharacterData => Boolean(entry));
    }

    public addMemory(memory: string) {
        this.memory.push(memory);
    }

    public getMemory() {
        return this.memory;
    }

    public getMood() {
        return this.state.mood;
    }

    public static getPossibleWitnessIds(): string[] {
        const witnesses = this.characterCache.filter(char => char.side === "witness").map(char => char.id.toString()+':'+char.name);
        return witnesses.sort(() => Math.random() - 0.5);
    }

    public setMood(mood: "neutral" | "happy" | "sad" | "angry" | "surprised" | "nervous") {
        this.state.mood = mood;
    }

    public setPose(poseId: number) {
        this.state.poseId = poseId;
    }

    public getCurrentPoseId() {
        return this.state.poseId;
    }

    public getPossiblePoses() {
        const characterData = Character.characterCache.find(char => char.id === this.state.characterId);
        if (!characterData) {
            throw new Error(`Character with ID ${this.state.characterId} not found in cache.`);
        }
        return characterData.poses;
    }

    public getPossibleSpeechBubbles(): CharacterSpeechBubble[] {
        const characterData = Character.characterCache.find(char => char.id === this.state.characterId);
        if (!characterData) {
            throw new Error(`Character with ID ${this.state.characterId} not found in cache.`);
        }

        return characterData.speechBubbles ?? [];
    }

    public async speech(text: string, poseId?: number, speechBubbleId?: number): Promise<void> {
        this.state.poseId = poseId ?? this.state.poseId;
        console.log(`${this.name} (${this.id}) says: ${text}`, this.state);
        
        // Change username to this character's name before sending message
        console.log(`[username change] Changing to: ${this.name}`);
        this.courtroom.changeUsername({ username: this.name });
        
        // Wait for username change to propagate on server
        await new Promise(resolve => setTimeout(resolve, 300));
        
        const messageData = {
            text,
            characterId: this.state.characterId,
            poseId: this.state.poseId,
            speechBubble: speechBubbleId,
        };
        
        console.log(`[sending message] ${this.name}:`, messageData);
        this.courtroom.sendMessage(messageData);
        
        // Wait a bit to ensure message is sent before next operation
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
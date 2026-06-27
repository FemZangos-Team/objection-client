//objection.lol ai server

import CourtroomWebSocketClient from "./src/api/courtroom-websocket-client";
import type { MessageDto, PlainMessageDto, RoomDto, UserDto } from "./src/api/courtroom-websocket-types";
import {
    CaseManager,
    type CaseState,
    type CharacterProfile,
    StoryManager,
    createGenAIClient,
    generateTrialCharacters,
} from "./src/ai";
import Character from "./src/core/Character";
import { CONFIG } from "./CONFIG";

const ROOM_ID = CONFIG.roomId;
const ROOM_PASS = CONFIG.roomPass;
const PROMPT = CONFIG.prompt;
const PLAYER_USERNAME = CONFIG.playerUsername;
const MAX_AI_MESSAGES = CONFIG.maxAiMessages; // Cap AI sequential messages to prevent long runs away from player input. Judge opening counts towards this limit.
const INWORLD_KEY = CONFIG.inworldKey;
const INWORLD_MODEL = CONFIG.inworldModel;
const INWORLD_BASE_URL = CONFIG.inworldBaseUrl;
const CUSTOM_CHARACTER_IDS = CONFIG.customCharacterIds;
const CAST_OVERRIDES = CONFIG.castOverrides;
const MAFIA_MODE = CONFIG.mafiaMode;
const MAFIA_PLAYERS = CONFIG.mafiaPlayers;
const MIN_REPLY_DELAY_MS = 5000;
const MAX_REPLY_DELAY_MS = 10000;
const AI_BANTER_MAX_MESSAGES = 20;

let playerId:string; //xxxx-xxxxx-xxxxx
const aiUsernames = new Set<string>();
const aiUserIds = new Set<string>();
const userNamesById = new Map<string, string>();
let replyQueue: Promise<void> = Promise.resolve();
let lastSpeakerId: number | null = null;
const readingDelayMs = 300; // after text animation, this will add a small delay to allow reading
let lastSpeakerName: string | null = null;

//test:
globalThis.masterCourt = new CourtroomWebSocketClient();
const genai = createGenAIClient({
    apiKey: INWORLD_KEY || "",
    model: INWORLD_MODEL,
    baseUrl: INWORLD_BASE_URL,
});
await Character.fetchCharacterData();

await Character.ensureCharacterIds([
    ...CUSTOM_CHARACTER_IDS,
    ...CAST_OVERRIDES.map((override) => override.characterId).filter((characterId): characterId is number => Number.isInteger(characterId)),
]);

// Track all active connections for cleanup
const activeConnections: CourtroomWebSocketClient[] = [masterCourt];

const storyManager = new StoryManager({ cooldownMs: 15000, genai, playerUsername: PLAYER_USERNAME });
const caseManager = new CaseManager({ genai, storyManager });

// Use a minimal story prompt — characters are AI-generated, but no AI call is made for a case description
const mafiaPrompt = MAFIA_MODE
    ? "Mafia party game — the Game Master narrates the story, assigns secret roles, and the players must figure out who the Mafia is.\n\n"
      + `Players: ${MAFIA_PLAYERS.map(p => p.name).join(", ")}.\n\n`
      + "The Game Master reveals events (who was eliminated, what happened at night, etc.) and players discuss, accuse, and vote in character. The Mafia tries to blend in. The Town tries to find them."
    : "";

const defaultCasePrompt = MAFIA_MODE
    ? mafiaPrompt
    : (PROMPT?.trim() || "Live character conversation.");

console.log("Story prompt:", defaultCasePrompt);

let generatedProfiles: Array<Awaited<ReturnType<typeof generateTrialCharacters>>[number]>;
if (MAFIA_MODE && MAFIA_PLAYERS.length > 0) {
    // Mafia mode: create profiles from mafiaPlayers config
    generatedProfiles = await createMafiaProfiles();
} else {
    generatedProfiles = applyCastOverrides(
        await generateTrialCharacters(genai, defaultCasePrompt, PLAYER_USERNAME),
        CAST_OVERRIDES,
    );
}

console.log("Character profiles:", generatedProfiles);
console.log(`\n[characters] ${generatedProfiles.length} characters generated:`);
generatedProfiles.forEach(p => {
    console.log(`  - ${p.name} (role: ${p.role}, id: ${p.id})`);
});

// Deduplicate character names — append " AI" suffix when two characters share the same name
const nameCount = new Map<string, number>();
for (let i = 0; i < generatedProfiles.length; i++) {
    const profile = generatedProfiles[i]!;
    const count = nameCount.get(profile.name) ?? 0;
    nameCount.set(profile.name, count + 1);
    if (count > 0) {
        const newName = `${profile.name} AI`;
        console.log(`[dedup] Renaming "${profile.name}" to "${newName}" to avoid duplicate`);
        generatedProfiles[i] = { ...profile, name: newName } as typeof profile;
    }
}

/** Generate character profiles for Mafia mode from mafiaPlayers config */
async function createMafiaProfiles(): Promise<CharacterProfile[]> {
    const profiles: CharacterProfile[] = [];

    for (let i = 0; i < MAFIA_PLAYERS.length; i++) {
        const player = MAFIA_PLAYERS[i]!;
        const characterData = player.characterId
            ? Character.getCharacterData(player.characterId)
            : undefined;

        profiles.push({
            id: i + 2, // Start at 2 (1 is reserved defense player)
            name: player.name,
            description: `Player in a Mafia party game. ${player.role ? `Secretly assigned the role of ${player.role}.` : ''} ${characterData?.name ? `Uses character preset: ${characterData.name}.` : ''}`,
            isHuman: false,
            role: "Witness", // Generic role for the courtroom interface
            characterId: characterData?.id ?? 4, // Fallback to witness preset
            secretRole: player.role,
            initialPoseId: characterData?.poses?.[0]?.id,
        });
    }

    return profiles;
}

interface CastOverride {
    slotId: string;
    role: string;
    occurrence: number;
    characterId?: number;
    remove?: boolean;
    nameOverride?: string;
    descriptionOverride?: string;
}

function applyCastOverrides(
    profiles: Array<Awaited<ReturnType<typeof generateTrialCharacters>>[number]>,
    overrides: CastOverride[],
): Array<Awaited<ReturnType<typeof generateTrialCharacters>>[number]> {
    const occurrenceByRole = new Map<string, number>();
    const slotMap = profiles.map((profile, index) => {
        const role = profile.role ?? "Character";
        const occurrence = occurrenceByRole.get(role) ?? 0;
        occurrenceByRole.set(role, occurrence + 1);
        return { index, role, occurrence };
    });

    const nextProfiles = [...profiles];

    for (const override of overrides) {
        const target = slotMap.find((slot) => slot.role === override.role && slot.occurrence === override.occurrence);
        if (!target) {
            continue;
        }

        if (override.remove) {
            nextProfiles[target.index] = null as never;
            continue;
        }

        const existing = nextProfiles[target.index];
        if (!existing) {
            continue;
        }

        const overrideCharacterId = override.characterId ?? existing.characterId;
        const characterData = overrideCharacterId ? Character.getCharacterData(overrideCharacterId) : undefined;
        nextProfiles[target.index] = {
            ...existing,
            characterId: characterData ? overrideCharacterId : existing.characterId,
            initialPoseId: characterData?.poses?.[0]?.id ?? existing.initialPoseId,
            name: override.nameOverride?.trim() || characterData?.name || existing.name,
            description: override.descriptionOverride?.trim() || existing.description,
        };
    }

    const withCustomSet = nextProfiles.filter(Boolean);

    for (const characterId of CUSTOM_CHARACTER_IDS) {
        const alreadyUsed = withCustomSet.some((profile) => profile.characterId === characterId);
        if (alreadyUsed) {
            continue;
        }

        const characterData = Character.getCharacterData(characterId);
        if (!characterData) {
            continue;
        }

        const nextId = withCustomSet.reduce((maxId, profile) => Math.max(maxId, profile.id), 0) + 1;

        withCustomSet.push({
            id: nextId,
            name: characterData.name,
            description: `${characterData.name} added from custom character library.`,
            isHuman: false,
            role: mapSideToRole(characterData.side),
            characterId,
            initialPoseId: characterData.poses?.[0]?.id,
        });
    }

    return withCustomSet;
}

function mapSideToRole(side: string): "Prosecutor" | "Judge" | "Witness" | "Defendant" {
    switch (side) {
        case "prosecution":
            return "Prosecutor";
        case "judge":
            return "Judge";
        case "defense":
            return "Defendant";
        default:
            return "Witness";
    }
}

async function main() {
    const aiCharacters = generatedProfiles.map((profile) => ({
        profile,
        username: profile.name,
    }));

    aiCharacters.forEach((entry) => aiUsernames.add(entry.username));

    caseManager.createCase({
        storyPrompt: defaultCasePrompt,
        characters: generatedProfiles,
    });

    const masterSocket = masterCourt.connect({
        query: {
            username: "MasterSocket",
            roomId: ROOM_ID || "",
            password: ROOM_PASS
        }
    });

    masterCourt.onMessage((message) => {
        console.log("Received message:", message);
        handleIncomingPlainMessage(message).catch((error) => {
            console.error("Error processing message:", error);
        });
    });

    // Listen for plain_text chat messages from objection.lol (the chat box, not the character panel)
    masterCourt.onPlainMessage((plainMessage) => {
        console.log("Received plain message:", plainMessage);
        // Normalize PlainMessageDto to the MessageDto shape expected by handleIncomingPlainMessage
        handleIncomingPlainMessage({
            userId: plainMessage.userId,
            message: { text: plainMessage.text },
        }).catch((error) => {
            console.error("Error processing plain message:", error);
        });
    });

    masterCourt.onRoomUpdate((room) => {
        syncKnownUsers(extractRoomUsers(room));
    });

    masterCourt.onUserJoined((data) => {
        userNamesById.set(data.id, data.username);
        if (data.username === "MasterSocket" || aiUsernames.has(data.username)) {
            aiUserIds.add(data.id);
        }
        if (data.username === PLAYER_USERNAME) {
            playerId = data.id;
        }
    });

    masterCourt.onUserUpdate((userId, data) => {
        if (data?.username) {
            userNamesById.set(userId, data.username);
            if (data.username === "MasterSocket" || aiUsernames.has(data.username)) {
                aiUserIds.add(userId);
            }
        }
        if (data?.username === PLAYER_USERNAME) {
            playerId = userId;
        }
    });

    masterCourt.onTyping((userId) => {
        trackTyping(userId);
    });

    caseManager.setMasterSocket(masterCourt);

    // Bind all AI characters to the master socket (username is swapped before each message)
    aiCharacters.forEach((entry) => {
        caseManager.bindCharacterSocket(entry.profile.id, masterCourt);
    });

    // Let the Judge open the session once the master socket is connected and room data is ready.
    masterCourt.onConnect(() => {
        console.log("Connected to courtroom API");

        // Refresh room roster so userId -> username map is populated for incoming messages.
        masterCourt.getRoom();

        // Wait for room data to settle, then start the opening
        setTimeout(() => {
            void startJudgeOpening(caseManager.getCaseState());
        }, 2000);

        if (process.stdin.isTTY && process.stdout.isTTY) {
            startRepl();
        } else {
            console.log("REPL disabled: no interactive TTY available.");
        }
    });
}

function extractRoomUsers(room: Partial<RoomDto> | null | undefined): UserDto[] {
    if (!room || !Array.isArray(room.users)) {
        console.warn("[room update] Received room payload without users array:", room);
        return [];
    }

    return room.users.filter((user): user is UserDto => Boolean(user?.id) && typeof user.username === "string");
}

function syncKnownUsers(users: UserDto[]): void {
    for (const user of users) {
        userNamesById.set(user.id, user.username);
        if (user.username === "MasterSocket" || aiUsernames.has(user.username)) {
            aiUserIds.add(user.id);
        }
        if (user.username === PLAYER_USERNAME) {
            playerId = user.id;
        }
    }
}

main().catch((error) => {
    console.error("Fatal error in main:", error);
    cleanup();
    process.exit(1);
});

function buildReplyPrompt(message: MessageDto, state: CaseState): string {
    return [
        "Continue the Ace Attorney style trial.",
        `Story prompt: ${state.storyPrompt}`,
        state.keyPoints.length ? `Key points: ${state.keyPoints.join(" | ")}` : "",
        `Latest player line: "${message.message}"`,
        "Respond in <=25 words, plain text, concise, keep courtroom tone.",
    ]
        .filter(Boolean)
        .join("\n");
}

async function handleIncomingPlainMessage(message: MessageDto): Promise<void> {
    let text = message.message.text?.trim() ?? "";
    if (!text) {
        return;
    }

    if (text.startsWith("[master]") || text.startsWith("[Characters]") || text.startsWith("[Storyline]")) {
        console.log("Ignoring master message:", message.message);
        return;
    }

    const speakerUsername = userNamesById.get(message.userId) ?? `user:${message.userId}`;
    if (aiUserIds.has(message.userId) || aiUsernames.has(speakerUsername) || speakerUsername === "MasterSocket") {
        console.log("Ignoring AI/self message from:", speakerUsername, message.userId);
        return;
    }

    console.log("Human message from", message.userId, "as", speakerUsername);

    // Strip invisible Unicode characters that .trim() doesn't catch
    // (zero-width spaces U+200B-U+200F, BOM U+FEFF, Unicode control chars, etc.)
    text = text.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u061C\u2060-\u2064\uFFF9-\uFFFB]/g, "").trim();

    // Process `[#evdN]` evidence tags: present evidence in court record and strip tags from text
    // This must run BEFORE the formatting strip below so [#evdN] tags aren't eaten
    try {
        text = processEvidenceTags(text);
    } catch (error) {
        console.error("[evidence] Error processing evidence tags:", error);
    }

    // Strip objection.lol character panel formatting tags like [#ts12], [#/cff0000], [/#]
    // These wrap around commands typed in the character panel instead of the plain chat box
    text = text.replace(/\[#\/?[^\]]*\]|\[\/[^\]]*\]/g, "").trim();

    lastSpeakerId = null;
    lastSpeakerName = speakerUsername;

    storyManager.logSpeech(
        undefined,
        speakerUsername,
        text,
    );

    // === Chat commands ===

    // !exit - End the AI conversation and prevent further AI replies
    if (text === "!exit") {
        console.log("Command: !exit - ending AI conversation");
        storyManager.forcePlayerTurn();
        masterCourt.sendPlainMessage({
            text: "[System] AI conversation ended."
        });
        return;
    }

    // !reset - Reset conversation history, memory, and key points
    if (text === "!reset") {
        console.log("Command: !reset - resetting conversation history and memory");
        storyManager.reset();
        caseManager.resetConversation();
        masterCourt.sendPlainMessage({
            text: "[System] Conversation history, memories, and key points have been reset. Starting fresh."
        });
        return;
    }

    // !time <timeofday> - Set the current in-game time
    const timeMatch = text.match(/^!time\s+(.+)$/i);
    if (timeMatch) {
        const timeOfDay = timeMatch[1]!.trim();
        console.log("Command: !time -", timeOfDay);
        caseManager.setCurrentTime(timeOfDay);
        masterCourt.sendPlainMessage({
            text: `[System] Time set to ${timeOfDay}.`
        });
        return;
    }

    // !scene <description> - Set the current scene context
    const sceneMatch = text.match(/^!scene\s+(.+)$/i);
    if (sceneMatch) {
        const sceneDesc = sceneMatch[1]!.trim();
        console.log("Command: !scene -", sceneDesc);
        caseManager.setSceneContext(sceneDesc);
        masterCourt.sendPlainMessage({
            text: `[System] Scene context updated: ${sceneDesc}`
        });
        return;
    }

    // !keypoint <point> - Add a key point to the conversation
    const keypointMatch = text.match(/^!keypoint\s+(.+)$/i);
    if (keypointMatch) {
        const point = keypointMatch[1]!.trim();
        console.log("Command: !keypoint -", point);
        storyManager.addKeyPoint(point);
        masterCourt.sendPlainMessage({
            text: `[System] Key point added: ${point}`
        });
        return;
    }

    // !talk - Start a conversation with a random character
    if (text === "!talk") {
        console.log("Command: !talk - starting conversation with random character");
        const state = caseManager.getCaseState();
        const aiCharacters = state.characters.filter((c) => !c.isHuman);
        if (aiCharacters.length === 0) {
            console.log("No AI characters available for !talk");
            masterCourt.sendPlainMessage({
                text: "[System] No AI characters available to talk."
            });
            return;
        }

        // Open AI window with a few turns for follow-up conversation
        storyManager.openAiWindow(3);

        // Pick a random AI character (array is non-empty, validated above)
        const randomChar = aiCharacters[Math.floor(Math.random() * aiCharacters.length)]!;
        console.log(`Random character selected: ${randomChar.name} (id: ${randomChar.id})`);

        // Queue reply from that character
        queueAddressedReply(message, speakerUsername, randomChar.id);

        // After the initial reply, run the AI window for follow-up turns
        replyQueue = replyQueue.then(() => {
            if (storyManager.hasAiTurnAvailable()) {
                return runAiWindow(message);
            }
        });

        return;
    }

    // !aibanter - Start free-form AI-to-AI banter
    if (text === "!aibanter") {
        console.log("Command: !aibanter - starting AI banter");
        const state = caseManager.getCaseState();
        const aiChars = state.characters.filter((c) => !c.isHuman);
        if (aiChars.length < 2) {
            console.log("Not enough AI characters for !aibanter");
            masterCourt.sendPlainMessage({
                text: "[System] Need at least 2 AI characters for banter."
            });
            return;
        }

        masterCourt.sendPlainMessage({
            text: "[System] AI banter started! Characters will chat among themselves."
        });

        // Chain onto reply queue to avoid conflicts
        replyQueue = replyQueue.then(() => runAiBanter());
        return;
    }

    // If text starts with ! but wasn't recognized as a command, log debug info
    if (text.startsWith("!")) {
        const charCodes = Array.from(text).map(c => `U+${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(" ");
        console.log("[debug] Unrecognized command:", JSON.stringify(text), "charCodes:", charCodes);
    }

    const addressedCharacter = findAddressedCharacter(text, caseManager.getCaseState());
    if (!addressedCharacter) {
        console.log("No AI character mentioned in message, skipping reply.");
        return;
    }

    queueAddressedReply(message, speakerUsername, addressedCharacter.id);
}

function queueAddressedReply(message: MessageDto, speakerUsername: string, characterId: number): void {
    replyQueue = replyQueue
        .then(async () => {
            const delayMs = randomInt(MIN_REPLY_DELAY_MS, MAX_REPLY_DELAY_MS);
            console.log(`[chat queue] Waiting ${delayMs}ms before replying as character ${characterId}`);
            await delay(delayMs);
            await respondToAddressedMessage(message, speakerUsername, characterId);
        })
        .catch((error) => {
            console.error("[chat queue] Reply failed:", error);
        });
}

async function respondToAddressedMessage(
    message: MessageDto,
    speakerUsername: string,
    characterId: number,
): Promise<void> {
    const state = caseManager.getCaseState();
    const character = state.characters.find((entry) => entry.id === characterId);
    if (!character) {
        return;
    }

    const prompt = buildMentionReplyPrompt(speakerUsername, message.message.text ?? "", state, character.name);
    const result = await caseManager.nextBeat({
        candidates: [
            {
                id: character.id,
                username: character.name,
                role: character.role,
                isHuman: character.isHuman,
            },
        ],
        forcedSpeakerId: character.id,
        prompt,
        lastMsg: message.message.text ?? "",
        lastSpeakerId: null,
        lastSpeakerName: speakerUsername,
        lastSpeakerState: null,
        evidences: state.evidences,
    });

    if (!result.text) {
        return;
    }

    lastSpeakerId = result.speakerId;
    lastSpeakerName = character.name;
    const animationDelay = result.text.length * 60;
    await delay(readingDelayMs + animationDelay);
}

function buildMentionReplyPrompt(
    speakerUsername: string,
    latestMessage: string,
    state: CaseState,
    characterName: string,
): string {
    const roleLookup = new Map(
        state.characters.map((character) => [character.name, character.role ?? "Character"]),
    );
    const transcript = storyManager.buildSpeechLogTranscript(roleLookup);
    return [
        `You are ${characterName} in a casual character chat.`,
        `Conversation setup: ${state.storyPrompt}`,
        `The player's name is ${speakerUsername}. Use their real username and do not rename them.`,
        state.keyPoints.length ? `Key points: ${state.keyPoints.join(" | ")}` : "",
        state.evidences.length ? `Evidence in play: ${state.evidences.map((item) => item.name).join(", ")}` : "",
        transcript ? `Recent transcript:\n${transcript}` : "",
        `${speakerUsername} directly addressed ${characterName}.`,
        `Latest human message: "${latestMessage}"`,
        "Respond directly to what they said instead of continuing a monologue.",
        "Use the ongoing conversation context. If available, remember at least the last 15 messages rather than only the latest line.",
        "Keep it casual, in-character, and concise. Max 35 words.",
        "If they asked a question, answer it. If they teased or challenged you, react naturally rather than turning it into roleplay.",
        "Do not mention Ace Attorney canon characters unless a human explicitly brings them up.",
        "Do not use emdashes.",
        "NO EMOJIS.",
    ].filter(Boolean).join("\n");
}

function findAddressedCharacter(messageText: string, state: CaseState): CaseState["characters"][number] | undefined {
    const normalizedMessage = normalizeNameFragment(messageText);
    const messageTokens = tokenizeNameFragment(messageText);
    const matches = state.characters
        .filter((character) => !character.isHuman)
        .map((character) => buildCharacterNameMatch(character, normalizedMessage, messageTokens))
        .filter((entry): entry is NameMatch => entry !== null)
        .sort((left, right) => right.score - left.score || left.index - right.index);

    return matches[0]?.character;
}

function randomInt(min: number, max: number): number {
    const lower = Math.ceil(min);
    const upper = Math.floor(max);
    return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

interface NameMatch {
    character: CaseState["characters"][number];
    index: number;
    score: number;
}

function buildCharacterNameMatch(
    character: CaseState["characters"][number],
    normalizedMessage: string,
    messageTokens: string[],
): NameMatch | null {
    const normalizedName = normalizeNameFragment(character.name);
    const nameTokens = tokenizeNameFragment(character.name);
    const fullIndex = normalizedMessage.indexOf(normalizedName);
    if (fullIndex >= 0) {
        return {
            character,
            index: fullIndex,
            score: 1000 + normalizedName.length,
        };
    }

    let bestTokenScore = -1;
    let bestTokenIndex = Number.MAX_SAFE_INTEGER;

    for (const messageToken of messageTokens) {
        if (messageToken.length < 3) {
            continue;
        }

        for (const nameToken of nameTokens) {
            if (nameToken.length < 3) {
                continue;
            }

            const isPrefixMatch = nameToken.startsWith(messageToken) || messageToken.startsWith(nameToken);
            if (!isPrefixMatch) {
                continue;
            }

            const tokenIndex = normalizedMessage.indexOf(messageToken);
            const score = 100 + Math.min(messageToken.length, nameToken.length);
            if (score > bestTokenScore || (score === bestTokenScore && tokenIndex < bestTokenIndex)) {
                bestTokenScore = score;
                bestTokenIndex = tokenIndex;
            }
        }
    }

    if (bestTokenScore < 0) {
        return null;
    }

    return {
        character,
        index: bestTokenIndex,
        score: bestTokenScore,
    };
}

function normalizeNameFragment(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function tokenizeNameFragment(value: string): string[] {
    return normalizeNameFragment(value)
        .split(/\s+/)
        .filter(Boolean);
}

async function runAiBanter(): Promise<void> {
    let steps = 0;
    let lastWantsContinue = false;
    let currentMessage = "The characters begin chatting among themselves naturally.";

    storyManager.openAiWindow(AI_BANTER_MAX_MESSAGES);
    console.log(`[aibanter] Starting with ${AI_BANTER_MAX_MESSAGES} max messages`);

    while (storyManager.hasAiTurnAvailable() && steps < AI_BANTER_MAX_MESSAGES) {
        const state = caseManager.getCaseState();
        const candidates = state.characters.map((character) => ({
            id: character.id,
            username: character.name,
            role: character.role,
            isHuman: character.isHuman,
            isTyping: false,
        }));

        const result = await caseManager.nextBeat({
            candidates,
            lastMsg: currentMessage,
            lastSpeakerId,
            lastSpeakerName,
            lastSpeakerState: null,
            messageIndex: steps + 1,
            messageLimit: AI_BANTER_MAX_MESSAGES,
            evidences: state.evidences,
            lastSpeakerWantsContinue: lastWantsContinue,
        });

        if (!result.text || !result.speakerId) {
            break;
        }

        lastSpeakerId = result.speakerId;
        lastSpeakerName = state.characters.find((c) => c.id === result.speakerId)?.name ?? null;
        lastWantsContinue = result.wantsContinue ?? false;
        currentMessage = result.text;

        console.log(`[aibanter] ${result.speakerId ?? "unknown"}: ${result.text}${result.wantsContinue ? " (wants to continue)" : ""}`);

        const animationDelay = result.text.length * 60;
        await delay(readingDelayMs + animationDelay);

        steps += 1;
    }

    console.log(`[aibanter] Completed ${steps} messages.`);
}

async function runAiWindow(latestPlayerMessage: MessageDto): Promise<void> {
    let steps = 0;
    let lastWantsContinue = false;
    let currentMessage = latestPlayerMessage.message.text;
    
    console.log(`[ai window] Starting with ${MAX_AI_MESSAGES} max messages`);
    
    while (storyManager.hasAiTurnAvailable() && steps < MAX_AI_MESSAGES) {
        console.log(`[ai window] Step ${steps + 1}, hasAiTurnAvailable: ${storyManager.hasAiTurnAvailable()}`);
        const state = caseManager.getCaseState();
        const candidates = state.characters.map((character) => ({
            id: character.id,
            username: character.name,
            role: character.role,
            isHuman: character.isHuman,
            isTyping: false,
        }));
        
        console.log(`[candidates] ${candidates.filter(c => !c.isHuman).length} AI characters available: ${candidates.filter(c => !c.isHuman).map(c => c.username).join(', ')}`);

        //generate character speech
        const result = await caseManager.nextBeat({
            candidates,
            lastMsg: currentMessage, // Use the current message in the conversation
            lastSpeakerId,
            lastSpeakerName,
            lastSpeakerState: null,
            messageIndex: steps + 1,
            messageLimit: MAX_AI_MESSAGES,
            evidences: state.evidences,
            lastSpeakerWantsContinue: lastWantsContinue,
        });
        if (!result.text || !result.speakerId) {
            break;
        }

        lastSpeakerId = result.speakerId;
        lastSpeakerName = state.characters.find((c) => c.id === result.speakerId)?.name ?? null;
        lastWantsContinue = result.wantsContinue ?? false;
        currentMessage = result.text; // Update to the last AI response for next iteration

        console.log(`[ai delivered] ${result.speakerId ?? "unknown"}: ${result.text}${result.wantsContinue ? " (wants to continue)" : ""}`);

        // Brief pause so humans can read before the next turn
        const animationDelay = result.text.length * 60; // 60ms per character for animation
        await delay(readingDelayMs + animationDelay);

        steps += 1;
    }
    
    console.log(`[ai window] Completed ${steps} messages. hasAiTurnAvailable: ${storyManager.hasAiTurnAvailable()}`);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find `[#evdN]` tags in text, present matching evidence in the court record,
 * and return the text with all evidence tags stripped.
 */
function processEvidenceTags(text: string): string {
    const evdRegex = /\[#evdi?(\d+)\]/gi;
    let match: RegExpExecArray | null;
    const cleaned = text.replace(evdRegex, "").trim();

    const evdRegexFind = /\[#evdi?(\d+)\]/gi;
    while ((match = evdRegexFind.exec(text)) !== null) {
        const index = parseInt(match[1]!, 10) - 1; // 1-based → 0-based
        if (index < 0) continue;

        const state = caseManager.getCaseState();
        const evidence = state.evidences[index];
        if (!evidence) {
            console.warn(`[evidence] [#evd${match[1]}] no evidence at index ${index}`);
            continue;
        }

        console.log(`[evidence] Triggering evidence #${match[1]}: ${evidence.name}`);
        masterCourt.addEvidence({
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

function trackTyping(userId: string): void {
    // const previousTimer = typingUsers.get(userId);
    // if (previousTimer) {
    //     clearTimeout(previousTimer);
    // }

    // // Reset typing indicator after a short idle period.
    // const timer = setTimeout(() => typingUsers.delete(userId), 5000);
    // typingUsers.set(userId, timer);
}

async function startJudgeOpening(state: CaseState): Promise<void> {
    const judge = state.characters.find((c) =>
        c.role?.toLowerCase?.() === "judge",
    );

    if (!judge) {
        return;
    }

    // Log characters to courtroom
    const charactersList = state.characters.map(c => `${c.name} (${c.role})`).join(", ");
    masterCourt.sendPlainMessage({
        text: `[Characters] ${charactersList}`
    });

    // Wait a bit before sending storyline
    await delay(200);

    // Log storyline to courtroom
    masterCourt.sendPlainMessage({
        text: `[Storyline] ${state.storyPrompt}`
    });

    // Wait a bit before judge speaks
    await delay(300);

    storyManager.openAiWindow(1);

    const prompt = [
        "Give a one-line opening to start the trial and ask if the defense and prosecution are ready.",
        `Story prompt: ${state.storyPrompt}`,
        `The defense player's name is ${PLAYER_USERNAME}.`,
        state.keyPoints.length ? `Key points: ${state.keyPoints.join(" | ")}` : "",
        "Tone: Judge declaring the session open briefly describing the case. <= 50 words.",
    ].filter(Boolean).join("\n");

    //generate first judge speech
    await caseManager.nextBeat({
        candidates: [
            {
                id: judge.id,
                username: judge.name,
                isHuman: judge.isHuman,
            },
        ],
        prompt,
        lastMsg: "",
        lastSpeakerId: judge.id,
        lastSpeakerName: judge.name,
        lastSpeakerState: null,
        evidences: state.evidences,
    });
}

function startRepl() {
    const readline = require('readline');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.setPrompt('> ');
    rl.prompt();

    rl.on('line', async (input: string) => {
        const args = input.trim().split(/\s+/);
        const cmd = args[0];
        const cmdArgs = args.slice(1);

        if (!cmd) {
            rl.prompt();
            return;
        }

        try {
            const cmdModule = await import(`./src/repl/${cmd}.ts`);
            await cmdModule.default(cmdArgs);
        } catch (error) {
            console.error(`Error executing command "${cmd}":`, error);
        }

        rl.prompt();
    });

    rl.on('close', () => {
        cleanup();
        process.exit(0);
    });
}

// Cleanup function to disconnect all WebSocket connections
function cleanup() {
    console.log("Closing all WebSocket connections...");
    activeConnections.forEach((connection) => {
        try {
            connection.disconnect();
        } catch (error) {
            console.error("Error disconnecting socket:", error);
        }
    });
    console.log("All connections closed.");
}

// Handle process termination signals
process.on('SIGINT', () => {
    console.log("\nReceived SIGINT, cleaning up...");
    cleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log("\nReceived SIGTERM, cleaning up...");
    cleanup();
    process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error("Uncaught exception:", error);
    cleanup();
    process.exit(1);
});
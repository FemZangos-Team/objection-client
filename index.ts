//objection.lol ai server

import CourtroomWebSocketClient from "./src/api/courtroom-websocket-client";
import type { MessageDto, PlainMessageDto } from "./src/api/courtroom-websocket-types";
import {
    CaseManager,
    type CaseState,
    StoryManager,
    createGenAIClient,
    generateTrialCharacters,
    generateCasePrompt,
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
const MIN_REPLY_DELAY_MS = 5000;
const MAX_REPLY_DELAY_MS = 10000;

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
});
await Character.fetchCharacterData();

// Track all active connections for cleanup
const activeConnections: CourtroomWebSocketClient[] = [masterCourt];

const storyManager = new StoryManager({ cooldownMs: 15000, genai });
const caseManager = new CaseManager({ genai, storyManager });
const defaultCasePrompt = await generateCasePrompt(genai, PROMPT);
console.log("Generated case prompt:", defaultCasePrompt);
const generatedProfiles = await generateTrialCharacters(genai, defaultCasePrompt);
console.log("Generated character profiles:", generatedProfiles);
console.log(`\n[characters] ${generatedProfiles.length} characters generated:`);
generatedProfiles.forEach(p => {
    console.log(`  - ${p.name} (role: ${p.role}, id: ${p.id})`);
});

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
        handleIncomingPlainMessage(message);
    });

    masterCourt.onRoomUpdate((room) => {
        room.users.forEach((user) => {
            userNamesById.set(user.id, user.username);
            if (user.username === "MasterSocket" || aiUsernames.has(user.username)) {
                aiUserIds.add(user.id);
            }
            if (user.username === PLAYER_USERNAME) {
                playerId = user.id;
            }
        });
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

    // Bind all AI characters to the master socket instead of creating individual connections
    aiCharacters.forEach((entry) => {
        caseManager.bindCharacterSocket(entry.profile.id, masterCourt);
    });

    // Let the Judge open the session once sockets are connected.
    setTimeout(() => {
        // Debug: show storyline (commented out to avoid cluttering courtroom)
        // masterCourt.sendPlainMessage({
        //     text: "Storyline: " + caseManager.getCaseState().storyPrompt
        // });
        void startJudgeOpening(caseManager.getCaseState());
    }, 800);

    masterCourt.onConnect(() => {
        console.log("Connected to courtroom API");

        // Refresh room roster so userId -> username map is populated for incoming messages.
        masterCourt.getRoom();

        startRepl();
    });
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
    const text = message.message.text?.trim() ?? "";
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
    lastSpeakerId = null;
    lastSpeakerName = speakerUsername;

    storyManager.logSpeech(
        undefined,
        speakerUsername,
        text,
    );

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
    return [
        `You are ${characterName} in an Ace Attorney style courtroom chat.`,
        `Story prompt: ${state.storyPrompt}`,
        state.keyPoints.length ? `Key points: ${state.keyPoints.join(" | ")}` : "",
        state.evidences.length ? `Evidence in play: ${state.evidences.map((item) => item.name).join(", ")}` : "",
        `${speakerUsername} directly addressed ${characterName}.`,
        `Latest human message: "${latestMessage}"`,
        "Respond directly to what they said instead of continuing a monologue.",
        "Keep it conversational, in-character, and concise. Max 35 words.",
        "If they asked a question, answer it. If they challenged you, react to that challenge.",
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
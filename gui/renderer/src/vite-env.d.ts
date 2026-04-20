/// <reference types="vite/client" />

interface BotLogPayload {
  level: "info" | "error" | "system";
  message: string;
}

interface BotStatusPayload {
  running: boolean;
}

interface DesktopBotConfig {
  roomId?: string;
  roomPass?: string;
  prompt: string;
  playerUsername: string;
  maxAiMessages: number;
  inworldKey: string;
  inworldModel: string;
  customCharacterIds: number[];
  castOverrides: Array<{
    slotId: string;
    role: string;
    occurrence: number;
    characterId?: number;
    remove?: boolean;
    nameOverride?: string;
    descriptionOverride?: string;
  }>;
}

interface DesktopCharacter {
  id: number;
  name: string;
  side: "defense" | "prosecution" | "witness" | "judge";
  iconUrl: string;
  galleryImageUrl: string;
  nameplate: string;
}

interface Window {
  objectionApp: {
    getDefaults: () => Promise<DesktopBotConfig>;
    listCharacters: () => Promise<DesktopCharacter[]>;
    getCharacterById: (id: number) => Promise<DesktopCharacter | null>;
    startBot: (config: DesktopBotConfig) => Promise<{ ok: boolean; error?: string }>;
    stopBot: () => Promise<{ ok: boolean }>;
    onBotLog: (callback: (payload: BotLogPayload) => void) => () => void;
    onBotStatus: (callback: (payload: BotStatusPayload) => void) => () => void;
  };
}
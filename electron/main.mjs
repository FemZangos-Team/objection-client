import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../app-defaults.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const rendererDist = path.join(projectRoot, "dist", "gui");
const preloadPath = path.join(__dirname, "preload.cjs");
const devServerUrl = process.env.OBJECTION_GUI_DEV_SERVER_URL ?? "http://127.0.0.1:5173";
const isDev = !app.isPackaged;

let mainWindow = null;
let botProcess = null;
let characterCatalogCache = null;

async function fetchCharacterById(id) {
  const cached = characterCatalogCache?.find((entry) => entry.id === id);
  if (cached) {
    return cached;
  }

  const response = await fetch(`https://objection.lol/api/assets/character/${id}`);
  if (!response.ok) {
    return null;
  }

  const character = await response.json();
  characterCatalogCache = characterCatalogCache ? [...characterCatalogCache, character] : [character];
  return character;
}

function emit(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: "#111315",
    title: "Objection.ai Desktop",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(rendererDist, "index.html"));
  }
}

function resolveBotCommand(cliArgs) {
  const bunProbe = spawnSync("bun", ["--version"], { cwd: projectRoot, stdio: "ignore" });
  if (bunProbe.status === 0) {
    return {
      command: "bun",
      args: ["run", "./index.ts", ...cliArgs],
    };
  }

  return {
    command: "node",
    args: ["--import", "tsx", "./index.ts", ...cliArgs],
  };
}

function buildCliArgs(config) {
  const cliArgs = [];
  const pairs = [
    ["--room-id", config.roomId],
    ["--room-pass", config.roomPass],
    ["--player-username", config.playerUsername],
    ["--prompt", config.prompt],
    ["--max-ai-messages", String(config.maxAiMessages ?? DEFAULTS.maxAiMessages)],
    ["--inworld-key", config.inworldKey],
    ["--inworld-model", config.inworldModel],
  ];

  for (const [flag, value] of pairs) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    cliArgs.push(flag, String(value));
  }

  return cliArgs;
}

async function getCharacterCatalog() {
  if (characterCatalogCache) {
    return characterCatalogCache;
  }

  const response = await fetch("https://objection.lol/api/assets/character/getPreset");
  if (!response.ok) {
    throw new Error(`Failed to load character catalog: ${response.status}`);
  }

  characterCatalogCache = await response.json();
  return characterCatalogCache;
}

function stopBotProcess() {
  if (!botProcess) {
    return false;
  }

  botProcess.kill("SIGTERM");
  botProcess = null;
  emit("bot:status", { running: false });
  return true;
}

ipcMain.handle("config:defaults", async () => DEFAULTS);
ipcMain.handle("characters:list", async () => getCharacterCatalog());
ipcMain.handle("characters:getById", async (_event, id) => fetchCharacterById(Number(id)));

ipcMain.handle("bot:start", async (_event, config) => {
  if (botProcess) {
    return { ok: false, error: "Bot is already running." };
  }

  const cliArgs = buildCliArgs(config);
  const runtime = resolveBotCommand(cliArgs);

  botProcess = spawn(runtime.command, runtime.args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      OBJECTION_CUSTOM_CHARACTER_IDS: JSON.stringify(config.customCharacterIds ?? []),
      OBJECTION_CAST_OVERRIDES: JSON.stringify(config.castOverrides ?? []),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  emit("bot:status", { running: true });
  emit("bot:log", { level: "system", message: `Launching bot with ${runtime.command} ${runtime.args.join(" ")}` });

  botProcess.stdout.on("data", (chunk) => {
    emit("bot:log", { level: "info", message: chunk.toString() });
  });

  botProcess.stderr.on("data", (chunk) => {
    emit("bot:log", { level: "error", message: chunk.toString() });
  });

  botProcess.on("exit", (code, signal) => {
    emit("bot:log", { level: code === 0 ? "system" : "error", message: `Bot exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}` });
    botProcess = null;
    emit("bot:status", { running: false });
  });

  botProcess.on("error", (error) => {
    emit("bot:log", { level: "error", message: `Failed to start bot: ${error.message}` });
    botProcess = null;
    emit("bot:status", { running: false });
  });

  return { ok: true };
});

ipcMain.handle("bot:stop", async () => ({ ok: stopBotProcess() }));

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopBotProcess();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopBotProcess();
});
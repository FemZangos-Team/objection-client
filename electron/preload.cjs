const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("objectionApp", {
  getDefaults: () => ipcRenderer.invoke("config:defaults"),
  listCharacters: () => ipcRenderer.invoke("characters:list"),
  getCharacterById: (id) => ipcRenderer.invoke("characters:getById", id),
  startBot: (config) => ipcRenderer.invoke("bot:start", config),
  stopBot: () => ipcRenderer.invoke("bot:stop"),
  onBotLog: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("bot:log", handler);
    return () => ipcRenderer.removeListener("bot:log", handler);
  },
  onBotStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("bot:status", handler);
    return () => ipcRenderer.removeListener("bot:status", handler);
  },
});
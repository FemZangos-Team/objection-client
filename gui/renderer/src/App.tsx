import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Avatar,
  AppBar,
  Box,
  Button,
  Chip,
  Container,
  Divider,
  FormControlLabel,
  Grid,
  IconButton,
  InputAdornment,
  List,
  ListItem,
  ListItemAvatar,
  ListItemText,
  Tab,
  Tabs,
  Paper,
  Stack,
  Switch,
  TextField,
  Toolbar,
  Typography,
} from "@mui/material";
import PublicRoundedIcon from "@mui/icons-material/PublicRounded";
import LightModeRoundedIcon from "@mui/icons-material/LightModeRounded";
import SportsEsportsRoundedIcon from "@mui/icons-material/SportsEsportsRounded";
import AccountCircleRoundedIcon from "@mui/icons-material/AccountCircleRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";

type BotLevel = "info" | "error" | "system";
type AppTab = "hoster" | "custom-characters" | "manage-cast";
type CastRole = "Prosecutor" | "Judge" | "Witness" | "Defendant";

interface BotLog {
  id: number;
  level: BotLevel;
  message: string;
}

interface BotConfig {
  roomId?: string;
  roomPass?: string;
  prompt: string;
  playerUsername: string;
  maxAiMessages: number;
  inworldKey: string;
  inworldModel: string;
  customCharacterIds: number[];
  castOverrides: CastOverride[];
}

interface CastOverride {
  slotId: string;
  role: CastRole;
  occurrence: number;
  characterId?: number;
  remove?: boolean;
  nameOverride?: string;
  descriptionOverride?: string;
}

interface CastSlotDefinition {
  slotId: string;
  label: string;
  role: CastRole;
  occurrence: number;
}

interface RawCastOverride {
  slotId?: string;
  role?: string;
  occurrence?: number;
  characterId?: number;
  remove?: boolean;
  nameOverride?: string;
  descriptionOverride?: string;
}

const storageKey = "objection-ai.desktop.config";
const castSlots: CastSlotDefinition[] = [
  { slotId: "prosecutor-0", label: "Prosecutor", role: "Prosecutor", occurrence: 0 },
  { slotId: "judge-0", label: "Judge", role: "Judge", occurrence: 0 },
  { slotId: "witness-0", label: "Witness 1", role: "Witness", occurrence: 0 },
  { slotId: "witness-1", label: "Witness 2", role: "Witness", occurrence: 1 },
  { slotId: "defendant-0", label: "Defendant", role: "Defendant", occurrence: 0 },
  { slotId: "witness-2", label: "Extra Slot", role: "Witness", occurrence: 2 },
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isCastRole(value: string): value is CastRole {
  return value === "Prosecutor" || value === "Judge" || value === "Witness" || value === "Defendant";
}

function sanitizeCastOverrides(overrides: RawCastOverride[] | undefined): CastOverride[] {
  if (!overrides) {
    return [];
  }

  return overrides.flatMap((entry) => {
    const role = entry.role;
    if (!entry.slotId || !isCastRole(role ?? "") || typeof entry.occurrence !== "number") {
      return [];
    }

    return [{
      slotId: entry.slotId,
      role,
      occurrence: entry.occurrence,
      characterId: typeof entry.characterId === "number" ? entry.characterId : undefined,
      remove: Boolean(entry.remove),
      nameOverride: entry.nameOverride ?? "",
      descriptionOverride: entry.descriptionOverride ?? "",
    }];
  });
}

function buildDefaultConfig(defaults: DesktopBotConfig, stored: Partial<BotConfig>): BotConfig {
  return {
    roomId: stored.roomId ?? defaults.roomId ?? "",
    roomPass: stored.roomPass ?? defaults.roomPass ?? "",
    prompt: stored.prompt ?? defaults.prompt,
    playerUsername: stored.playerUsername ?? defaults.playerUsername,
    maxAiMessages: stored.maxAiMessages ?? defaults.maxAiMessages,
    inworldKey: stored.inworldKey ?? defaults.inworldKey,
    inworldModel: stored.inworldModel ?? defaults.inworldModel,
    customCharacterIds: stored.customCharacterIds ?? defaults.customCharacterIds ?? [],
    castOverrides: sanitizeCastOverrides((stored.castOverrides as RawCastOverride[] | undefined) ?? defaults.castOverrides),
  };
}

function ensureCastOverride(config: BotConfig, slot: CastSlotDefinition): CastOverride {
  return config.castOverrides.find((entry) => entry.slotId === slot.slotId) ?? {
    slotId: slot.slotId,
    role: slot.role,
    occurrence: slot.occurrence,
    characterId: undefined,
    remove: false,
    nameOverride: "",
    descriptionOverride: "",
  };
}

export default function App() {
  const [config, setConfig] = useState<BotConfig | null>(null);
  const [tab, setTab] = useState<AppTab>("hoster");
  const [logs, setLogs] = useState<BotLog[]>([]);
  const [running, setRunning] = useState(false);
  const [rememberConfig, setRememberConfig] = useState(true);
  const [errorText, setErrorText] = useState("");
  const [catalog, setCatalog] = useState<DesktopCharacter[]>([]);
  const [customCharacterInput, setCustomCharacterInput] = useState("");
  const desktopBridge = globalThis.window?.objectionApp;

  useEffect(() => {
    let mounted = true;

    if (!desktopBridge) {
      setErrorText("Electron preload failed to initialize. Restart the desktop app after rebuilding.");
      return () => {
        mounted = false;
      };
    }

    void desktopBridge.getDefaults().then((defaults) => {
      if (!mounted) {
        return;
      }

      const persisted = localStorage.getItem(storageKey);
      const parsed = persisted ? JSON.parse(persisted) as Partial<BotConfig> : {};
      setConfig(buildDefaultConfig(defaults, parsed));
    });

    void desktopBridge.listCharacters().then((characters) => {
      if (mounted) {
        setCatalog(characters);
      }
    }).catch((error) => {
      console.error(error);
      setErrorText("Failed to load character catalog.");
    });

    const disposeLogs = desktopBridge.onBotLog((payload) => {
      setLogs((current) => [
        ...current,
        {
          id: Date.now() + Math.random(),
          level: payload.level,
          message: payload.message,
        },
      ]);
    });

    const disposeStatus = desktopBridge.onBotStatus((payload) => {
      setRunning(payload.running);
    });

    return () => {
      mounted = false;
      disposeLogs();
      disposeStatus();
    };
  }, [desktopBridge]);

  useEffect(() => {
    if (!config || !rememberConfig) {
      return;
    }

    localStorage.setItem(storageKey, JSON.stringify(config));
  }, [config, rememberConfig]);

  const canStart = useMemo(() => {
    if (!config) {
      return false;
    }

    return Boolean(normalizeWhitespace(config.roomId ?? "") && normalizeWhitespace(config.playerUsername) && normalizeWhitespace(config.inworldKey));
  }, [config]);

  async function handleStart() {
    if (!config || !desktopBridge) {
      return;
    }

    setErrorText("");
    const response = await desktopBridge.startBot(config);
    if (!response.ok) {
      setErrorText(response.error ?? "Failed to start bot.");
    }
  }

  async function handleStop() {
    if (!desktopBridge) {
      return;
    }

    await desktopBridge.stopBot();
  }

  function updateField<K extends keyof BotConfig>(key: K, value: BotConfig[K]) {
    setConfig((current) => current ? { ...current, [key]: value } : current);
  }

  function updateSlot(slot: CastSlotDefinition, updater: (current: CastOverride) => CastOverride) {
    setConfig((current) => {
      if (!current) {
        return current;
      }

      const existing = ensureCastOverride(current, slot);
      const next = updater(existing);
      const filtered = current.castOverrides.filter((entry) => entry.slotId !== slot.slotId);
      const shouldKeep = next.remove || next.characterId || normalizeWhitespace(next.nameOverride ?? "") || normalizeWhitespace(next.descriptionOverride ?? "");
      return {
        ...current,
        castOverrides: shouldKeep ? [...filtered, next] : filtered,
      };
    });
  }

  async function addCustomCharacter() {
    const characterId = Number(customCharacterInput);
    if (!config || !Number.isInteger(characterId)) {
      return;
    }

    const existingCharacter = catalog.find((entry) => entry.id === characterId);
    const fetchedCharacter = existingCharacter ?? await desktopBridge?.getCharacterById(characterId) ?? null;
    if (!fetchedCharacter) {
      setErrorText(`Character ID ${characterId} was not found.`);
      return;
    }

    setErrorText("");
    setCatalog((current) => current.some((entry) => entry.id === fetchedCharacter.id) ? current : [...current, fetchedCharacter]);
    updateField("customCharacterIds", Array.from(new Set([...config.customCharacterIds, characterId])));
    setCustomCharacterInput("");
  }

  function removeCustomCharacter(characterId: number) {
    if (!config) {
      return;
    }

    updateField("customCharacterIds", config.customCharacterIds.filter((entry) => entry !== characterId));
  }

  function getCharacterById(characterId?: number) {
    return catalog.find((entry) => entry.id === characterId);
  }

  async function handleReplacementCharacterIdChange(slot: CastSlotDefinition, value: string) {
    const characterId = value ? Number(value) : undefined;
    if (!value) {
      updateSlot(slot, (current) => ({ ...current, characterId: undefined }));
      return;
    }

    if (!Number.isInteger(characterId)) {
      return;
    }

    const existingCharacter = getCharacterById(characterId);
    const fetchedCharacter = existingCharacter ?? await desktopBridge?.getCharacterById(characterId) ?? null;
    if (!fetchedCharacter) {
      setErrorText(`Character ID ${characterId} was not found.`);
      return;
    }

    setErrorText("");
    setCatalog((current) => current.some((entry) => entry.id === fetchedCharacter.id) ? current : [...current, fetchedCharacter]);
    updateSlot(slot, (current) => ({ ...current, characterId }));
  }

  function handleTextField<K extends keyof BotConfig>(key: K) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const rawValue = event.currentTarget.value;
      const nextValue = key === "maxAiMessages" ? Number(rawValue) : rawValue;
      updateField(key, nextValue as BotConfig[K]);
    };
  }

  if (!config) {
    return <Box sx={{ minHeight: "100vh", backgroundColor: "background.default" }} />;
  }

  return (
    <Box sx={{ minHeight: "100vh", backgroundColor: "background.default" }}>
      <AppBar position="static" color="primary">
        <Toolbar sx={{ gap: 3 }}>
          <Typography variant="h6" sx={{ fontWeight: 400 }}>objection.lol</Typography>
          <Tabs
            value={tab}
            onChange={(_event, nextValue: AppTab) => setTab(nextValue)}
            textColor="inherit"
            indicatorColor="secondary"
            sx={{ flexGrow: 1, minHeight: 48, '& .MuiTab-root': { minHeight: 48 } }}
          >
            <Tab value="hoster" label="Hoster" />
            <Tab value="custom-characters" label="Custom characters" />
            <Tab value="manage-cast" label="Manage cast" />
          </Tabs>
          <Stack direction="row" spacing={1}>
            <IconButton color="inherit"><PublicRoundedIcon /></IconButton>
            <IconButton color="inherit"><LightModeRoundedIcon /></IconButton>
            <IconButton color="inherit"><SportsEsportsRoundedIcon /></IconButton>
            <IconButton color="inherit"><AccountCircleRoundedIcon /></IconButton>
          </Stack>
        </Toolbar>
      </AppBar>

      <Container maxWidth={false} sx={{ px: { xs: 2, md: 4 }, py: 4 }}>
        <Paper sx={{ p: { xs: 3, md: 4 }, border: "1px solid rgba(255,255,255,0.06)", backgroundColor: "#1a1a1a" }}>
          <Stack spacing={4}>
            <Box>
              <Typography variant="h3" gutterBottom>Courtroom</Typography>
              <Typography variant="h6" color="text.secondary" sx={{ fontSize: 18, fontWeight: 400 }}>
                Configure the host, store custom character IDs, and replace or remove cast slots before launching the bot.
              </Typography>
            </Box>

            {tab === "hoster" ? (
              <Grid container spacing={3}>
                <Grid size={{ xs: 12, md: 6 }}>
                  <TextField fullWidth label="Room ID" value={config.roomId ?? ""} onChange={handleTextField("roomId")} />
                </Grid>
                <Grid size={{ xs: 12, md: 6 }}>
                  <TextField fullWidth label="Password" type="password" value={config.roomPass ?? ""} onChange={handleTextField("roomPass")} />
                </Grid>
                <Grid size={{ xs: 12, md: 6 }}>
                  <TextField fullWidth label="Your Username" value={config.playerUsername} onChange={handleTextField("playerUsername")} helperText="This name is also fed into the AI prompts so characters address you correctly." />
                </Grid>
                <Grid size={{ xs: 12, md: 6 }}>
                  <TextField fullWidth label="Inworld Model" value={config.inworldModel} onChange={handleTextField("inworldModel")} />
                </Grid>
                <Grid size={{ xs: 12, md: 4 }}>
                  <TextField fullWidth type="number" label="Max AI messages" value={String(config.maxAiMessages)} onChange={handleTextField("maxAiMessages")} />
                </Grid>
                <Grid size={{ xs: 12, md: 8 }}>
                  <TextField fullWidth label="Inworld Basic API Key" type="password" value={config.inworldKey} onChange={handleTextField("inworldKey")} />
                </Grid>
                <Grid size={{ xs: 12 }}>
                  <TextField fullWidth multiline minRows={5} label="Story Prompt" value={config.prompt} onChange={handleTextField("prompt")} />
                </Grid>
              </Grid>
            ) : null}

            {tab === "custom-characters" ? (
              <Stack spacing={3}>
                <Alert severity="info">Add custom character preset IDs here. They will be available for quick replacement in the cast manager and can also be appended to the cast if unused.</Alert>
                <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
                  <TextField
                    label="Character ID"
                    value={customCharacterInput}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setCustomCharacterInput(event.currentTarget.value)}
                    InputProps={{ endAdornment: <InputAdornment position="end">ID</InputAdornment> }}
                  />
                  <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={addCustomCharacter}>Add character</Button>
                </Stack>
                <List sx={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 2 }}>
                  {config.customCharacterIds.length === 0 ? (
                    <ListItem><ListItemText primary="No custom characters added yet." secondary="Enter a preset ID to store it here." /></ListItem>
                  ) : config.customCharacterIds.map((characterId) => {
                    const character = getCharacterById(characterId);
                    return (
                      <ListItem
                        key={characterId}
                        secondaryAction={
                          <IconButton color="inherit" onClick={() => removeCustomCharacter(characterId)}>
                            <DeleteOutlineRoundedIcon />
                          </IconButton>
                        }
                      >
                        <ListItemAvatar>
                          <Avatar src={character?.iconUrl}>{character?.name?.[0] ?? "?"}</Avatar>
                        </ListItemAvatar>
                        <ListItemText
                          primary={character ? `${character.name} (#${character.id})` : `Unknown character #${characterId}`}
                          secondary={character ? `${character.side} • ${character.nameplate}` : "This ID is not present in the current catalog."}
                        />
                      </ListItem>
                    );
                  })}
                </List>
              </Stack>
            ) : null}

            {tab === "manage-cast" ? (
              <Stack spacing={3}>
                <Alert severity="info">Each slot can be removed or replaced by a custom character ID. Name overrides let you rename the cast member without changing the preset animation set.</Alert>
                {castSlots.map((slot) => {
                  const override = ensureCastOverride(config, slot);
                  const character = getCharacterById(override.characterId);
                  return (
                    <Paper key={slot.slotId} sx={{ p: 2, border: "1px solid rgba(255,255,255,0.06)", backgroundColor: "rgba(255,255,255,0.02)" }}>
                      <Stack spacing={2}>
                        <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ xs: "flex-start", md: "center" }}>
                          <Box sx={{ flexGrow: 1 }}>
                            <Typography variant="h6">{slot.label}</Typography>
                            <Typography variant="body2" color="text.secondary">{slot.role} slot #{slot.occurrence + 1}</Typography>
                          </Box>
                          <FormControlLabel
                            control={<Switch checked={Boolean(override.remove)} onChange={(event: ChangeEvent<HTMLInputElement>) => {
                              const checked = event.currentTarget.checked;
                              updateSlot(slot, (current) => ({ ...current, remove: checked }));
                            }} />}
                            label="Remove from cast"
                          />
                        </Stack>

                        <Grid container spacing={2}>
                          <Grid size={{ xs: 12, md: 4 }}>
                            <TextField
                              fullWidth
                              type="number"
                              label="Replacement character ID"
                              value={override.characterId ?? ""}
                              onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                                const value = event.currentTarget.value;
                                void handleReplacementCharacterIdChange(slot, value);
                              }}
                              disabled={Boolean(override.remove)}
                            />
                          </Grid>
                          <Grid size={{ xs: 12, md: 4 }}>
                            <TextField
                              fullWidth
                              label="Name override"
                              value={override.nameOverride ?? ""}
                              onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                                const value = event.currentTarget.value;
                                updateSlot(slot, (current) => ({ ...current, nameOverride: value }));
                              }}
                              disabled={Boolean(override.remove)}
                            />
                          </Grid>
                          <Grid size={{ xs: 12, md: 4 }}>
                            <TextField
                              fullWidth
                              label="Description override"
                              value={override.descriptionOverride ?? ""}
                              onChange={(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
                                const value = event.currentTarget.value;
                                updateSlot(slot, (current) => ({ ...current, descriptionOverride: value }));
                              }}
                              disabled={Boolean(override.remove)}
                            />
                          </Grid>
                        </Grid>

                        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                          {config.customCharacterIds.map((characterId) => {
                            const customCharacter = getCharacterById(characterId);
                            return (
                              <Chip
                                key={`${slot.slotId}-${characterId}`}
                                label={customCharacter ? `${customCharacter.name} (#${characterId})` : `#${characterId}`}
                                onClick={() => updateSlot(slot, (current) => ({ ...current, characterId }))}
                                variant={override.characterId === characterId ? "filled" : "outlined"}
                              />
                            );
                          })}
                        </Stack>

                        <Typography color="text.secondary">
                          {override.remove
                            ? "This slot will be removed from the cast."
                            : character
                              ? `Using preset ${character.name} (#${character.id}).`
                              : override.characterId
                                ? `Character #${override.characterId} will be used if it exists in the catalog.`
                                : "Leave blank to keep the generated cast member for this slot."}
                        </Typography>
                      </Stack>
                    </Paper>
                  );
                })}
              </Stack>
            ) : null}

            <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ xs: "stretch", md: "center" }}>
              <FormControlLabel
                control={<Switch checked={rememberConfig} onChange={(event: ChangeEvent<HTMLInputElement>) => setRememberConfig(event.currentTarget.checked)} color="primary" />}
                label="Remember settings"
              />
              <Chip color={running ? "primary" : "default"} label={running ? "Bot Running" : "Bot Stopped"} />
              <Box sx={{ flexGrow: 1 }} />
              <Button variant="contained" size="large" onClick={handleStart} disabled={running || !canStart} sx={{ minWidth: 220 }}>
                Start Courtroom Bot
              </Button>
              <Button variant="outlined" size="large" color="inherit" onClick={handleStop} disabled={!running} sx={{ minWidth: 160 }}>
                Stop
              </Button>
            </Stack>

            {errorText ? (
              <Typography color="error.main">{errorText}</Typography>
            ) : null}

            <Divider sx={{ borderColor: "rgba(255,255,255,0.08)" }} />

            <Box>
              <Typography variant="h5" gutterBottom>Live Output</Typography>
              <Paper sx={{ p: 2, minHeight: 260, maxHeight: 360, overflow: "auto", backgroundColor: "#121416", border: "1px solid rgba(255,255,255,0.05)" }}>
                <Stack spacing={1}>
                  {logs.length === 0 ? (
                    <Typography color="text.secondary">Bot logs will appear here once the process starts.</Typography>
                  ) : logs.map((entry) => (
                    <Typography
                      key={entry.id}
                      component="pre"
                      sx={{
                        m: 0,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontFamily: '"Roboto Mono", monospace',
                        fontSize: 13,
                        color: entry.level === "error" ? "#fda4af" : entry.level === "system" ? "#5eead4" : "#e5e7eb",
                      }}
                    >
                      {entry.message.trimEnd()}
                    </Typography>
                  ))}
                </Stack>
              </Paper>
            </Box>
          </Stack>
        </Paper>
      </Container>
    </Box>
  );
}
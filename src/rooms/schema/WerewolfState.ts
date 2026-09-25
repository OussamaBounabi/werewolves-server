import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema({
  sessionId: t.string().default(""),
  name: t.string().default(""),
  alive: t.boolean().default(true),
  connected: t.boolean().default(true),
  votedFor: t.string().default(""), // day votes are public; cleared each vote phase
  revealedRole: t.string().default(""), // set when the player dies, or for everyone at game over
});
export type PlayerState = SchemaType<typeof PlayerState>;

// Phase: "lobby" | "night" | "mayor" | "succession" | "day" | "vote" | "gameover"
// Night steps, in order: "protector" | "wolves" | "witch_seer" ("" outside the night)
export const WerewolfState = schema({
  // Room settings, editable by the host in the lobby.
  title: t.string().default(""),
  roomType: t.string().default("public"), // "public" | "friends" | "private" — not enforced yet
  maxPlayers: t.number().default(8),
  roundSeconds: t.number().default(30), // day discussion; night steps and votes are fixed
  wolves: t.number().default(2),
  villagers: t.number().default(3),
  seer: t.boolean().default(true),
  witch: t.boolean().default(true),
  protector: t.boolean().default(true),

  phase: t.string().default("lobby"),
  nightStep: t.string().default(""),
  nightRoles: t.string().default(""), // comma-separated roles awake in the current night step
  mayorId: t.string().default(""), // mayor's day vote counts twice
  successionFrom: t.string().default(""), // dead mayor choosing a successor during "succession"
  dayNumber: t.number().default(0),
  phaseEndsAt: t.number().default(0), // epoch ms; client renders its own countdown
  winner: t.string().default(""), // "werewolves" | "villagers" | ""
  hostId: t.string().default(""),
  players: t.map(PlayerState),
});
export type WerewolfState = SchemaType<typeof WerewolfState>;

import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema({
  sessionId: t.string().default(""),
  name: t.string().default(""),
  uid: t.string().default(""), // his account (empty for guests): the app opens his profile card from it
  avatar: t.number().default(0), // his account avatar (1–4), 0 for guests
  alive: t.boolean().default(true),
  connected: t.boolean().default(true),
  votedFor: t.string().default(""), // day votes are public; cleared each vote phase
  revealedRole: t.string().default(""), // set when the player dies, or for everyone at game over
});
export type PlayerState = SchemaType<typeof PlayerState>;

// Phase: "lobby" | "starting" | "night" | "reveal" | "hunter" | "mayor" | "succession" | "day" | "vote" | "gameover"
// ("reveal": the apps play the death card reveals before the game moves on)
// Night steps, in order: "wild_hunter" (odd nights) | "protector" | "wolves" | "witch_seer" ("" outside the night)
export const WerewolfState = schema({
  // Room settings, editable by the host in the lobby. The room is named after its host.
  roomType: t.string().default("public"), // "public" | "friends" | "private" — not enforced yet
  maxPlayers: t.number().default(8),
  roundSeconds: t.number().default(30), // day discussion; night steps and votes are fixed
  wolves: t.number().default(2),
  villagers: t.number().default(3),
  seer: t.boolean().default(true),
  witch: t.boolean().default(true),
  protector: t.boolean().default(true),
  hunter: t.boolean().default(false),
  wildhunter: t.boolean().default(false),
  detective: t.boolean().default(false),
  bear: t.boolean().default(false),
  redhood: t.boolean().default(false),
  tripleface: t.boolean().default(false),

  phase: t.string().default("lobby"),
  nightStep: t.string().default(""),
  nightRoles: t.string().default(""), // comma-separated roles awake in the current night step
  mayorId: t.string().default(""), // mayor's day vote counts twice
  successionFrom: t.string().default(""), // dead mayor choosing a successor during "succession"
  shooterId: t.string().default(""), // dead hunter taking someone with him during "hunter"
  shooterAim: t.string().default(""), // who he's aiming at — public, like the day votes
  dayNumber: t.number().default(0),
  phaseEndsAt: t.number().default(0), // epoch ms; client renders its own countdown
  winner: t.string().default(""), // "werewolves" | "villagers" | "none" (room expired) | ""
  dealt: t.string().default(""), // JSON {role: count} of the roles actually dealt, for "remaining roles"
  spectators: t.number().default(0),
  hostId: t.string().default(""),
  players: t.map(PlayerState),
});
export type WerewolfState = SchemaType<typeof WerewolfState>;

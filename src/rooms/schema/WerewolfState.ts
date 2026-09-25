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

// Phase: "lobby" | "night" | "mayor" | "day" | "vote" | "gameover"
// Night steps, in order: "protector" | "wolves" | "witch_seer" ("" outside the night)
export const WerewolfState = schema({
  phase: t.string().default("lobby"),
  nightStep: t.string().default(""),
  mayorId: t.string().default(""), // mayor's day vote counts twice
  dayNumber: t.number().default(0),
  phaseEndsAt: t.number().default(0), // epoch ms; client renders its own countdown
  winner: t.string().default(""), // "werewolves" | "villagers" | ""
  hostId: t.string().default(""),
  players: t.map(PlayerState),
});
export type WerewolfState = SchemaType<typeof WerewolfState>;

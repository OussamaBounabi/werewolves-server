import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema({
  sessionId: t.string().default(""),
  name: t.string().default(""),
  alive: t.boolean().default(true),
  connected: t.boolean().default(true),
});
export type PlayerState = SchemaType<typeof PlayerState>;

// Phase: "lobby" | "night" | "day" | "vote" | "gameover"
export const WerewolfState = schema({
  phase: t.string().default("lobby"),
  dayNumber: t.number().default(0),
  phaseEndsAt: t.number().default(0), // epoch ms; client renders its own countdown
  winner: t.string().default(""), // "werewolves" | "villagers" | ""
  players: t.map(PlayerState),
});
export type WerewolfState = SchemaType<typeof WerewolfState>;

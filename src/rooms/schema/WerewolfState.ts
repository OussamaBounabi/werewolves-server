import { schema, t, type SchemaType } from "@colyseus/schema";

export const PlayerState = schema({
  sessionId: t.string().default(""),
  name: t.string().default(""),
  uid: t.string().default(""), // his account (empty for guests): the app opens his profile card from it
  avatar: t.number().default(0), // his avatar (see avatars.ts); test clients wear one at random
  frame: t.number().default(0), // his animated frame, 0 none
  alive: t.boolean().default(true),
  connected: t.boolean().default(true),
  votedFor: t.string().default(""), // day votes are public; cleared each vote phase
  revealedRole: t.string().default(""), // set when the player dies, or for everyone at game over
  silenced: t.boolean().default(false), // the black wolf's victim, for the day: no voice, no vote, can't be voted
  voteBonus: t.number().default(0), // today: +2 from the raven, −2 from the owl (everyone sees it)
  infectedShown: t.boolean().default(false), // everyone knows he was infected (revealed by death or the trickster)
});
export type PlayerState = SchemaType<typeof PlayerState>;

// Phase: "lobby" | "starting" | "night" | "reveal" | "hunter" | "mayor" | "succession" | "dictator" | "day" | "vote" |
// "judge" | "joker" | "gameover"
// ("reveal": the apps play the death card reveals before the game moves on)
// Night steps, in order: "doubler" (until he copies) | "cupid" + "lovers" + "wild_child" (night 1) | "green_wolf" + "red_wolf" (night 2+) | "wild_hunter" (odd nights) | "protector" | "wolves" |
// "white_wolf" (even nights) | "wolf_powers" (father / black / green wolves) | "witch_seer" ("" outside the night)
export const WerewolfState = schema({
  // Room settings, editable by the host in the lobby. The room is named after its host.
  roomType: t.string().default("public"), // "public" | "friends" | "private" — not enforced yet
  maxPlayers: t.number().default(8),
  roundSeconds: t.number().default(30), // day discussion
  stepSeconds: t.number().default(10), // each night step, vote, hunter's shot and succession: 10–60s
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
  fatherwolf: t.boolean().default(false),
  blackwolf: t.boolean().default(false),
  whitewolf: t.boolean().default(false),
  bluewolf: t.boolean().default(false), // needs at least one villager in the mix
  greenwolf: t.boolean().default(false),
  redwolf: t.boolean().default(false),
  greenGuesses: t.number().default(3), // the green wolf's guesses for the whole game (one per night)
  mayor: t.boolean().default(true), // play with a mayor (elected after night 1)
  talkingSeer: t.boolean().default(false), // the village hears which role the seer (or triple face) saw
  talkingDetective: t.boolean().default(false), // the village hears the detective's verdict
  cupid: t.boolean().default(false),
  wildchild: t.boolean().default(false),
  dragon: t.boolean().default(false),
  barbe: t.boolean().default(false),
  dictator: t.boolean().default(false),
  judge: t.boolean().default(false),
  trickster: t.boolean().default(false),
  fox: t.boolean().default(false),
  ancient: t.boolean().default(false),
  doubler: t.boolean().default(false),
  joker: t.boolean().default(false),
  raven: t.boolean().default(false),
  owl: t.boolean().default(false),

  phase: t.string().default("lobby"),
  nightStep: t.string().default(""),
  nightRoles: t.string().default(""), // comma-separated roles awake in the current night step
  mayorId: t.string().default(""), // mayor's day vote counts twice
  successionFrom: t.string().default(""), // dead mayor choosing a successor during "succession"
  shooterId: t.string().default(""), // dead hunter taking someone with him during "hunter"
  shooterAim: t.string().default(""), // who he's aiming at — public, like the day votes
  judgeTarget: t.string().default(""), // "judge" phase: the player the vote put out, while the (secret) judge decides
  spared: t.string().default(""), // the judge's revote: this player can't be voted this time
  jokerId: t.string().default(""), // "joker" phase: the voted-out joker picking who dies in his place
  dayNumber: t.number().default(0),
  phaseEndsAt: t.number().default(0), // epoch ms; client renders its own countdown
  winner: t.string().default(""), // "werewolves" | "villagers" | "whitewolf" | "none" (room expired) | ""
  dealt: t.string().default(""), // JSON {role: count} of the roles actually dealt, for "remaining roles"
  spectators: t.number().default(0),
  hostId: t.string().default(""),
  nextRoomId: t.string().default(""), // after the game: the room the host recreated, where "Play again" goes
  players: t.map(PlayerState),
});
export type WerewolfState = SchemaType<typeof WerewolfState>;

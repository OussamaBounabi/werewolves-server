import { Room, Client, ServerError, matchMaker } from "colyseus";
import { WerewolfState, PlayerState } from "./schema/WerewolfState.js";
import { randomAvatar, randomFrame } from "../avatars.js";
import {
  closeVoice, dropFromVoice, grantVoice, NO_VOICE, setVoiceRights, voiceEnabled, voiceParticipants, voiceToken,
  type VoiceRights,
} from "../voice.js";
import {
  accountFor, accountsEnabled, isAdmin, isFriendOfAny, recordResults, rewardFor, useRoleCard, vipLevel, type Account, type GameResult,
} from "../accounts.js";
import { dayKey } from "../missions.js";
import { enterRoom, leaveRoom } from "../presence.js";
import { Abandon, holdSeat, holdSpectator } from "./abandoned.js";
import { emojiAllowed } from "./tableTalk.js";
import { emojisOpen, Kicks, RoomLooks } from "./perks.js";
import { gameStarted } from "../metrics.js";

/** The first roles: each has its own switch in the room state. */
const CLASSIC = [
  "seer", "witch", "protector", "hunter", "wildhunter", "detective", "bear", "redhood", "tripleface",
  "fatherwolf", "blackwolf", "whitewolf", "bluewolf", "greenwolf", "redwolf",
  "cupid", "wildchild", "dragon", "barbe", "dictator", "judge", "trickster",
  "fox", "ancient", "doubler", "joker", "raven", "owl",
] as const;
/** The newer ones: a schema holds 64 fields at most, so their switches share one (state.extraRoles). */
const EXTRA = [
  "idiot", "knight", "brothers", "wolfdog", "juniorwolf", "seerwolf", "bigbadwolf",
  "cat", "littlegirl", "shepherd", "rabbit", "policeman", "mirror", "priest", "alchemist",
  "servant", "puppet", "chameleonwolf", "alien", "bomber", "piper", "guitarist", "killer",
] as const;
/** Room settings added since the state filled up: they share one field too (state.extraOptions). */
const OPTIONS = ["talkingShepherd", "talkingRabbit", "noLivingChat"] as const;
const SPECIALS = [...CLASSIC, ...EXTRA] as const;
type Special = (typeof SPECIALS)[number];
type Role = "werewolf" | "villager" | Special;
type Meta = {
  host: string; hostAvatar: number; hostFrame: number; hostVip: string; roomName: string; roomStyle: string; roomType: string; chat: boolean; started: boolean; players: number; maxPlayers: number;
  spectators: number;
  phase: string; day: number;
};
type JoinOptions = { name?: string; playerId?: string; spectator?: boolean; idToken?: string; admin?: boolean };
type VoteRecord = {
  day: number; excluded: string | null; ballots: Record<string, string>; mayorId: string;
  mayor?: boolean; // the mayor election: [excluded] is the one elected
};
/** One line of the event log; clients render it in their language from [type] and its params. */
type GameEvent = { seq: number; time: number; type: string; [param: string]: unknown };
/** Why a player died — each one has its own line over the card reveal in the app. */
type DeathCause =
  | "wolves" | "witch" | "trap" | "hunter" | "whitewolf" | "vote" | "quit" | "timeout"
  | "love" | "dragon" | "barbe" | "barbe_fail" | "dictator" | "dictator_fail" | "joker" | "knight"
  | "cat" | "mirror" | "priest" | "priest_fail" | "alchemist" | "alien" | "alien_fail" | "bomb" | "guitarist" | "killer"
  | "banned";
/** Loners play for themselves: each kind is a side of its own (two of a kind, after a doubler's copy, share it). */
type Loner = "whitewolf" | "alien" | "bomber" | "piper" | "guitarist" | "killer";
type Team = "wolves" | "village" | Loner;
type Winner = "werewolves" | "villagers" | "lovers" | Loner;
/** One chat line, with its writer's look: his seat id changes when he leaves and comes back, his messages stay his. */
type ChatLine = {
  from: string; name: string; uid: string; avatar: number; frame: number; vip?: string; text: string; at: number;
  wolvesOnly: boolean; // the pack's, at night
  dead?: boolean; // the graveyard's: the dead and the spectators, among themselves
  speaking?: boolean; // no text: a VIP spectator started talking to the dead
};
/** Roles the host picked for the room: counts for wolves/villagers, in-or-out for the rest. */
type Composition = { werewolf: number; villager: number } & Record<Special, boolean>;
/** What the host can change in the lobby (also accepted as create options). */
type Settings = {
  roomType?: string;
  maxPlayers?: number;
  roundSeconds?: number;
  stepSeconds?: number;
  wolves?: number;
  villagers?: number;
  testRole?: string | null;
  greenGuesses?: number;
  mayor?: boolean;
  talkingSeer?: boolean;
  talkingDetective?: boolean;
  narrator?: boolean;
  protectorShield?: boolean;
  seatNumbers?: boolean;
} & Partial<Record<Special | (typeof OPTIONS)[number], boolean>>;
type Potions = { revive: boolean; poison: boolean }; // potions not used yet

const ROLES: readonly Role[] = ["werewolf", "villager", ...SPECIALS];
/** The pack: they wake together to kill. The white wolf hunts with them but plays for himself. */
const WOLF_ROLES: ReadonlySet<Role> = new Set([
  "werewolf", "fatherwolf", "blackwolf", "whitewolf", "bluewolf", "greenwolf", "redwolf", "juniorwolf", "seerwolf", "bigbadwolf",
  "chameleonwolf",
]);
/** Loners play for themselves. */
const LONERS: ReadonlySet<Role> = new Set(["whitewolf", "alien", "bomber", "piper", "guitarist", "killer"]);
/**
 * Loners the pack's bite, the father wolf's infection and the witch's poison can't kill. The dragon and the
 * alchemist can; so can the village's vote, a hunter's shot and the other loners.
 */
const UNTOUCHABLE: ReadonlySet<Role | undefined> = new Set<Role>(["alien", "bomber", "piper", "guitarist", "killer"]);
/** The village's enemies: a game needs at least one of them, and at least one village role. */
const isEvil = (r: Role) => WOLF_ROLES.has(r) || LONERS.has(r);
/** Cards a role puts in the deck: the two brothers come together. */
const cardsOf = (r: Role) => (r === "brothers" ? 2 : 1);
/** Killing the ancient this way (the village's own hand) switches off every village power. */
const VILLAGE_KILLS: readonly DeathCause[] = ["vote", "witch", "hunter", "dragon", "dictator", "alchemist"];
/**
 * Village powers the green wolf can guess — and steal on a right guess: every village role with a power, except the
 * doubler (his copy would replace the thief's own wolf card), the wolfdog (his choice is made on night 1) and the two
 * brothers (a pair). The app offers those dealt in the game.
 */
const STEALABLE: readonly Role[] = [
  "seer", "witch", "protector", "hunter", "wildhunter", "detective", "bear", "redhood", "tripleface",
  "dragon", "barbe", "dictator", "judge", "trickster", "fox", "ancient", "joker", "raven", "owl",
  "cupid", "wildchild", "idiot", "knight", "cat", "littlegirl", "shepherd", "rabbit", "policeman", "mirror", "priest",
  "alchemist", "servant", "puppet",
];
/** When fewer players join than the mix plans, specials leave the deck in this order. */
const DROP_ORDER: readonly Special[] = [
  "killer", "guitarist", "piper", "bomber", "alien", "whitewolf",
  "chameleonwolf", "bigbadwolf", "seerwolf", "juniorwolf", "greenwolf", "redwolf", "blackwolf", "bluewolf", "fatherwolf",
  "puppet", "servant", "alchemist", "priest", "mirror", "policeman", "rabbit", "shepherd", "littlegirl", "cat",
  "wolfdog", "brothers", "knight", "idiot", "owl", "raven", "joker", "doubler", "ancient", "fox",
  "trickster", "judge", "dictator", "barbe", "dragon", "wildchild", "cupid",
  "redhood", "bear", "tripleface", "detective", "wildhunter", "hunter", "protector", "witch", "seer",
];
const ROOM_TYPES = ["public", "friends", "private"];
const ROUND_OPTIONS = [10, ...Array.from({ length: 30 }, (_, i) => (i + 1) * 30)]; // 10s, 30s … 15min
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 16;
const STEP_OPTIONS = [10, 20, 30, 40, 50, 60]; // night steps, votes, the hunter's shot, the mayor's succession
const START_MS = 10_000; // the countdown before the game starts
const RECONNECT_SECONDS = 1200; // a dropped player's seat is held 20 minutes, then he dies
const WOLVES_AGREED_MS = 5_000; // every wolf has voted: the pack's time drops to this
const SPEAKING_LINE_MS = 60_000; // a VIP spectator talking: one line in the graveyard chat a minute at most
const ROOM_LIFESPAN_MS = 2 * 60 * 60_000; // a room lives at most 2 hours from creation
const CLOSE_AFTER_GAME_MS = 60_000; // after the game ends, the room closes a minute later
const MAX_CONNECTIONS = 100; // players + spectators; the player limit is maxPlayers, checked in onAuth
const CHAT_MAX = 200;
const DEAL_MS = 3_500; // the app's role-card deal animation, on top of night 1's first step
const REVEAL_MS = 4_500; // the app's card reveal for one death; the game waits for them before moving on
const LOVERS_MS = 5_000; // night 1: the lovers open their eyes and see each other
const JUDGE_MS = 10_000; // after a vote puts someone out: the judge may order a new vote
const REVOTE_MS = 60_000; // the judge's revote: a one-minute day
const SHRINK_MS = 30_000; // all voters but one have voted: the day ends in 30 seconds
const TIE_MS = 30_000; // the day ends on a tie: this much more to break it

export class WerewolfRoom extends Room<{ state: WerewolfState; metadata: Meta }> {
  maxClients = MAX_CONNECTIONS;
  state = new WerewolfState();

  // Server-only — never synced to clients, so role/night info can't leak.
  private roles = new Map<string, Role>();
  private playerIds = new Map<string, string>(); // sessionId → the account uid (or the device's id for guests)
  private accounts = new Map<string, string>(); // sessionId → account uid, for players signed in
  private members = new Map<string, string>(); // sessionId → account uid, players and spectators
  private invited = new Set<string>(); // account uids invited by someone in the room (friends/private rooms)
  private welcomed = new Set<string>(); // player ids from the room this one replaces (its host recreated it)
  private voiceRights = new Map<string, string>(); // in the voice room → last rights sent ("talk,hear")
  private gameStartedAt = 0;
  private quitAlive = new Map<string, number>(); // left the game while alive → counted as a loss (and when)
  private banned = new Set<string>(); // player ids kicked by the current host
  private spectators = new Set<string>(); // sessionIds watching, not playing
  private admins = new Set<string>(); // god view: invisible, see every role and secret, hear everyone
  private lastGod = "";
  private listedHost = { name: "", avatar: 0, frame: 0, vip: "" }; // the face of the room in the lists
  private dropped = new Set<string>(); // players whose connection dropped (seat held)
  private heldSeats = new Map<string, { reject: Function }>(); // pending reconnections (Colyseus Deferred)
  private voteHistory: VoteRecord[] = [];
  private mayorVote: VoteRecord | null = null; // the election's ballots ("mayor_votes": older apps would take it for a day)
  private emojiAt = new Map<string, number>(); // when each player last showed an emoji (one at a time)
  private known = new Map<string, Record<string, string>>(); // seer / triple face → roles they've seen (for reconnects)
  private detectiveKnown = new Map<string, { a: string; b: string; same: boolean }[]>(); // detective → his checks
  // The event log and chat live on the server, so a reconnecting or relaunched app gets them back.
  private publicLog: GameEvent[] = [];
  private privateLogs = new Map<string, GameEvent[]>(); // sessionId → events only that player saw
  private eventSeq = 0;
  private chatLog: ChatLine[] = [];
  private wolfChatLog: ChatLine[] = [];
  private deadChatLog: ChatLine[] = [];
  private graveChatSent = new Set<string>(); // given the graveyard's chat so far
  private closeTimer: { clear(): void } | null = null;
  // Nobody left to play (every player's app gone for a minute, or no player at all): no winner, and the room closes.
  private abandon = new Abandon(this, () => {
    this.expire();
    void this.disconnect().catch(() => {});
  });
  private rolePicks = new Map<string, Role>(); // the roles VIP Pro players picked for themselves (host or not)
  private vips = new Set<string>(); // sessionIds of VIP accounts (players and spectators)
  private vipPros = new Set<string>(); // …and of VIP Pro ones
  private roleCards = new Set<string>(); // VIPs whose Master card (their role, chosen once a day) isn't played today
  private kicks = new Kicks(this); // who may put whom out of the waiting room (a VIP Pro may choose to stay)
  private looks = new RoomLooks(); // a VIP Pro host's name and style for his room in the lists (kept on his account)
  private get look() {
    return this.looks.of(this.state.hostId);
  }
  private spokeAt = new Map<string, number>(); // VIP spectators: when their last "is speaking" line was written
  private nightNews: string[] = []; // what the narrator tells at dawn: "protected" | "redhood" | "ancient" | "infection"
  private seerNews: Role[] = []; // the talking seer's finds of the night (the role, not who), told at dawn
  private detectiveNews: boolean[] = []; // the talking detective's verdicts of the night, told at dawn
  private phaseTimer: { clear(): void } | null = null;
  private lastSnapshot = "";

  // Per night. A role can have several holders (a doubler's copy, a green wolf's theft): each acts for himself.
  private acting = new Set<string>(); // a one-role step (doubler, protector, red wolf…): its holders still to act
  private afterStep: () => void = () => {}; // …and where the night goes once they all have
  private traps = new Set<string>(); // the Wild Hunters' traps (odd nights)
  private protects = new Map<string, string>(); // protector → who he guards tonight
  private wolfVotes = new Map<string, string>(); // wolf -> target
  private wolfTarget: string | null = null; // who the pack went for — the trap springs even if he was protected
  private wolfVictim: string | null = null; // after protection, Red Hood and ties
  private bigBadTargets = new Map<string, string>(); // big bad wolf → the second victim he picked
  private bigBadVictims: string[] = []; // …those his bite really gets (the witch never sees them)
  private awake = new Set<string>(); // witch/seer step: who still has to act
  private witchActors = new Set<string>(); // acting as a witch tonight (the witches, the triple faces on night 2)
  private reviving = false;
  private poisons = new Map<string, string>(); // poisoner → target
  private paralysed = new Map<string, string>(); // red wolf → his pick: no power for that player tonight
  private whiteTargets = new Set<string>(); // the white wolves' kills (even nights): the cage and a protector's ward stop them
  private powerActors = new Set<string>(); // wolf powers step: father / black wolves still to act
  private infectNow = false; // a father wolf turned the pack's victim instead of killing him
  private silences = new Map<string, string>(); // black wolf → his pick, silenced tomorrow
  private stolenFrom = new Set<string>(); // robbed of their role by a green wolf tonight
  private dragonFires = new Map<string, string>(); // dragon → who he burns tonight
  private tricks = new Set<string>(); // the tricksters' picks: their cards are shown to all at dawn
  private voteMarks: [target: string, bonus: number][] = []; // tomorrow's vote: +2 from a raven, −2 from an owl
  private cages = new Map<string, string>(); // policeman → who he locked up tonight: no power, and nothing can hurt him
  private catVisits = new Map<string, string>(); // cat → the house he sleeps at tonight
  private gifts: { by: string; role: Role; count: number }[] = []; // sheep that came back, chocolates eaten: told at dawn
  private flasks: { by: string; target: string; role: Role }[] = []; // the priests' holy water, the alchemists' poison
  private strums: { by: string; targets: string[]; role: Role }[] = []; // the guitarists' song: two players and a role
  private bombs: { target: string; count: number }[] = []; // planted tonight: who gets each at daybreak, and its length
  private knives = new Map<string, string>(); // killer → his victim tonight (the witch never sees him)

  // Per game
  private potions = new Map<string, Potions>();
  private lastProtected = new Map<string, string>(); // protector → last night's: never the same player two nights in a row
  private lastParalysed = new Map<string, string>(); // red wolf → last night's pick: same rule
  private lastSilenced = new Map<string, string>(); // black wolf → last night's pick: same rule
  private lastCaged = new Map<string, string>(); // policeman → last night's: same rule
  private girlKnown = new Map<string, Record<string, boolean>>(); // hunter → what the little girl showed him: player → with the wolves?
  private dealt = new Set<Role>(); // the roles in this game: what the alien and the guitarist may name
  private charmed = new Set<string>(); // under a piper's spell
  private alienLeft = new Map<string, { village: number; wolves: number }>(); // alien → wrong guesses he can still afford
  private wolfLost = false; // a wolf of the pack has died: the puppet's moment came (it comes once)
  private voteSeq = 0;
  private votedAt = new Map<string, number>(); // voter → when he cast today's vote (the chameleon wolf robs the first)
  private bombFuse = 0; // "bomb" phase: holders still to come before it blows
  private bombFrom = ""; // …and who handed it to its holder: it can't go straight back to him
  private powers = new Map<string, Role>(); // what each player does at night: his role, unless the green wolf stole it
  private infected = new Set<string>(); // joined the pack through the father wolf (they keep their role)
  private infectionUsed = new Set<string>(); // father wolves who have infected (once each)
  private greenLeft = new Map<string, number>(); // green wolf → his guesses left
  private seerCounts = new Map<string, number>(); // "seer>target" → times she looked at him
  private faceFrom = new Map<string, number>(); // a triple face's first night (a servant's: the night she took it over)
  private spent = new Set<string>(); // one-shot powers used: dragon, barbé, dictator, judge
  private lovers: [string, string] | null = null; // cupid's pair: one dies, the other follows
  private wildModel = new Map<string, string>(); // wild child → his model
  private turned = new Set<string>(); // in the pack without a wolf's card: a wild child whose model died, a wolfdog who chose it
  private pendingVote: string[] = []; // the ballots, while the judge decides
  private dayShrunk = false; // today's time already dropped to 30s
  private tieExtended = false; // today's tie already got its extra time
  private armed = new Set<string>(); // dictators who said yes last night: their moment comes at daybreak
  private ancientUsed = new Set<string>(); // ancients who already survived a wolf attack
  private villageDisabled = false; // the ancient died by the village's hand: no village powers any more
  private foxKnown = new Map<string, { ids: string[]; wolf: boolean }[]>(); // fox → his smells (for reconnects)
  private dealTime = 0; // DEAL_MS for the game's first timer (the election, or night 1's first step), then 0
  private revealsPending = 0; // deaths whose card reveal the clients are about to play
  private pendingShooters: string[] = []; // dead hunters waiting for their shot
  private pendingSuccession: string | null = null; // mayor who just died and picks a successor

  // The Flutter client reads state from this plain message instead of Colyseus's binary patches.
  onBeforePatch() {
    this.syncVoice();
    this.syncGraveChat();
    this.sendGod();
    const snapshot = { ...this.state.toJSON(), chat: this.chatOnly };
    const json = JSON.stringify(snapshot);
    if (json === this.lastSnapshot) return;
    this.lastSnapshot = json;
    this.broadcast("state", { ...snapshot, serverNow: Date.now() });
  }

  /** A chat room (so from its creation, for good): no voice, everyone writes in the text chat. */
  private chatOnly = false;
  private get voiceOn() {
    return voiceEnabled && !this.chatOnly;
  }

  onCreate(options: Settings = {}) {
    this.chatOnly = (options as { chat?: unknown }).chat === true;
    this.applySettings(options);
    this.clock.setTimeout(() => this.expire(), ROOM_LIFESPAN_MS);
    if (this.voiceOn) this.clock.setInterval(() => { void this.checkVoice(); }, 1000);

    this.onMessage("settings", (client, msg: Settings) => {
      if (this.state.phase === "lobby" && client.sessionId === this.state.hostId) this.applySettings(msg ?? {});
    });
    this.onMessage("kick", (client, msg: { targetId: string }) => void this.handleKick(client, msg));
    this.onMessage("room_look", (client, msg) => {
      // A VIP Pro host names his room and picks its style, for the lists (and every room he'll host).
      if (client.sessionId !== this.state.hostId || !this.looks.set(client.sessionId, msg)) return;
      this.updateListing();
    });
    this.onMessage("pick_role", (client, msg: { role: string | null }) => this.pickRole(client.sessionId, msg?.role));
    this.onMessage("spectator_speaking", (client) => this.handleSpectatorSpeaking(client));
    this.onMessage("transfer_host", (client, msg: { targetId: string }) => this.handleTransferHost(client, msg));
    this.onMessage("start_game", (client) => this.handleStartGame(client));
    this.onMessage("cancel_start", (client) => this.handleCancelStart(client));
    this.onMessage("trap", (client, msg: { targetId: string }) => this.handleTrap(client, msg));
    this.onMessage("protect", (client, msg: { targetId: string }) => this.handleProtect(client, msg));
    this.onMessage("wolf_target", (client, msg: { targetId: string }) => this.handleWolfTarget(client, msg));
    this.onMessage("seer_peek", (client, msg: { targetId: string }) => this.handleSeerPeek(client, msg));
    this.onMessage("witch_revive", (client) => this.handleWitchRevive(client));
    this.onMessage("witch_poison", (client, msg: { targetId: string }) => this.handleWitchPoison(client, msg));
    this.onMessage("witch_pass", (client) => this.handleWitchPass(client));
    this.onMessage("detective_check", (client, msg: { a: string; b: string }) => this.handleDetective(client, msg));
    this.onMessage("hunter_aim", (client, msg: { targetId: string }) => this.handleHunterAim(client, msg));
    this.onMessage("hunter_shoot", (client, msg: { targetId: string }) => this.handleHunterShoot(client, msg));
    this.onMessage("day_vote", (client, msg: { targetId: string }) => this.handleDayVote(client, msg));
    this.onMessage("mayor_successor", (client, msg: { targetId: string }) => this.handleSuccessor(client, msg));
    this.onMessage("mayor_pass", (client) => this.handleSuccessor(client, null));
    this.onMessage("paralyse", (client, msg: { targetId: string }) => this.handleParalyse(client, msg));
    this.onMessage("white_kill", (client, msg: { targetId: string }) => this.handleWhiteKill(client, msg));
    this.onMessage("infect", (client, msg: { infect: boolean }) => this.handleInfect(client, msg));
    this.onMessage("silence", (client, msg: { targetId: string }) => this.handleSilence(client, msg));
    this.onMessage("green_guess", (client, msg: { targetId: string; role: string }) => this.handleGreenGuess(client, msg));
    this.onMessage("power_pass", (client) => this.handlePowerPass(client));
    this.onMessage("cupid_link", (client, msg: { a: string; b: string }) => this.handleCupid(client, msg));
    this.onMessage("wild_model", (client, msg: { targetId: string }) => this.handleWildModel(client, msg));
    this.onMessage("dragon_fire", (client, msg: { targetId: string }) => this.handleDragon(client, msg));
    this.onMessage("barbe_ask", (client, msg: { targetId: string }) => this.handleBarbe(client, msg));
    this.onMessage("dictator_strike", (client, msg: { targetId: string }) => this.handleDictator(client, msg));
    this.onMessage("trick", (client, msg: { targetId: string }) => this.handleTrick(client, msg));
    this.onMessage("fox_smell", (client, msg: { targetId: string }) => this.handleFox(client, msg));
    this.onMessage("mark", (client, msg: { targetId: string }) => this.handleMark(client, msg));
    this.onMessage("copy", (client, msg: { targetId: string }) => this.handleCopy(client, msg));
    this.onMessage("wolfdog_side", (client, msg: { wolves: boolean }) => this.handleWolfdogSide(client, msg));
    this.onMessage("bigbad_kill", (client, msg: { targetId: string }) => this.handleBigBadKill(client, msg));
    this.onMessage("cage", (client, msg: { targetId: string }) => this.handleCage(client, msg));
    this.onMessage("cat_sleep", (client, msg: { targetId: string }) => this.handleCat(client, msg));
    this.onMessage("girl_pick", (client, msg: { targetId: string }) => this.handleGirl(client, msg));
    this.onMessage("gifts", (client, msg: { targets: string[] }) => this.handleGifts(client, msg));
    this.onMessage("flask", (client, msg: { targetId: string }) => this.handleFlask(client, msg));
    this.onMessage("inherit", (client, msg: { targetId: string }) => this.handleInherit(client, msg));
    this.onMessage("charm", (client, msg: { targets: string[] }) => this.handleCharm(client, msg));
    this.onMessage("strum", (client, msg: { targets: string[]; role: string }) => this.handleStrum(client, msg));
    this.onMessage("bomb_plant", (client, msg: { targetId: string; count: number }) => this.handleBombPlant(client, msg));
    this.onMessage("bomb_pass", (client, msg: { targetId: string }) => this.handleBombPass(client, msg));
    this.onMessage("alien_guess", (client, msg: { targetId: string; role: string }) => this.handleAlienGuess(client, msg));
    this.onMessage("knife", (client, msg: { targetId: string }) => this.handleKnife(client, msg));
    this.onMessage("emoji", (client, msg: { id: string }) => this.handleEmoji(client, msg));
    this.onMessage("joker_pick", (client, msg: { targetId: string }) => this.handleJokerPick(client, msg));
    this.onMessage("dictator_ready", (client, msg: { use: boolean }) => this.handleDictatorReady(client, msg));
    this.onMessage("judge", (client, msg: { revote: boolean }) => this.handleJudge(client, msg));
    this.onMessage("chat", (client, msg: { text: string }) => this.handleChat(client, msg));
    this.onMessage("voice_join", (client) => this.handleVoiceJoin(client));
    // Someone here invited a friend (the invite itself goes through the app's chat): let him in.
    this.onMessage("invite", (client, msg: { uid: string }) => {
      if (!this.members.has(client.sessionId) || typeof msg?.uid !== "string") return;
      this.invited.add(msg.uid);
      if (client.sessionId === this.state.hostId) this.banned.delete(msg.uid); // the host takes his kick back
    });
    this.onMessage("recreated", (client, msg: { roomId: string }) => this.handleRecreated(client, msg));
  }

  /**
   * Runs when the client's socket connects (not on reconnects): the player's account (from his app's
   * Firebase login token), bans, spectators, and the player limit. Returns what onJoin gets as client.auth.
   */
  async onAuth(_client: Client, options: JoinOptions = {}): Promise<{ account: Account | null; admin?: boolean }> {
    // God view: the admin app's login, any room, any phase, invisible.
    if (options.admin) {
      if (!options.idToken || !(await isAdmin(String(options.idToken)))) throw new ServerError(4403, "admin");
      return { account: null, admin: true };
    }
    // ponytail: guests (no token) are still allowed, for the bots and tests; require a token for release.
    let account: Account | null = null;
    if (options.idToken && accountsEnabled) {
      try {
        account = await accountFor(String(options.idToken));
      } catch {
        throw new ServerError(4401, "auth");
      }
    }
    const playerId = account?.uid ?? options.playerId;
    if (playerId && this.banned.has(String(playerId))) throw new ServerError(4403, "banned");
    if (options.spectator && this.state.phase === "lobby") throw new ServerError(4409, "lobby"); // join it instead
    // His own seat is still alive in this game (held while he's away): he comes back to it, he doesn't watch.
    // (Watching would put a living player in the graveyard, hearing the dead.)
    if (options.spectator && playerId && this.livingSeatOf(String(playerId))) throw new ServerError(4409, "seated");
    await this.checkRoomType(account, playerId);
    if (playerId && this.deadSeatOf(String(playerId))) return { account }; // back to his seat, among the dead
    if (!options.spectator) {
      if (this.state.phase !== "lobby") throw new ServerError(4409, "started");
      const seated = playerId !== undefined && [...this.playerIds.values()].includes(String(playerId)); // takes his seat back
      if (!seated && this.state.players.size >= this.state.maxPlayers) throw new ServerError(4409, "full");
    }
    return { account };
  }

  /**
   * Public rooms are open. Friends rooms: invited players, or friends of someone already in the room.
   * Private rooms: invited players only. The first player (the host creating it) always gets in.
   */
  private async checkRoomType(account: Account | null, playerId?: unknown) {
    const type = this.state.roomType;
    if (type === "public" || this.members.size === 0 && this.state.players.size === 0) return;
    if (account && this.invited.has(account.uid)) return;
    if (playerId && this.welcomed.has(String(playerId))) return; // played the last game with the host
    if (type === "friends" && account && (await isFriendOfAny(account.uid, [...new Set(this.members.values())]))) return;
    throw new ServerError(4410, type === "private" ? "private" : "friends");
  }

  onJoin(client: Client, options: JoinOptions = {}) {
    this.looks.join(client.sessionId, client.auth?.account);
    if (client.auth?.admin) {
      this.admins.add(client.sessionId);
      this.sendGodHistory(client);
      this.lastGod = ""; // send him the god state with the next patch…
      this.lastSnapshot = ""; // …and the game itself (his joining changes nothing in it: it could wait for minutes)
      return; // not a player, not a spectator, not in the listing
    }
    this.sendHistory(client);
    if (client.auth?.account?.vip) this.vips.add(client.sessionId);
    if (client.auth?.account?.vipPro) this.vipPros.add(client.sessionId);
    else if (client.auth?.account?.vip && client.auth.account.roleCardDay !== dayKey()) this.roleCards.add(client.sessionId);
    const uid: string | undefined = client.auth?.account?.uid;
    if (uid) {
      this.members.set(client.sessionId, uid);
      enterRoom(uid, this.roomName, this.roomId);
    }
    const returning = this.deadSeatOf(String(client.auth?.account?.uid ?? options.playerId ?? ""));
    if (returning) return this.retakeSeat(client, returning);
    if (options.spectator) {
      this.spectators.add(client.sessionId);
      this.state.spectators = this.spectators.size;
      return this.updateListing();
    }
    const account: Account | null = client.auth?.account ?? null;
    const name = account?.name ?? (String(options.name ?? "").trim().slice(0, 24) || `Player-${client.sessionId.slice(0, 4)}`);
    const playerId = account?.uid ?? String(options.playerId ?? client.sessionId);
    // Same account (or device) already seated: a join its app gave up on (slow network). That seat goes.
    const ghost = [...this.playerIds].find(([sid, pid]) => pid === playerId && sid !== client.sessionId)?.[0];
    const wasHost = ghost !== undefined && this.state.hostId === ghost;
    if (ghost !== undefined) this.dropGhost(ghost);
    this.playerIds.set(client.sessionId, playerId);
    if (account) this.accounts.set(client.sessionId, account.uid);
    this.state.players.set(client.sessionId, new PlayerState({
      sessionId: client.sessionId,
      name,
      uid: account?.uid ?? "",
      avatar: account?.avatar ?? randomAvatar(), // no account (a test client): a character at random
      frame: account?.frame ?? randomFrame(),
      vip: vipLevel(account),
    }));
    if (ghost === undefined) this.logEvent(this.state.hostId ? "joined" : "created", { name });
    if (!this.state.hostId || wasHost) this.setHost(client.sessionId);
    this.updateListing();
    this.abandon.check(this.state.players.values());
  }

  /** During a game: the seat of this account (or device) if he's dead and no longer connected. */
  /** The seat of this account (or device) in the running game, if its player is alive. */
  private livingSeatOf(playerId: string): string | undefined {
    if (!playerId || !this.gameRunning()) return undefined;
    const seat = [...this.playerIds].find(([, pid]) => pid === playerId)?.[0];
    return seat && this.isAlive(seat) ? seat : undefined;
  }

  private deadSeatOf(playerId: string): string | undefined {
    if (!playerId || !this.gameRunning()) return undefined;
    const seat = [...this.playerIds].find(([, pid]) => pid === playerId)?.[0];
    return seat && !this.isAlive(seat) && !this.clients.getById(seat) ? seat : undefined;
  }

  /**
   * A dead player who left comes back: his old seat moves to his new connection (same place in the
   * circle), so he's a dead player again — the graveyard voice, his role and his log.
   */
  private retakeSeat(client: Client, old: string) {
    const id = client.sessionId;
    const moveKey = <V>(map: Map<string, V>) => {
      if (!map.has(old)) return;
      map.set(id, map.get(old)!);
      map.delete(old);
    };
    for (const map of [this.roles, this.powers, this.playerIds, this.accounts, this.privateLogs, this.quitAlive] as Map<
      string,
      unknown
    >[]) {
      moveKey(map);
    }
    for (const set of [this.infected, this.spent, this.turned, this.charmed]) if (set.delete(old)) set.add(id);
    if (this.lovers) this.lovers = this.lovers.map((l) => (l === old ? id : l)) as [string, string];
    for (const [child, model] of this.wildModel) if (model === old) this.wildModel.set(child, id);
    // Rebuild the seats in the same order, his under the new id.
    const seats = [...this.state.players.entries()];
    this.state.players.clear();
    for (const [sid, p] of seats) {
      if (sid !== old) {
        this.state.players.set(sid, p);
        continue;
      }
      this.state.players.set(id, new PlayerState({ ...p.toJSON(), sessionId: id, connected: true }));
    }
    if (this.state.hostId === old) this.state.hostId = id; // the host is back: still the host
    this.dropped.delete(old);
    this.heldSeats.delete(old);
    this.graveSent.delete(old);
    if (this.voiceRights.delete(old)) dropFromVoice(this.roomId, old).catch(() => {});
    client.send("seat_back");
    this.sendRole(id);
    this.sendHistory(client); // with his private lines, now under his new id
    if (this.lovers?.includes(id)) this.clients.getById(id)?.send("lovers", { ids: this.lovers });
    this.updateListing();
    this.abandon.check(this.state.players.values());
  }

  /** Quietly removes an older seat of a player who just joined again (lobby only). */
  private dropGhost(id: string) {
    this.members.delete(id); // his account is still here: keep users.room
    this.accounts.delete(id);
    if (this.voiceRights.delete(id)) dropFromVoice(this.roomId, id).catch(() => {});
    this.heldSeats.get(id)?.reject("replaced");
    this.heldSeats.delete(id);
    this.dropped.delete(id);
    this.state.players.delete(id);
    this.playerIds.delete(id);
    this.rolePicks.delete(id);
    this.clients.getById(id)?.leave(4001);
  }

  /** Adds to the event log and sends it: to everyone, or only to [onlyFor] (kept for his reconnects). */
  private logEvent(type: string, params: Record<string, unknown> = {}, onlyFor?: string) {
    const event: GameEvent = { seq: ++this.eventSeq, time: Date.now(), type, ...params };
    if (!onlyFor) {
      this.publicLog.push(event);
      this.broadcast("event", event);
      return;
    }
    if (!this.privateLogs.has(onlyFor)) this.privateLogs.set(onlyFor, []);
    this.privateLogs.get(onlyFor)!.push(event);
    this.clients.getById(onlyFor)?.send("event", event);
    for (const admin of this.admins) this.clients.getById(admin)?.send("event", { ...event, for: this.nameOf(onlyFor) });
  }

  /** God view: the whole log (every player's private lines, tagged) and both chats. */
  private sendGodHistory(client: Client) {
    const all = [...this.publicLog];
    for (const [id, events] of this.privateLogs) for (const e of events) all.push({ ...e, for: this.nameOf(id) });
    client.send("events", all.sort((a, b) => a.seq - b.seq));
    client.send("chat_history", [...this.chatLog, ...this.wolfChatLog, ...this.deadChatLog].sort((a, b) => a.at - b.at));
    client.send("vote_history", this.voteHistory);
    if (this.mayorVote) client.send("mayor_votes", this.mayorVote);
  }

  /** God view: every player's role and the night's secrets, sent to admins when it changes. */
  private sendGod() {
    if (this.admins.size === 0) return;
    // ponytail: the admin app shows one name per line — of two holders of a role it sees the first; send lists when it can
    const one = (ids: Iterable<string>) => [...ids][0] ?? null;
    const marked = (sign: number) => one(this.voteMarks.filter(([, bonus]) => bonus * sign > 0).map(([id]) => id));
    const god = {
      roles: Object.fromEntries(this.roles),
      powers: Object.fromEntries([...this.roles.keys()].map((id) => [id, this.powerOf(id)])),
      pack: this.packIds(),
      infected: [...this.infected],
      lovers: this.lovers ?? [],
      wildModel: one(this.wildModel.values()),
      wolfVotes: Object.fromEntries(this.wolfVotes),
      night: {
        protect: one(this.protects.values()),
        trap: one(this.traps),
        paralysed: one(this.paralysed.values()),
        silence: one(this.silences.values()),
        white: one(this.whiteTargets),
        dragon: one(this.dragonFires.values()),
        poisons: Object.fromEntries(this.poisons),
        reviving: this.reviving,
        raven: marked(1),
        owl: marked(-1),
        // Every move of the night by who made it (the admin app's night tab; the lines above are the older app's).
        protects: Object.fromEntries(this.protects),
        traps: [...this.traps],
        paralyses: Object.fromEntries(this.paralysed),
        cages: Object.fromEntries(this.cages),
        silences: Object.fromEntries(this.silences),
        whites: [...this.whiteTargets],
        bigBad: Object.fromEntries(this.bigBadTargets),
        knives: Object.fromEntries(this.knives),
        fires: Object.fromEntries(this.dragonFires),
        cats: Object.fromEntries(this.catVisits),
        flasks: this.flasks,
        strums: this.strums,
        bombs: this.bombs,
        marks: this.voteMarks,
        wolfTarget: this.wolfTarget,
        wolfVictim: this.wolfVictim,
      },
      villageDisabled: this.villageDisabled,
    };
    const json = JSON.stringify(god);
    if (json === this.lastGod) return;
    this.lastGod = json;
    for (const admin of this.admins) this.clients.getById(admin)?.send("god", god);
  }

  /** Everything a (re)joining app needs to rebuild its screens: event log, chat, vote history. */
  private sendHistory(client: Client) {
    const id = client.sessionId;
    const mine = this.privateLogs.get(id) ?? [];
    client.send("events", [...this.publicLog, ...mine].sort((a, b) => a.seq - b.seq));
    client.send("chat_history", this.chatFor(id));
    client.send("vote_history", this.voteHistory);
    if (this.mayorVote) client.send("mayor_votes", this.mayorVote);
  }

  /** The chat [id] may read, oldest first: everyone's, the pack's for the pack, the graveyard's for who is in it. */
  private chatFor(id: string) {
    const lines = [...this.chatLog];
    if (this.isPack(id) && this.isAlive(id)) lines.push(...this.wolfChatLog);
    if (this.inGraveyard(id)) lines.push(...this.deadChatLog);
    return lines.sort((a, b) => a.at - b.at);
  }

  /** Runs before each patch: whoever just left the game (died, or came to watch) gets the graveyard's chat so far. */
  private syncGraveChat() {
    if (!this.gameRunning()) return this.graveChatSent.clear();
    for (const client of this.clients) {
      const id = client.sessionId;
      if (this.graveChatSent.has(id) || this.admins.has(id) || !this.inGraveyard(id)) continue;
      this.graveChatSent.add(id);
      client.send("chat_history", this.chatFor(id)); // (a wolf who just died loses the pack's lines too)
    }
  }

  private nameOf(id: string | null | undefined) {
    return (id && this.state.players.get(id)?.name) || null;
  }

  // Network drop or app closed: hold the seat 20 minutes so the app can come back.
  onDrop(client: Client) {
    if (this.spectators.has(client.sessionId)) return holdSpectator(this, client);
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = false;
    this.dropped.add(client.sessionId);
    this.maybeShrinkDay(); // he no longer counts among today's voters
    this.heldSeats.set(client.sessionId, holdSeat(this, client, RECONNECT_SECONDS));
    this.abandon.check(this.state.players.values());
  }

  onReconnect(client: Client) {
    const id = client.sessionId;
    const player = this.state.players.get(id);
    if (player) player.connected = true;
    this.dropped.delete(id);
    this.heldSeats.delete(id);
    // Private messages sent while away are lost, and a relaunched app knows nothing: send it all again.
    this.sendRole(id);
    const role = this.powerOf(id);
    if (this.known.has(id)) client.send("seer_known", this.known.get(id));
    if (role === "detective") client.send("detective_known", this.detectiveKnown.get(id) ?? []);
    if (this.state.players.get(id)?.silenced) client.send("silenced");
    const step = this.state.nightStep;
    if (this.isPack(id) && step === "wolves") client.send("wolf_votes", Object.fromEntries(this.wolfVotes));
    if (step === "witch_seer" && this.witchActors.has(id) && this.awake.has(id)) this.sendWitchTurn(id);
    if (step === "protector" && this.acting.has(id)) this.sendProtectorTurn(id);
    if (step === "red_wolf" && this.acting.has(id)) client.send("red_turn", { blocked: this.lastParalysed.get(id) ?? null });
    if (step === "big_bad_wolf" && this.acting.has(id)) client.send("bigbad_turn", { blocked: this.wolfTarget });
    if (step === "policeman" && this.acting.has(id)) client.send("policeman_turn", { blocked: this.lastCaged.get(id) ?? null });
    if (this.state.phase === "night" && this.isCaged(id)) client.send("caged");
    if (this.girlKnown.has(id)) client.send("girl_known", this.girlKnown.get(id));
    if (this.charmed.has(id) || role === "piper") client.send("charmed", { ids: [...this.charmed] });
    if (this.alienLeft.has(id)) client.send("alien_left", this.alienLeft.get(id));
    if (step === "wolf_powers" && this.powerActors.has(id)) this.sendPowerTurn(id);
    if (step === "green_wolf" && this.acting.has(id)) client.send("green_turn", { left: this.greenLeft.get(id) ?? 0 });
    if (this.foxKnown.has(id)) client.send("fox_known", this.foxKnown.get(id));
    if (this.lovers && (this.lovers.includes(id) || role === "cupid")) {
      const partner = this.lovers.find((l) => l !== id && this.lovers!.includes(id));
      client.send("lovers", { ids: this.lovers, ...(partner ? { roles: { [partner]: this.roles.get(partner) } } : {}) });
    }
    if (this.wildModel.has(id)) client.send("wild_model", { targetId: this.wildModel.get(id) });
    this.sendHistory(client);
    client.send("state", { ...this.state.toJSON(), serverNow: Date.now() });
    this.abandon.check(this.state.players.values());
  }

  onLeave(client: Client) {
    const id = client.sessionId;
    if (this.admins.delete(id)) {
      if (this.voiceRights.delete(id)) dropFromVoice(this.roomId, id).catch(() => {});
      this.graveSent.delete(id);
      return;
    }
    this.clearRoomOf(id);
    if (this.voiceRights.delete(id)) dropFromVoice(this.roomId, id).catch(() => {});
    this.graveSent.delete(id);
    if (this.spectators.delete(id)) {
      this.state.spectators = this.spectators.size;
      return this.updateListing();
    }
    const player = this.state.players.get(id);
    const timedOut = this.dropped.delete(id);
    this.heldSeats.delete(id);
    if (!player) return;
    if (this.state.phase === "lobby" || this.state.phase === "starting") {
      this.removeFromLobby(id); // during the start countdown he just misses the game
    } else if (this.state.phase !== "gameover") {
      // Quitting on purpose is final; a dropped player who never came back dies too.
      player.connected = false;
      this.removeFromGame(id, timedOut ? "timeout" : "quit");
    } else {
      player.connected = false;
      this.passHostIfGone();
    }
    this.updateListing();
    this.abandon.check(this.state.players.values());
  }

  private removeFromLobby(id: string, how: "left" | "kicked" | "removed" = "left") {
    this.logEvent(how, { name: this.nameOf(id) });
    this.rolePicks.delete(id);
    this.state.players.delete(id);
    this.playerIds.delete(id);
    if (this.state.hostId !== id) return;
    const next = this.state.players.keys().next().value ?? "";
    this.setHost(next);
    if (next) this.logEvent("new_host", { name: this.nameOf(next) });
  }

  /** A player gone for good mid-game dies on the spot, outside any night/vote resolution. */
  private removeFromGame(id: string, reason: "quit" | "timeout" | "banned") {
    if (!this.isAlive(id)) return;
    this.quitAlive.set(id, Date.now()); // leaving alive is a loss, whatever his team does
    this.kill(id, reason);
    const role = this.roles.get(id);
    this.broadcast("player_gone", { id, reason, role });
    this.logEvent("player_gone", { name: this.nameOf(id), role, reason, ...this.deathMarks(id) });
    if (this.pendingSuccession === id) {
      // He isn't here to name a successor: the village has no mayor from now on.
      this.pendingSuccession = null;
      this.stand(id);
      this.broadcast("mayor_result", { mayorId: null, successor: true });
      this.logEvent("mayor", { name: null, successor: true });
    }
    this.endGameIfOver();
  }

  /**
   * Waiting room only: removes a player and bans him until the host changes. By the host, or by a VIP Pro who isn't (5 a
   * month); a VIP Pro may choose to stay, or to leave (then he simply left: no ban).
   */
  private async handleKick(client: Client, msg: { targetId: string }) {
    const target = msg?.targetId, by = client.sessionId;
    if (this.state.phase !== "lobby" || !this.state.players.has(by)) return;
    if (!target || target === by || !this.state.players.has(target)) return;
    const face = (id: string) => ({ uid: this.accounts.get(id) ?? "", vip: this.vipPros.has(id) ? "pro" : "" });
    const how = await this.kicks.decide(face(by), this.nameOf(by), by === this.state.hostId, face(target), this.clients.getById(target));
    if (typeof how === "object") return client.send("error", how);
    if (this.state.phase !== "lobby" || !this.state.players.has(target)) return; // (it started, or he left, meanwhile)
    if (how === "kicked") this.banned.add(this.playerIds.get(target) ?? target);
    this.heldSeats.get(target)?.reject(how); // a disconnected player's held seat
    const kicked = this.clients.getById(target);
    if (how === "kicked") kicked?.send("kicked");
    this.removeFromLobby(target, how); // "X left the room" when a VIP Pro chose to go
    this.updateListing();
    kicked?.leave(4000);
  }

  /** Support banned this player: out at once, everyone told "removed by support"; in a game he dies on the spot. */
  removeBanned(uid: string) {
    for (const [id, member] of [...this.members]) {
      if (member !== uid) continue;
      if (this.state.players.has(id)) {
        if (this.state.phase === "lobby" || this.state.phase === "starting") this.removeFromLobby(id, "removed");
        else if (this.gameRunning()) this.removeFromGame(id, "banned");
        this.updateListing();
      }
      this.clients.getById(id)?.leave(4000); // (4000: a leave, not a drop — no seat held for him)
    }
  }

  /** The host hands the room over to another player at the table (who is here): at any time, the game running or not. */
  private handleTransferHost(client: Client, msg: { targetId: string }) {
    const target = msg?.targetId;
    if (client.sessionId !== this.state.hostId || !target || target === client.sessionId) return;
    if (!this.state.players.get(target)?.connected) return;
    this.setHost(target);
    this.logEvent("new_host", { name: this.nameOf(target) });
  }

  /** The room's time limit: an unfinished game ends with no winner (endGame then closes the room). */
  private expire() {
    if (this.state.phase !== "gameover") this.endGame(null);
  }

  /**
   * What the lobby screen lists for this room. Its face is its host's; once the game runs, the host it started with,
   * even after he left.
   */
  private updateListing() {
    const host = this.state.players.get(this.state.hostId);
    const waiting = this.state.phase === "lobby" || this.state.phase === "starting";
    if (host && (waiting || !this.listedHost.name)) {
      this.listedHost = { name: host.name, avatar: host.avatar, frame: host.frame, vip: host.vip };
    }
    this.setMatchmaking({
      maxClients: MAX_CONNECTIONS,
      metadata: {
        host: this.listedHost.name,
        hostAvatar: this.listedHost.avatar,
        hostFrame: this.listedHost.frame,
        hostVip: this.listedHost.vip,
        roomName: this.look.name,
        roomStyle: this.look.style,
        roomType: this.state.roomType,
        chat: this.chatOnly,
        started: this.state.phase !== "lobby", // "starting" counts: joining is closed
        players: this.state.players.size,
        maxPlayers: this.state.maxPlayers,
        spectators: this.spectators.size,
        phase: this.state.phase,
        day: this.state.dayNumber,
      },
    });
  }

  /** Validates and applies host settings; anything missing or invalid keeps its current value. */
  private applySettings(s: Settings) {
    const st = this.state;
    const int = (v: unknown, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v)) || min));
    if (ROOM_TYPES.includes(s.roomType as string)) st.roomType = s.roomType as string;
    if (s.maxPlayers !== undefined) st.maxPlayers = int(s.maxPlayers, Math.max(MIN_PLAYERS, st.players.size), MAX_PLAYERS);
    if (ROUND_OPTIONS.includes(Number(s.roundSeconds))) st.roundSeconds = Number(s.roundSeconds);
    if (STEP_OPTIONS.includes(Number(s.stepSeconds))) st.stepSeconds = Number(s.stepSeconds);
    if (s.wolves !== undefined) st.wolves = int(s.wolves, 0, 8); // special wolves or a loner can stand in
    if (s.villagers !== undefined) st.villagers = int(s.villagers, 0, 12);
    for (const r of CLASSIC) if (typeof s[r] === "boolean") st[r] = s[r];
    const extra = new Set(st.extraRoles.split(","));
    for (const r of EXTRA) if (typeof s[r] === "boolean") s[r] ? extra.add(r) : extra.delete(r);
    st.extraRoles = EXTRA.filter((r) => extra.has(r)).join(",");
    const options = new Set(st.extraOptions.split(","));
    for (const o of OPTIONS) if (typeof s[o] === "boolean") s[o] ? options.add(o) : options.delete(o);
    st.extraOptions = OPTIONS.filter((o) => options.has(o)).join(",");
    if (s.greenGuesses !== undefined) st.greenGuesses = int(s.greenGuesses, 1, 5);
    for (const key of ["mayor", "talkingSeer", "talkingDetective", "seatNumbers", "narrator", "protectorShield"] as const) {
      if (typeof s[key] === "boolean") st[key] = s[key];
    }
    if (st.villagers === 0) st.bluewolf = false; // he hides behind a simple villager
    if (s.testRole !== undefined) this.pickRole(st.hostId, s.testRole); // the host's own role (a VIP Pro's)
    this.updateListing();
  }

  /** After the game, recreating the room is the host's: if he's gone for good, the first player still here. */
  private passHostIfGone() {
    const host = this.state.hostId;
    if (this.state.players.get(host)?.connected || this.dropped.has(host)) return; // a dropped host may come back
    const next = [...this.state.players.values()].find((p) => p.connected)?.sessionId;
    if (!next) return;
    this.setHost(next);
    this.logEvent("new_host", { name: this.nameOf(next) });
  }

  /**
   * The host made a new room for the next game (the app creates it with this one's settings, then tells us):
   * "Play again" then takes everyone there. The new room must confirm he's its host, and lets this table in.
   */
  private async handleRecreated(client: Client, msg: { roomId: string }) {
    const roomId = typeof msg?.roomId === "string" ? msg.roomId : "";
    if (this.state.phase !== "gameover" || client.sessionId !== this.state.hostId || this.state.nextRoomId) return;
    if (!roomId || roomId === this.roomId) return;
    const table = [...this.state.players.keys()].map((id) => this.playerIds.get(id) ?? "").filter((id) => id);
    try {
      const host = this.playerIds.get(client.sessionId) ?? "";
      if ((await matchMaker.remoteRoomCall<WerewolfRoom>(roomId, "welcome", [host, table])) !== true) return;
    } catch {
      return; // no such room, or not a werewolf one
    }
    if (this.state.phase === "gameover") this.state.nextRoomId = roomId;
  }

  /** Called by the room this one replaces (see handleRecreated): its players may come in, even if private. */
  welcome(hostPlayerId: string, playerIds: string[]) {
    if (this.state.phase !== "lobby" || !hostPlayerId || this.playerIds.get(this.state.hostId) !== hostPlayerId) {
      return false;
    }
    for (const id of playerIds) if (typeof id === "string" && id) this.welcomed.add(id);
    return true;
  }

  private setHost(sessionId: string) {
    if (this.state.hostId !== sessionId) this.banned.clear(); // a new host lifts the old host's bans
    this.state.hostId = sessionId;
    this.updateListing();
  }

  /**
   * A player's own role, picked in the waiting room (anything else: at random), dealt to him if the game has it: a VIP
   * Pro's every game, a VIP's with his Master card (once a day).
   */
  private pickRole(id: string, role: unknown) {
    const waiting = this.state.phase === "lobby" || this.state.phase === "starting";
    if (!waiting || !(this.vipPros.has(id) || this.roleCards.has(id)) || !this.state.players.has(id)) return;
    if (ROLES.includes(role as Role)) this.rolePicks.set(id, role as Role);
    else this.rolePicks.delete(id);
  }

  // ---- lobby ----

  private handleStartGame(client: Client) {
    if (this.state.phase !== "lobby") return;
    if (client.sessionId !== this.state.hostId) {
      client.send("error", { code: "not_host" });
      return;
    }
    if (this.state.players.size < MIN_PLAYERS) {
      client.send("error", { code: "not_enough_players", min: MIN_PLAYERS });
      return;
    }
    if (!this.mixIsPlayable()) {
      client.send("error", { code: "bad_mix" });
      return;
    }
    // A 10-second countdown everyone sees; joining closes now (onAuth), spectators still welcome.
    this.state.phase = "starting";
    this.logEvent("starting");
    this.setPhaseTimer(START_MS, () => this.beginGame());
    this.updateListing();
  }

  /** At least one village role, and at least one wolf (of any kind) or loner. */
  private mixIsPlayable(): boolean {
    const st = this.state;
    const on = this.mixOf();
    return st.villagers + on.filter((r) => !isEvil(r)).length > 0 && st.wolves + on.filter(isEvil).length > 0;
  }

  /** A room setting kept in state.extraOptions. */
  private option(name: (typeof OPTIONS)[number]): boolean {
    return this.state.extraOptions.split(",").includes(name);
  }

  /** The special roles the host put in the mix. */
  private mixOf(): Special[] {
    const extra = this.state.extraRoles.split(",");
    return [...CLASSIC.filter((r) => this.state[r]), ...EXTRA.filter((r) => extra.includes(r))];
  }

  private handleCancelStart(client: Client) {
    if (this.state.phase !== "starting" || client.sessionId !== this.state.hostId) return;
    this.backToLobby("host");
  }

  private backToLobby(reason: "host" | "players") {
    this.phaseTimer?.clear();
    this.state.phase = "lobby";
    this.state.phaseEndsAt = 0;
    this.logEvent("start_cancelled", { reason });
    this.updateListing();
  }

  private beginGame() {
    if (this.state.players.size < MIN_PLAYERS) return this.backToLobby("players"); // people left during the countdown
    // The waiting-room log is over; the game's log starts fresh.
    this.publicLog = [];
    this.gameStartedAt = Date.now();
    this.privateLogs.clear();
    this.chatLog = [];
    this.deadChatLog = [];
    this.broadcast("events", []);
    gameStarted("werewolf"); // (the admin app's numbers)
    this.assignRoles();
    this.dealTime = DEAL_MS;
    // The roles dealt, the village elects its mayor (if it plays with one), then the first night falls.
    if (this.state.mayor) this.startMayorVote();
    else this.startNight();
    this.updateListing();
  }

  private assignRoles() {
    const ids = [...this.state.players.keys()];
    const st = this.state;
    const mix = { werewolf: st.wolves, villager: st.villagers } as Composition;
    const on = this.mixOf();
    for (const r of SPECIALS) mix[r] = on.includes(r);
    const deck = buildDeck(mix, ids.length);

    // Players who picked their role get it, if the game has it (one card each: the first to pick it). A VIP's Master
    // card is spent for the day.
    for (const [id, role] of this.rolePicks) {
      if (!ids.includes(id) || !deck.includes(role)) continue;
      deck.splice(deck.indexOf(role), 1);
      this.roles.set(id, role);
      ids.splice(ids.indexOf(id), 1);
      if (this.roleCards.delete(id)) useRoleCard(this.accounts.get(id) ?? "").catch((e) => console.error("master card", e));
    }

    shuffle(deck);
    ids.forEach((id, i) => this.roles.set(id, deck[i]));
    // VIP Pro: a better chance of a special role. One dealt a plain villager swaps, one time in two, with someone else's
    // special card.
    for (const id of ids) {
      if (!this.vipPros.has(id) || this.roles.get(id) !== "villager" || Math.random() < 0.5) continue;
      const others = ids.filter((o) => !this.vipPros.has(o) && this.roles.get(o) !== "villager");
      if (others.length === 0) continue;
      const other = others[Math.floor(Math.random() * others.length)];
      this.roles.set(id, this.roles.get(other)!);
      this.roles.set(other, "villager");
    }
    const dealt: Record<string, number> = {};
    for (const role of this.roles.values()) dealt[role] = (dealt[role] ?? 0) + 1;
    this.state.dealt = JSON.stringify(dealt);
    this.powers = new Map(this.roles);
    this.dealt = new Set(this.roles.values());
    for (const id of this.roles.keys()) this.equip(id);

    const pack = this.packIds().map((id) => this.nameOf(id));
    for (const [id, role] of this.roles) {
      this.sendRole(id, true);
      // The pack knows its own from the start; so do the brothers.
      const brothers = role === "brothers" ? { brothers: this.brothersOf(id).map((b) => this.nameOf(b)) } : {};
      this.logEvent("your_role", this.isPack(id) ? { role, pack } : { role, ...brothers }, id);
    }
  }

  /** What a role starts with, for whoever just got its card (the deal, or a doubler's copy). */
  private equip(id: string) {
    const role = this.roles.get(id);
    if (role === "witch") this.potions.set(id, { revive: true, poison: true });
    if (role === "greenwolf") this.greenLeft.set(id, this.state.greenGuesses);
    if (role === "alien") this.alienLeft.set(id, { village: 5, wolves: 3 });
  }

  /** [fresh]: the deal itself (the app plays the card-reveal animation), not a re-send after a reconnect. */
  private sendRole(sessionId: string, fresh = false) {
    const role = this.roles.get(sessionId);
    if (!role) return;
    const power = this.powerOf(sessionId);
    const pack = this.isPack(sessionId) ? { pack: this.packIds(), infected: [...this.infected] } : {};
    const spent = this.spent.has(sessionId); // his one-shot power is used
    const brothers = power === "brothers" ? { brothers: this.brothersOf(sessionId) } : {};
    const face = power === "tripleface" ? { faceFrom: this.faceFrom.get(sessionId) ?? 1 } : {};
    this.clients.getById(sessionId)?.send("role_assigned", { role, power, fresh, spent, ...pack, ...brothers, ...face });
  }

  /** The protector learns from the server who he can't protect tonight (survives app relaunches). */
  private sendProtectorTurn(protectorId: string) {
    this.clients.getById(protectorId)?.send("protector_turn", { blocked: this.lastProtected.get(protectorId) ?? null });
  }

  // ---- night: doubler → wolfdog, cupid, wild child (night 1) → policeman → green wolf, red wolf (night 2+) → wild hunter (odd
  // nights) → protector → wolves → big bad wolf (night 2+) → white wolf (even nights) → father / black wolves →
  // witch + seer + detective (+ triple face, seer wolf, dragon…) ----

  private startNight() {
    this.state.dayNumber += 1;
    this.state.phase = "night";
    for (const p of this.state.players.values()) {
      p.silenced = false; // silence and the raven's / owl's marks last one day
      p.voteBonus = 0;
    }
    this.voteMarks = [];
    this.nightNews = [];
    this.seerNews = [];
    this.detectiveNews = [];
    this.lastParalysed = this.paralysed;
    this.paralysed = new Map();
    this.lastSilenced = this.silences;
    this.silences = new Map();
    this.whiteTargets.clear();
    this.powerActors.clear();
    this.infectNow = false;
    this.stolenFrom.clear();
    this.dragonFires.clear();
    this.tricks.clear();
    this.traps.clear();
    this.lastProtected = this.protects;
    this.protects = new Map();
    this.wolfVotes.clear();
    this.wolfTarget = null;
    this.wolfVictim = null;
    this.bigBadTargets.clear();
    this.bigBadVictims = [];
    this.lastCaged = this.cages;
    this.cages = new Map();
    this.catVisits.clear();
    this.gifts = [];
    this.flasks = [];
    this.strums = [];
    this.bombs = [];
    this.knives.clear();
    this.awake.clear();
    this.witchActors.clear();
    this.reviving = false;
    this.poisons.clear();
    this.logEvent("night", { day: this.state.dayNumber });
    this.startDoublerStep();
  }

  /** A night step of one role: [ids] act in it; [next] runs once they all have, or when the time is up. */
  private openStep(step: string, role: Role, ids: string[], next: () => void) {
    this.acting = new Set(ids);
    this.afterStep = next;
    this.state.nightStep = step;
    this.state.nightRoles = role;
    this.logEvent("step", { role });
    this.setStepTimer(next);
  }

  /** [id] is done in this step (he acted, or passed): the night moves on once every holder is. */
  private acted(id: string) {
    this.acting.delete(id);
    if (this.acting.size === 0) this.afterStep();
  }

  /** Any night until he copies, before anyone: the doubler copies a player's role (and its side). */
  private startDoublerStep() {
    const doublers = this.holders("doubler");
    if (!doublers.length) return this.startWolfdogStep();
    this.openStep("doubler", "doubler", doublers, () => this.startWolfdogStep());
  }

  /**
   * He becomes the copied role, fresh (unused powers, both potions), and plays it this very night beside the
   * player he copied: every step waits for all the holders of its role. A wolf copy hunts tonight. A loner's card
   * (white wolf, alien, bomber, piper, guitarist, killer) isn't copied: he becomes a simple villager (his rule).
   */
  private handleCopy(client: Client, msg: { targetId: string }) {
    if (!this.stepActor(client, "doubler", "doubler")) return;
    const id = client.sessionId;
    const target = msg?.targetId;
    if (!this.isAlive(target) || target === id) return;
    const card = this.roles.get(target)!;
    const copied: Role = LONERS.has(card) ? "villager" : card;
    if (copied === "villager") this.dealt.add("villager"); // (there is one in the game now, whatever was dealt)
    this.roles.set(id, copied);
    this.powers.set(id, copied);
    this.spent.delete(id);
    this.equip(id);
    // The side comes with the card: a wolfdog's choice, a wild child's model (and his place in the pack, once turned).
    if (this.turned.has(target)) this.turned.add(id);
    if (this.wildModel.has(target)) this.wildModel.set(id, this.wildModel.get(target)!);
    client.send("doubler_result", { targetId: target, role: copied });
    this.logEvent("doubler_copied", { name: this.nameOf(target), role: copied }, id);
    if (this.isPack(id)) for (const w of this.packIds()) this.sendRole(w); // the pack meets its new member
    else this.sendRole(id);
    if (copied === "brothers") for (const b of this.brothersOf(id)) this.sendRole(b); // …and the brothers theirs
    this.acted(id);
  }

  /** Night 1, before the others: each wolfdog picks his side for the whole game — the village's, or the pack's. */
  private startWolfdogStep() {
    const dogs = this.state.dayNumber === 1 ? this.holders("wolfdog") : [];
    if (!dogs.length) return this.startCupidStep();
    this.openStep("wolfdog", "wolfdog", dogs, () => this.startCupidStep());
  }

  /** Saying nothing leaves him with the village. With the wolves, he's one of the pack from this very night. */
  private handleWolfdogSide(client: Client, msg: { wolves: boolean }) {
    if (!this.stepActor(client, "wolfdog", "wolfdog")) return;
    const id = client.sessionId;
    const wolves = msg?.wolves === true;
    if (wolves) this.joinPack(id, "wolfdog_joined");
    const pack = wolves ? { pack: this.packIds().filter((w) => w !== id).map((w) => this.nameOf(w)) } : {};
    this.logEvent("wolfdog_chose", { wolves, ...pack }, id);
    this.acted(id);
  }

  /** In the pack without a wolf's card (a wild child, a wolfdog): the pack is told ([news]) and gets its new list. */
  private joinPack(id: string, news: string) {
    this.turned.add(id);
    for (const w of this.packIds()) {
      if (w !== id) this.logEvent(news, { name: this.nameOf(id) }, w);
      this.sendRole(w);
    }
  }

  /** Night 1: cupid makes two players fall in love (himself allowed). */
  private startCupidStep() {
    // ponytail: one couple a game — of two cupids (a doubler's copy) only the first shoots; lovers would have to be a list
    const cupid = this.state.dayNumber === 1 ? this.holders("cupid")[0] : undefined;
    if (!cupid) return this.startWildChildStep();
    this.openStep("cupid", "cupid", [cupid], () => {
      const [a, b] = shuffleCopy(this.livingSeats());
      if (a && b) this.linkLovers(a, b); // he didn't choose: the arrows fly at random
      else this.startWildChildStep();
    });
  }

  private handleCupid(client: Client, msg: { a: string; b: string }) {
    if (!this.stepActor(client, "cupid", "cupid")) return;
    const { a, b } = msg ?? {};
    if (!this.isAlive(a) || !this.isAlive(b) || a === b) return;
    this.linkLovers(a, b);
  }

  /** The lovers open their eyes and see each other (no talking), then the night goes on. */
  private linkLovers(a: string, b: string) {
    this.lovers = [a, b];
    for (const [me, partner] of [[a, b], [b, a]]) {
      this.clients.getById(me)?.send("lovers", { ids: this.lovers, roles: { [partner]: this.roles.get(partner) } });
      this.logEvent("in_love", { name: this.nameOf(partner), role: this.roles.get(partner) }, me);
    }
    const cupid = this.aliveWithRole("cupid");
    if (cupid) {
      this.clients.getById(cupid)?.send("lovers", { ids: this.lovers });
      this.logEvent("cupid_linked", { a: this.nameOf(a), b: this.nameOf(b) }, cupid);
    }
    this.state.nightStep = "lovers";
    this.state.nightRoles = "";
    this.logEvent("step", { role: "lovers" });
    this.setPhaseTimer(LOVERS_MS, () => this.startWildChildStep());
  }

  /** Night 1, after cupid: each wild child picks his model. */
  private startWildChildStep() {
    const children = this.state.dayNumber === 1 ? this.holders("wildchild") : [];
    if (!children.length) return this.startPolicemanStep();
    this.openStep("wild_child", "wildchild", children, () => {
      for (const child of this.acting) {
        const others = this.livingSeats().filter((id) => id !== child);
        if (others.length) this.chooseModel(child, pickRandom(others)); // he didn't choose
      }
      this.startPolicemanStep();
    });
  }

  private handleWildModel(client: Client, msg: { targetId: string }) {
    if (!this.stepActor(client, "wild_child", "wildchild")) return;
    const target = msg?.targetId;
    if (!this.isAlive(target) || target === client.sessionId) return;
    this.chooseModel(client.sessionId, target);
    this.acted(client.sessionId);
  }

  private chooseModel(child: string, model: string) {
    this.wildModel.set(child, model);
    this.clients.getById(child)?.send("wild_model", { targetId: model });
    this.logEvent("model_chosen", { name: this.nameOf(model) }, child);
  }

  /** [model] died: the wild children who chose him join the pack (they wake with it from the next night). */
  private turnWildChildren(model: string) {
    for (const [child, chosen] of this.wildModel) {
      if (chosen !== model || this.turned.has(child) || !this.isAlive(child) || this.powerOf(child) !== "wildchild") continue;
      this.clients.getById(child)?.send("wild_turned");
      this.logEvent("wild_turned", {}, child);
      this.joinPack(child, "wild_joined");
    }
  }

  /**
   * Every night, before the powers and the hunt: the policeman locks a player in his cage until morning. That player
   * can't use his power (a caged wolf doesn't hunt), and nothing kills or infects him tonight.
   */
  private startPolicemanStep() {
    const policemen = this.holders("policeman");
    if (!policemen.length) return this.startGreenWolfStep();
    this.openStep("policeman", "policeman", policemen, () => this.startGreenWolfStep());
    for (const id of policemen) this.clients.getById(id)?.send("policeman_turn", { blocked: this.lastCaged.get(id) ?? null });
  }

  private handleCage(client: Client, msg: { targetId: string }) {
    if (!this.stepActor(client, "policeman", "policeman")) return;
    const id = client.sessionId;
    const target = msg?.targetId;
    if (!this.isAlive(target) || target === id) return;
    if (target === this.lastCaged.get(id)) {
      client.send("error", { code: "same_cage" });
      return;
    }
    this.cages.set(id, target);
    this.logEvent("caged_confirm", { name: this.nameOf(target) }, id);
    this.clients.getById(target)?.send("caged");
    this.logEvent("caged", {}, target); // in his log: why he slept through the night
    this.acted(id);
  }

  /**
   * From night 2 the green wolf wakes first of all and guesses a role: a right guess steals it before
   * anyone acts, so the robbed player sleeps tonight and the green wolf uses it this very night.
   */
  private startGreenWolfStep() {
    const greens = this.state.dayNumber < 2 ? [] : this.holders("greenwolf").filter((id) => (this.greenLeft.get(id) ?? 0) > 0);
    if (!greens.length) return this.startRedWolfStep();
    this.openStep("green_wolf", "greenwolf", greens, () => this.startRedWolfStep());
    for (const id of greens) this.clients.getById(id)?.send("green_turn", { left: this.greenLeft.get(id) });
  }

  /** From night 2, the red wolf wakes first and paralyses a non-wolf: no power for him tonight. */
  private startRedWolfStep() {
    const reds = this.state.dayNumber < 2 ? [] : this.holders("redwolf");
    if (!reds.length) return this.startWildHunterStep();
    this.openStep("red_wolf", "redwolf", reds, () => this.startWildHunterStep());
    for (const id of reds) this.clients.getById(id)?.send("red_turn", { blocked: this.lastParalysed.get(id) ?? null });
  }

  private handleParalyse(client: Client, msg: { targetId: string }) {
    if (!this.stepActor(client, "red_wolf", "redwolf")) return;
    const id = client.sessionId;
    const target = msg?.targetId;
    if (!this.isAlive(target) || this.isPack(target)) return;
    if (target === this.lastParalysed.get(id)) {
      client.send("error", { code: "same_paralyse" });
      return;
    }
    this.paralysed.set(id, target);
    this.logEvent("paralysed_confirm", { name: this.nameOf(target) }, id);
    // He'll see it in his log: he slept through his turn. (On a loner it does nothing, and nobody is told.)
    if (this.isParalysed(target)) this.logEvent("paralysed", {}, target);
    this.acted(id);
  }

  /** Nights 1, 3, 5…: the Wild Hunter sets his trap on someone (not himself) before anyone else wakes. */
  private startWildHunterStep() {
    const hunters = this.state.dayNumber % 2 === 0 ? [] : this.holders("wildhunter");
    if (!hunters.length) return this.startProtectorStep();
    this.openStep("wild_hunter", "wildhunter", hunters, () => this.startProtectorStep());
  }

  private handleTrap(client: Client, msg: { targetId: string }) {
    if (!this.stepActor(client, "wild_hunter", "wildhunter")) return;
    if (!this.isAlive(msg?.targetId) || msg.targetId === client.sessionId) return;
    this.traps.add(msg.targetId);
    this.logEvent("trapped", { name: this.nameOf(msg.targetId) }, client.sessionId);
    this.acted(client.sessionId);
  }

  private startProtectorStep() {
    const protectors = this.holders("protector");
    if (!protectors.length) return this.startWolvesStep();
    this.openStep("protector", "protector", protectors, () => this.startWolvesStep());
    for (const id of protectors) this.sendProtectorTurn(id);
  }

  private handleProtect(client: Client, msg: { targetId: string }) {
    if (!this.stepActor(client, "protector", "protector")) return;
    const id = client.sessionId;
    const target = msg?.targetId;
    if (!this.isAlive(target)) return;
    if (target === this.lastProtected.get(id)) {
      client.send("error", { code: "same_protect" });
      return;
    }
    this.protects.set(id, target);
    this.logEvent("protected", { name: this.nameOf(target) }, id); // his confirmation
    if (this.state.protectorShield && this.isParalysed(target)) {
      // The shield breaks the red wolf's spell: he plays his role tonight after all.
      for (const [red, spelled] of this.paralysed) if (spelled === target) this.paralysed.delete(red);
      this.logEvent("paralysis_lifted", {}, target);
    }
    this.acted(id);
  }

  private startWolvesStep() {
    // No wolf left alive (a loner plays on): the pack doesn't wake, nobody is told it does.
    if (!this.packIds().some((w) => this.isAlive(w))) return this.endWolvesStep();
    this.state.nightStep = "wolves";
    this.state.nightRoles = "werewolf";
    this.logEvent("step", { role: "werewolf" });
    this.setStepTimer( () => this.endWolvesStep());
  }

  /** Wolves vote for any living player — packmates too — and may change their vote until the step ends. */
  private handleWolfTarget(client: Client, msg: { targetId: string }) {
    const id = client.sessionId;
    if (this.state.nightStep !== "wolves" || this.state.phase !== "night" || !this.isPack(id) || !this.isAlive(id)) return;
    if (this.isCaged(id)) return; // in the policeman's cage: he sits the hunt out
    if (!this.isAlive(msg?.targetId)) return;
    if (this.wolfVotes.get(id) === msg.targetId) this.wolfVotes.delete(id); // tapped again: vote taken back
    else this.wolfVotes.set(id, msg.targetId);
    const votes = Object.fromEntries(this.wolfVotes);
    for (const w of this.packIds()) this.clients.getById(w)?.send("wolf_votes", votes);
    // Every wolf who is here has voted: the pack's time drops to a few seconds (a vote can still change in them).
    const pack = this.packIds().filter((w) => this.isAlive(w) && this.state.players.get(w)?.connected && !this.isCaged(w));
    if (pack.every((w) => this.wolfVotes.has(w)) && this.state.phaseEndsAt - Date.now() > WOLVES_AGREED_MS) {
      this.setPhaseTimer(WOLVES_AGREED_MS, () => this.endWolvesStep());
    }
  }

  private endWolvesStep() {
    // No vote, or a tie: nobody is attacked tonight.
    this.wolfTarget = topVoted(this.wolfVotes.values());
    this.startBigBadWolfStep();
  }

  /** Red Hood: the wolves can't touch her during the first 3 nights, as long as the hunter lives. */
  private redHoodSafe(id: string): boolean {
    return this.powerOf(id) === "redhood" && this.state.dayNumber <= 3 && !!this.aliveWithRole("hunter");
  }

  /**
   * From night 2, while the pack has lost nobody: right after the hunt, the big bad wolf takes a second victim of
   * his own (not a packmate, not the pack's pick). The witch isn't shown that one: she can't save him.
   */
  private startBigBadWolfStep() {
    const whole = this.packIds().every((id) => this.isAlive(id));
    const wolves = whole && this.canKillTonight() ? this.holders("bigbadwolf") : [];
    if (!wolves.length) return this.startWhiteWolfStep();
    this.openStep("big_bad_wolf", "bigbadwolf", wolves, () => this.startWhiteWolfStep());
    for (const id of wolves) this.clients.getById(id)?.send("bigbad_turn", { blocked: this.wolfTarget });
  }

  private handleBigBadKill(client: Client, msg: { targetId: string }) {
    if (!this.stepActor(client, "big_bad_wolf", "bigbadwolf")) return;
    const id = client.sessionId;
    const target = msg?.targetId;
    if (!this.isAlive(target) || this.isPack(target) || target === this.wolfTarget) return;
    this.bigBadTargets.set(id, target);
    this.logEvent("bigbad_chose", { name: this.nameOf(target) }, id);
    this.acted(id);
  }

  /** Nights 2, 4, 6…: right after the pack, the white wolf may kill one of them (nothing can save him). */
  private startWhiteWolfStep() {
    const whites = this.state.dayNumber % 2 === 1 ? [] : this.holders("whitewolf");
    const hunting = whites.filter((white) => this.packIds().some((id) => id !== white && this.isAlive(id))); // someone to kill
    if (!hunting.length) return this.startWolfPowersStep();
    this.openStep("white_wolf", "whitewolf", hunting, () => this.startWolfPowersStep());
  }

  private handleWhiteKill(client: Client, msg: { targetId: string }) {
    if (!this.stepActor(client, "white_wolf", "whitewolf")) return;
    const target = msg?.targetId;
    if (!this.isAlive(target) || !this.isPack(target) || target === client.sessionId) return;
    this.whiteTargets.add(target);
    this.logEvent("white_chose", { name: this.nameOf(target) }, client.sessionId);
    this.acted(client.sessionId);
  }

  /**
   * The father wolves (if the pack agreed on a non-wolf and they haven't infected yet) and the black wolves
   * wake together after the pack.
   */
  private startWolfPowersStep() {
    this.powerActors.clear();
    const target = this.wolfTarget;
    if (this.wolfVotes.size > 0 && target && this.isAlive(target) && !this.isPack(target)) {
      for (const father of this.holders("fatherwolf")) if (!this.infectionUsed.has(father)) this.powerActors.add(father);
    }
    for (const black of this.holders("blackwolf")) this.powerActors.add(black);
    if (this.powerActors.size === 0) return this.finishWolfPowers();

    const roles = new Set([...this.powerActors].map((id) => this.powerOf(id)!));
    this.state.nightStep = "wolf_powers";
    this.state.nightRoles = [...roles].join(",");
    for (const role of roles) this.logEvent("step", { role });
    for (const id of this.powerActors) this.sendPowerTurn(id);
    this.setStepTimer(() => this.finishWolfPowers());
  }

  private sendPowerTurn(id: string) {
    const client = this.clients.getById(id);
    const power = this.powerOf(id);
    if (power === "fatherwolf") client?.send("father_turn", { victim: this.wolfTarget });
    if (power === "blackwolf") {
      // (night 1: the mayor has his first day ahead, he can't be silenced)
      const mayor = this.state.dayNumber === 1 && this.state.mayorId ? this.state.mayorId : null;
      client?.send("black_turn", { blocked: this.lastSilenced.get(id) ?? null, mayor });
    }
  }

  /** Acting in the wolf powers step as [role] and still to act. */
  private powerActor(client: Client, role: Role): string | null {
    const id = client.sessionId;
    const ok = this.state.nightStep === "wolf_powers" && this.powerActors.has(id) && this.powerOf(id) === role;
    return ok && this.isAlive(id) ? id : null;
  }

  private donePower(id: string) {
    this.powerActors.delete(id);
    if (this.powerActors.size === 0) this.finishWolfPowers();
  }

  /** Infecting the pack's victim: he joins the pack instead of dying; protection and traps don't matter. */
  private handleInfect(client: Client, msg: { infect: boolean }) {
    const id = this.powerActor(client, "fatherwolf");
    if (!id) return;
    const target = this.wolfTarget;
    if (msg?.infect && target && !this.infectNow) {
      this.infectionUsed.add(id);
      const warded = this.state.protectorShield && this.isProtected(target);
      const immune = this.powerOf(target) === "brothers" || this.isCaged(target) || UNTOUCHABLE.has(this.roles.get(target));
      if (this.redHoodSafe(target) || warded || immune) {
        // She can't be turned while the hunter protects her, nor can the protector's ward (if the room says his
        // shield stops infections), nor either of the two brothers, nor the player in the policeman's cage, nor a
        // loner the wolves can't touch — and the father loses his infection.
        this.logEvent("infect_failed", { name: this.nameOf(target) }, id);
      } else {
        this.infectNow = true;
        this.nightNews.push("infection");
        this.logEvent("infect_done", { name: this.nameOf(target) }, id);
        this.infect(target); // at once — he still plays his own role tonight (a bitten seer still looks)
      }
    }
    this.donePower(id);
  }

  private handleSilence(client: Client, msg: { targetId: string }) {
    const id = this.powerActor(client, "blackwolf");
    const target = msg?.targetId;
    if (!id || !this.isAlive(target)) return; // himself too: no voice or vote tomorrow, but nobody votes against him
    if (target === this.lastSilenced.get(id)) {
      client.send("error", { code: "same_silence" });
      return;
    }
    if (this.state.dayNumber === 1 && target === this.state.mayorId) {
      client.send("error", { code: "mayor_first_day" }); // the new mayor has his first day
      return;
    }
    this.silences.set(id, target);
    this.logEvent("silence_chose", { name: this.nameOf(target) }, id);
    this.donePower(id);
  }

  /** One guess a night: the right role steals it (he keeps being a wolf); the victim becomes a simple villager. */
  private handleGreenGuess(client: Client, msg: { targetId: string; role: string }) {
    const id = this.stepActor(client, "green_wolf", "greenwolf") ? client.sessionId : null;
    const target = msg?.targetId;
    const guess = msg?.role as Role;
    if (!id || !this.isAlive(target) || this.isPack(target) || !STEALABLE.includes(guess)) return;
    const left = (this.greenLeft.get(id) ?? 1) - 1;
    this.greenLeft.set(id, left);
    // In the policeman's cage nothing is stolen: the guess is spent, and he doesn't learn whether it was right.
    const caged = this.isCaged(target) ? { caged: true } : {};
    const right = !this.isCaged(target) && this.powerOf(target) === guess;
    if (right) {
      this.rob(id, target);
      this.stolenFrom.add(target);
      this.sendRole(id);
      this.sendRole(target); // he sleeps tonight: his app shows him a simple villager now (the panel comes at dawn)
    }
    client.send("green_result", { targetId: target, role: guess, right, left, ...caged });
    this.logEvent("green_guessed", { name: this.nameOf(target), role: guess, right, ...caged }, id);
    this.acted(id);
  }

  /** [thief] takes [target]'s power and keeps his own card and side; [target] is a simple villager from now on. */
  private rob(thief: string, target: string) {
    this.powers.set(thief, this.powerOf(target)!);
    this.powers.set(target, "villager");
    this.roles.set(target, "villager");
    this.dealt.add("villager"); // (there is one in the game now, whatever was dealt)
    const p = this.potions.get(target);
    if (p) {
      this.potions.set(thief, p);
      this.potions.delete(target);
    }
    if (this.spent.has(target)) this.spent.add(thief); // a one-shot power already used stays used
    else this.spent.delete(thief);
  }

  /** Skipping a night power: he's done, and his step ends once its other holders are too. */
  private handlePowerPass(client: Client) {
    const id = client.sessionId;
    const step = this.state.nightStep;
    const optional: Role[] = [
      "dragon", "trickster", "fox", "raven", "owl", "cat", "littlegirl", "shepherd", "rabbit", "priest", "alchemist",
      "servant", "piper", "guitarist", "bomber",
    ];
    if (step === "witch_seer" && this.awakeActor(client) && optional.includes(this.powerOf(id)!)) {
      this.awake.delete(id); // keeps his fire (or his flask) for another night; the cat stays home
      return this.maybeEndWitchSeer();
    }
    const skippable = ["doubler", "policeman", "green_wolf", "red_wolf", "big_bad_wolf", "white_wolf", "killer"].includes(step);
    if (skippable && this.state.phase === "night" && this.acting.has(id) && this.isAlive(id)) return this.acted(id);
    if (step !== "wolf_powers" || !this.powerActors.has(id)) return;
    this.donePower(id);
  }

  /** The pack's victim (and the big bad wolves' own), after the father wolf, the protector and Red Hood; then the witch & co. wake. */
  private finishWolfPowers() {
    this.powerActors.clear();
    const hunted = !this.infectNow && this.wolfTarget ? this.wolfTarget : null;
    this.wolfVictim = hunted && this.bites(hunted) ? hunted : null;
    // (A big bad wolf who went for a trapped player pays for it himself: see resolveNight.)
    this.bigBadVictims = [...this.bigBadTargets.values()].filter((id) => !this.traps.has(id) && this.bites(id));
    this.startKillerStep();
  }

  /** From night 2, once the wolves are done: each killer may stab anyone (resolveNight; the witch never sees it). */
  private startKillerStep() {
    const killers = this.canKillTonight() ? this.holders("killer") : [];
    if (!killers.length) return this.startWitchSeerStep();
    this.openStep("killer", "killer", killers, () => this.startWitchSeerStep());
  }

  private handleKnife(client: Client, msg: { targetId: string }) {
    if (!this.stepActor(client, "killer", "killer")) return;
    const id = client.sessionId;
    const target = msg?.targetId;
    if (!this.isAlive(target) || target === id) return;
    this.knives.set(id, target);
    this.logEvent("knife_chose", { name: this.nameOf(target) }, id);
    this.acted(id);
  }

  /**
   * A wolf's bite on [id]: false when it comes to nothing (the policeman's cage, a protector's ward, Red Hood's
   * hunter, the ancient's extra life). Each of those is news for the narrator: which kind, never on whom.
   */
  private bites(id: string): boolean {
    let stopped: string | null = null;
    if (this.isCaged(id)) stopped = "caged";
    else if (UNTOUCHABLE.has(this.roles.get(id))) stopped = "immune"; // (nobody is told: only the narrator's "came to nothing")
    else if (this.isProtected(id)) stopped = "protected";
    else if (this.redHoodSafe(id)) stopped = "redhood";
    else if (this.powerOf(id) === "ancient" && !this.ancientUsed.has(id)) {
      this.ancientUsed.add(id); // his one extra life is gone
      this.logEvent("ancient_survived", {}, id);
      stopped = "ancient";
    }
    if (stopped) this.nightNews.push(stopped);
    return !stopped;
  }

  /**
   * The witches (while they have a potion), the seers, the seer wolves, the detectives and the other night powers
   * wake together. A triple face wakes with them as a second seer on night 1 and as a second witch (with both
   * potions) on night 2.
   */
  private startWitchSeerStep() {
    const day = this.state.dayNumber;
    // A triple face's second night: a witch with both potions.
    for (const id of this.holders("tripleface")) if (this.faceNight(id) === 2) this.potions.set(id, { revive: true, poison: true });
    const { witches, others } = this.witchSeerActors();
    this.witchActors = new Set(witches);
    this.awake = new Set([...this.witchActors, ...others]);
    if (this.awake.size === 0) return this.resolveNight();

    const roles = new Set([...this.awake].map((id) => this.powerOf(id)!));
    this.state.nightStep = "witch_seer";
    this.state.nightRoles = [...roles].join(",");
    const seerFace = this.holders("tripleface").some((id) => this.faceNight(id) === 1 && this.awake.has(id));
    for (const role of roles) this.logEvent("step", role === "tripleface" ? { role, as: seerFace ? "seer" : "witch" } : { role });
    for (const id of this.witchActors) this.sendWitchTurn(id);
    this.setPhaseTimer(this.stepMs(), () => this.resolveNight());
  }

  /** The triple face's night: 1 a seer, 2 a witch, 3 and after a hunter (counted from the night he got the card). */
  private faceNight(id: string) {
    return this.state.dayNumber - (this.faceFrom.get(id) ?? 1) + 1;
  }

  /** Who wakes in the witch/seer step tonight: the witches with a potion left, and the other night powers. */
  private witchSeerActors() {
    const day = this.state.dayNumber;
    const unspent = (role: Role) => this.holders(role).filter((id) => !this.spent.has(id));
    const living = this.livingSeats().length;
    const tripleFaces = this.holders("tripleface");
    const witches = [...this.holders("witch"), ...tripleFaces.filter((id) => this.faceNight(id) === 2)].filter((id) => this.hasPotion(id));
    const others = [
      ...this.holders("seer"),
      ...this.holders("seerwolf"),
      ...tripleFaces.filter((id) => this.faceNight(id) === 1),
      ...this.holders("detective").filter((id) => this.canInvestigate(id)),
      ...(day > 1 ? unspent("dragon") : []), // from night 2, until he has burned someone
      ...unspent("dictator"), // each night until he strikes: will he, at daybreak?
      ...(day >= 2 ? unspent("trickster") : []), // from night 2, once per game
      ...(this.livingSeats().length >= 3 ? unspent("fox") : []), // while he has his nose, and three players to smell
      ...this.holders("raven"),
      ...this.holders("owl"),
      ...this.holders("cat"),
      ...(this.idsWithRole("hunter").some((h) => this.isAlive(h)) ? this.holders("littlegirl") : []), // she works for the hunter
      ...(living >= 4 ? unspent("shepherd") : []), // three other players for his sheep, until all three come back
      ...(living >= 3 ? unspent("rabbit") : []), // two other players for his chocolates, until both are eaten
      ...(day > 1 ? [...unspent("priest"), ...unspent("alchemist")] : []), // one flask each, never on the first night
      ...(this.heirlooms().length ? this.holders("servant") : []), // while a dead village player has a role to leave her
      ...this.holders("piper").filter((id) => this.charmable(id).length > 0),
      ...(day > 1 ? [...this.holders("guitarist"), ...this.holders("bomber")] : []), // they kill: never on the first night
    ];
    return { witches, others };
  }

  private hasPotion(id: string): boolean {
    const p = this.potions.get(id);
    return !!p && (p.revive || p.poison);
  }

  private sendWitchTurn(witchId: string) {
    const p = this.potions.get(witchId)!;
    const canRevive = p.revive && !this.reviving && this.wolfVictim !== null;
    this.clients.getById(witchId)?.send("witch_turn", {
      victim: canRevive ? this.wolfVictim : null,
      canPoison: p.poison && this.canKillTonight(),
    });
  }

  /** Nobody kills by a power on the first night: the witch only revives, the dragon waits. */
  private canKillTonight() {
    return this.state.dayNumber > 1;
  }

  /** Awake in the witch/seer step and still to act. */
  private awakeActor(client: Client): string | null {
    const id = client.sessionId;
    return this.state.nightStep === "witch_seer" && this.awake.has(id) && this.isAlive(id) ? id : null;
  }

  private handleSeerPeek(client: Client, msg: { targetId: string }) {
    const id = this.awakeActor(client);
    const role = id && this.powerOf(id);
    const wolf = role === "seerwolf"; // he reads the exact card of someone outside the pack, and the village hears nothing
    if (!id || !(role === "seer" || wolf || (role === "tripleface" && this.faceNight(id) === 1))) return;
    const target = msg?.targetId;
    if (!this.isAlive(target) || target === id || (wolf && this.isPack(target))) return;
    // A player she saw as a simple villager can be looked at once more (the blue wolf hides behind
    // one the first time); any other role only once.
    const key = `${id}>${target}`;
    const before = this.known.get(id)?.[target];
    const looks = this.seerCounts.get(key) ?? (before ? 1 : 0);
    if (looks >= 2 || (looks === 1 && before !== "villager")) {
      client.send("error", { code: "already_seen" });
      return;
    }
    this.awake.delete(id);
    const real = this.roles.get(target);
    const seen = real === "bluewolf" && looks === 0 && !wolf ? "villager" : real;
    this.seerCounts.set(key, looks + 1);
    if (seen) this.known.set(id, { ...this.known.get(id), [target]: seen });
    client.send("seer_result", { targetId: target, role: seen, isWerewolf: !!seen && WOLF_ROLES.has(seen) });
    this.logEvent("seer_saw", { name: this.nameOf(target), role: seen, ...(wolf ? { by: "seerwolf" } : {}) }, id);
    if (this.state.talkingSeer && !wolf && seen) this.seerNews.push(seen); // told at dawn, under the day's title
    this.maybeEndWitchSeer();
  }

  /** Once per game, any living player but himself; the death is revealed at dawn with the others. */
  /** Living players in seat order. */
  private livingSeats(): string[] {
    return [...this.state.players.keys()].filter((id) => this.isAlive(id));
  }

  /**
   * The fox smells a player and his two nearest living neighbours: is there a wolf among the three?
   * (He doesn't learn which.) Clean: he loses his power.
   */
  private handleFox(client: Client, msg: { targetId: string }) {
    const id = this.awakeActor(client);
    const target = msg?.targetId;
    if (!id || this.powerOf(id) !== "fox" || this.spent.has(id) || !this.isAlive(target) || target === id) return;
    const seats = this.livingSeats();
    if (seats.length < 3) return;
    const i = seats.indexOf(target);
    const ids = [seats[(i - 1 + seats.length) % seats.length], target, seats[(i + 1) % seats.length]];
    const wolf = ids.some((p) => this.isPack(p));
    const smell = { ids, wolf };
    this.foxKnown.set(id, [...(this.foxKnown.get(id) ?? []), smell]);
    client.send("fox_result", smell);
    this.logEvent("fox_smelled", { names: ids.map((p) => this.nameOf(p)), wolf }, id);
    if (!wolf) {
      this.spent.add(id); // nothing to smell: his nose is gone
      this.sendRole(id);
    }
    this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  /** The raven (+2) or the owl (−2) marks a player for tomorrow's vote. */
  private handleMark(client: Client, msg: { targetId: string }) {
    const id = this.awakeActor(client);
    const role = id ? this.powerOf(id) : undefined;
    const target = msg?.targetId;
    if (!id || (role !== "raven" && role !== "owl") || !this.isAlive(target) || target === id) return;
    this.voteMarks.push([target, role === "raven" ? 2 : -2]);
    this.logEvent(`${role}_chose`, { name: this.nameOf(target) }, id);
    this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  /** From night 2, once per game, with the seer and the witch. */
  private handleTrick(client: Client, msg: { targetId: string }) {
    const id = this.awakeActor(client);
    const target = msg?.targetId;
    if (!id || this.powerOf(id) !== "trickster" || this.spent.has(id)) return;
    if (!this.isAlive(target) || target === id) return;
    this.spent.add(id);
    this.tricks.add(target);
    this.sendRole(id);
    this.logEvent("trick_chose", { name: this.nameOf(target) }, id);
    this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  /** Each night until he strikes, the dictator says whether he'll use his power at daybreak. */
  private handleDictatorReady(client: Client, msg: { use: boolean }) {
    const id = this.awakeActor(client);
    if (!id || this.powerOf(id) !== "dictator" || this.spent.has(id)) return;
    const use = msg?.use === true;
    if (use) this.armed.add(id);
    this.logEvent(use ? "dictator_armed" : "dictator_waits", {}, id);
    this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  private handleDragon(client: Client, msg: { targetId: string }) {
    const id = this.awakeActor(client);
    const target = msg?.targetId;
    if (!id || this.powerOf(id) !== "dragon" || this.spent.has(id)) return;
    if (!this.isAlive(target) || target === id) return;
    this.spent.add(id);
    this.dragonFires.set(id, target);
    this.sendRole(id);
    this.logEvent("dragon_chose", { name: this.nameOf(target) }, id);
    this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  /** The players this detective has checked: he can never check one of them again. */
  private checkedBy(detective: string): Set<string> {
    return new Set((this.detectiveKnown.get(detective) ?? []).flatMap((c) => [c.a, c.b]));
  }

  /** A detective wakes only while two living players (not him) are still unchecked. */
  private canInvestigate(detective: string): boolean {
    const checked = this.checkedBy(detective);
    return this.livingSeats().filter((id) => id !== detective && !checked.has(id)).length >= 2;
  }

  /** Two players (not himself, never checked before): same team or not. */
  private handleDetective(client: Client, msg: { a: string; b: string }) {
    const id = this.awakeActor(client);
    if (!id || this.powerOf(id) !== "detective") return;
    const { a, b } = msg ?? {};
    if (!this.isAlive(a) || !this.isAlive(b) || a === b || a === id || b === id) return;
    const checked = this.checkedBy(id);
    if (checked.has(a) || checked.has(b)) {
      client.send("error", { code: "already_checked" });
      return;
    }
    const same = this.teamOf(a) === this.teamOf(b);
    const check = { a, b, same };
    this.detectiveKnown.set(id, [...(this.detectiveKnown.get(id) ?? []), check]);
    client.send("detective_result", check);
    this.logEvent("detective_saw", { a: this.nameOf(a), b: this.nameOf(b), same }, id);
    if (this.state.talkingDetective) this.detectiveNews.push(same); // told at dawn, under the day's title
    this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  /** An awake player using [role]'s power on another living player: [him, his pick], or null. */
  private picks(client: Client, role: Role, target: string | undefined): [string, string] | null {
    const id = this.awakeActor(client);
    return id && this.powerOf(id) === role && this.isAlive(target) && target !== id ? [id, target!] : null;
  }

  /** He's done for the night: the step ends once everyone awake is. */
  private rested(id: string) {
    this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  /** The cat spends the night at someone's house: a wolf's, and he doesn't see the morning (resolveNight). */
  private handleCat(client: Client, msg: { targetId: string }) {
    const pick = this.picks(client, "cat", msg?.targetId);
    if (!pick) return;
    const [id, house] = pick;
    this.catVisits.set(id, house);
    this.logEvent("cat_chose", { name: this.nameOf(house) }, id);
    this.rested(id);
  }

  /**
   * The little girl points at a player for the hunter: every living hunter learns that player's side: a wolf (the
   * white wolf too, infected players, anyone who hunts with the pack) or not. She learns nothing herself.
   */
  private handleGirl(client: Client, msg: { targetId: string }) {
    const pick = this.picks(client, "littlegirl", msg?.targetId);
    if (!pick) return;
    const [id, target] = pick;
    const wolf = this.isPack(target);
    this.logEvent("girl_chose", { name: this.nameOf(target) }, id);
    for (const hunter of this.idsWithRole("hunter").filter((h) => this.isAlive(h))) {
      this.girlKnown.set(hunter, { ...this.girlKnown.get(hunter), [target]: wolf });
      this.clients.getById(hunter)?.send("girl_known", this.girlKnown.get(hunter));
      this.logEvent("girl_told", { name: this.nameOf(target), wolf }, hunter);
    }
    this.rested(id);
  }

  /**
   * The shepherd's three sheep, the rabbit's two chocolates, each to a different player. A sheep sent to a wolf
   * (the white wolf and infected players too) never comes back; a wolf doesn't eat his chocolate. Told at dawn; all
   * three sheep back, or both chocolates eaten, and that power is gone.
   */
  private handleGifts(client: Client, msg: { targets: string[] }) {
    const id = this.awakeActor(client);
    const role = id ? this.powerOf(id) : undefined;
    if (!id || (role !== "shepherd" && role !== "rabbit") || this.spent.has(id)) return;
    const targets = [...new Set(Array.isArray(msg?.targets) ? msg.targets : [])];
    if (targets.length !== (role === "shepherd" ? 3 : 2) || targets.some((t) => !this.isAlive(t) || t === id)) return;
    const count = targets.filter((t) => !this.isPack(t)).length;
    this.gifts.push({ by: id, role, count });
    this.logEvent("gifts_sent", { role, names: targets.map((t) => this.nameOf(t)) }, id);
    this.rested(id);
  }

  /** One flask a game, never on the first night: the priest's holy water, the alchemist's poison (resolveNight). */
  private handleFlask(client: Client, msg: { targetId: string }) {
    const id = this.awakeActor(client);
    const role = id ? this.powerOf(id) : undefined;
    const target = msg?.targetId;
    if (!id || (role !== "priest" && role !== "alchemist") || this.spent.has(id) || !this.canKillTonight()) return;
    if (!this.isAlive(target) || target === id) return;
    this.spent.add(id);
    this.flasks.push({ by: id, target, role });
    this.sendRole(id);
    this.logEvent("flask_chose", { role, name: this.nameOf(target) }, id);
    this.rested(id);
  }

  /**
   * The dead a servant may take over from: village roles (by the card), never a wolf's or a loner's, nor a wild child
   * or a wolfdog who joined the pack. An infected player's role comes to her without the infection.
   */
  private heirlooms(): string[] {
    return [...this.roles].filter(([id, role]) => {
      return !this.isAlive(id) && !isEvil(role) && !this.turned.has(id) && role !== "villager" && role !== "servant";
    }).map(([id]) => id);
  }

  /**
   * The servant takes a dead village player's role, fresh (unused powers, both potions; a triple face starts again as
   * a seer). She keeps the village's side, and plays her new role this very night when it wakes in this step (a
   * seer, a witch, a fox…); a role whose step has passed tonight (the protector…) plays from the next night.
   */
  private handleInherit(client: Client, msg: { targetId: string }) {
    const id = this.awakeActor(client);
    const from = msg?.targetId;
    if (!id || this.powerOf(id) !== "servant" || !this.heirlooms().includes(from)) return;
    const role = this.roles.get(from)!;
    this.roles.set(id, role);
    this.powers.set(id, role);
    this.spent.delete(id);
    this.equip(id);
    if (role === "tripleface") this.faceFrom.set(id, this.state.dayNumber);
    const { witches, others } = this.witchSeerActors();
    const now = witches.includes(id) || others.includes(id);
    client.send("inherited", { targetId: from, role, now });
    this.logEvent("servant_inherited", { name: this.nameOf(from), role }, id);
    this.sendRole(id);
    if (role === "brothers") for (const b of this.brothersOf(id)) this.sendRole(b);
    if (!now) return this.rested(id);
    if (witches.includes(id)) {
      this.witchActors.add(id);
      this.sendWitchTurn(id);
    }
  }

  /**
   * The first wolf of the pack to die leaves the puppet his card and what was left of his power: an infection not
   * used yet, guesses left, a role he had stolen. She's a wolf from now on.
   */
  private takeOver(puppet: string, wolf: string) {
    const role = this.roles.get(wolf)!;
    this.roles.set(puppet, role);
    this.powers.set(puppet, this.powers.get(wolf) ?? role);
    this.spent.delete(puppet);
    if (this.spent.has(wolf)) this.spent.add(puppet);
    if (this.infectionUsed.has(wolf)) this.infectionUsed.add(puppet);
    if (this.greenLeft.has(wolf)) this.greenLeft.set(puppet, this.greenLeft.get(wolf)!);
    const potions = this.potions.get(wolf);
    if (potions) this.potions.set(puppet, { ...potions });
    this.clients.getById(puppet)?.send("puppet_turned", { role, name: this.nameOf(wolf) });
    this.logEvent("puppet_turned", { role, name: this.nameOf(wolf) }, puppet);
    for (const w of this.packIds()) {
      if (w !== puppet && this.isAlive(w)) this.logEvent("puppet_joined", { name: this.nameOf(puppet) }, w);
      this.sendRole(w); // everyone in the pack gets the new pack list
    }
  }

  /** Living players a piper can still charm. */
  private charmable(piper: string): string[] {
    return this.livingSeats().filter((id) => id !== piper && !this.charmed.has(id) && this.teamOf(id) !== "piper");
  }

  /** Each night the piper charms two more players (the last one alone). They keep their role and their side. */
  private handleCharm(client: Client, msg: { targets: string[] }) {
    const id = this.awakeActor(client);
    if (!id || this.powerOf(id) !== "piper") return;
    const free = this.charmable(id);
    const targets = [...new Set(Array.isArray(msg?.targets) ? msg.targets : [])];
    if (targets.length !== Math.min(2, free.length) || targets.some((t) => !free.includes(t))) return;
    this.logEvent("piper_chose", { names: targets.map((t) => this.nameOf(t)) }, id);
    for (const t of targets) {
      this.charmed.add(t);
      this.logEvent("charmed", {}, t);
    }
    // The charmed (and the pipers) see who is under the spell; nobody else does.
    const ids = [...this.charmed];
    for (const seat of [...ids, ...this.idsWithRole("piper")]) this.clients.getById(seat)?.send("charmed", { ids });
    this.rested(id);
  }

  /** The guitarist names a role and two players: if either holds it, both die at dawn (resolveNight). */
  private handleStrum(client: Client, msg: { targets: string[]; role: string }) {
    const id = this.awakeActor(client);
    const role = msg?.role as Role;
    const targets = [...new Set(Array.isArray(msg?.targets) ? msg.targets : [])];
    if (!id || this.powerOf(id) !== "guitarist" || !this.canKillTonight() || !this.dealt.has(role)) return;
    if (targets.length !== 2 || targets.some((t) => !this.isAlive(t) || t === id)) return;
    this.strums.push({ by: id, targets, role });
    this.logEvent("guitar_chose", { names: targets.map((t) => this.nameOf(t)), role }, id);
    this.rested(id);
  }

  /** The bomber leaves a bomb with a player, set to blow on its [count]th holder (2 to 6). It goes round at daybreak. */
  private handleBombPlant(client: Client, msg: { targetId: string; count: number }) {
    const pick = this.picks(client, "bomber", msg?.targetId);
    const count = Math.floor(Number(msg?.count));
    if (!pick || !this.canKillTonight() || !(count >= 2 && count <= 6)) return;
    const [id, target] = pick;
    this.bombs.push({ target, count });
    this.logEvent("bomb_chose", { name: this.nameOf(target), count }, id);
    this.rested(id);
  }

  /**
   * The mirror's one reflection: a potion or a fire thrown at him at night turns back on whoever threw it — the
   * witch, the dragon, the alchemist, the priest, infected or not. (The pack's bite and the white wolf's kill are
   * no potions: they kill him.)
   */
  private mirrors(by: string, target: string): boolean {
    if (this.powerOf(target) !== "mirror" || this.spent.has(target)) return false;
    this.spent.add(target);
    this.sendRole(target);
    this.logEvent("mirror_used", { name: this.nameOf(by) }, target);
    return true;
  }

  private witchActor(client: Client): string | null {
    const id = this.awakeActor(client);
    return id && this.witchActors.has(id) ? id : null;
  }

  private handleWitchRevive(client: Client) {
    const id = this.witchActor(client);
    const p = id && this.potions.get(id);
    if (!id || !p || !p.revive || !this.wolfVictim || this.reviving) return;
    p.revive = false;
    this.reviving = true;
    this.logEvent("witch_revived", { name: this.nameOf(this.wolfVictim) }, id);
    this.finishWitchIfNothingLeft(id);
  }

  private handleWitchPoison(client: Client, msg: { targetId: string }) {
    const id = this.witchActor(client);
    const p = id && this.potions.get(id);
    if (!id || !p || !p.poison || !this.canKillTonight() || !this.isAlive(msg?.targetId)) return; // she may poison herself
    p.poison = false;
    this.poisons.set(id, msg.targetId);
    this.finishWitchIfNothingLeft(id);
  }

  private handleWitchPass(client: Client) {
    const id = this.witchActor(client);
    if (!id) return;
    this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  private finishWitchIfNothingLeft(id: string) {
    const p = this.potions.get(id)!;
    const canStillRevive = p.revive && !this.reviving && this.wolfVictim !== null;
    if (!canStillRevive && !(p.poison && this.canKillTonight())) this.awake.delete(id);
    this.maybeEndWitchSeer();
  }

  private maybeEndWitchSeer() {
    if (this.awake.size === 0) this.resolveNight();
  }

  private resolveNight() {
    const deaths = new Map<string, DeathCause>();
    const trapped = (id: string | null) => !!id && this.traps.has(id);
    /** [dead] dies of [cause], unless something else already got him tonight. */
    const dies = (dead: string, cause: DeathCause): void => {
      if (!deaths.has(dead)) deaths.set(dead, cause);
    };
    if (this.wolfVictim && !this.reviving && !trapped(this.wolfVictim)) deaths.set(this.wolfVictim, "wolves");
    // The trap: a wolf who went for the trapped player dies instead — unless a witch revived him.
    if (trapped(this.wolfTarget) && !this.reviving && !this.infectNow) {
      const voters = [...this.wolfVotes].filter(([w, t]) => t === this.wolfTarget && this.isAlive(w)).map(([w]) => w);
      if (voters.length) deaths.set(pickRandom(voters), "trap");
    }
    // A big bad wolf's own victim (no witch for that one) — or the trap, closing on the wolf himself.
    for (const [wolf, target] of this.bigBadTargets) if (trapped(target)) deaths.set(wolf, "trap");
    for (const victim of this.bigBadVictims) dies(victim, "wolves");
    // The killer's knife: the policeman's cage and a protector's ward stop it (that's news for the narrator); on the
    // trapped player it's the killer who dies; nothing else does, not even the witch.
    for (const [killer, target] of this.knives) {
      if (!this.isAlive(target) || this.isCaged(target)) continue;
      if (trapped(target)) dies(killer, "trap");
      else if (this.isProtected(target)) this.nightNews.push("protected");
      else dies(target, "killer");
    }
    /**
     * A potion or a fire thrown by [by] at [target]. The cage keeps everything out; a potion on the trapped player
     * kills the one who threw it; the mirror sends it back at him.
     */
    const strike = (by: string, target: string, cause: DeathCause, potion: boolean): void => {
      if (!this.isAlive(target) || this.isCaged(target)) return;
      if (potion && trapped(target)) return dies(by, "trap");
      if (cause === "witch" && UNTOUCHABLE.has(this.roles.get(target))) return; // her poison can't kill those loners
      // A protector's ward (infected or not) stops them all: the witch's poison, the alchemist's, the priest's holy
      // water, the dragon's fire (spent all the same). Of the night's deaths only the guitarist's song and a broken
      // heart get past it (and those a player brings on himself: a trap, the mirror, a wolf's house).
      if (this.isProtected(target)) return;
      if (this.mirrors(by, target)) return dies(by, "mirror");
      dies(target, cause);
    };
    for (const [poisoner, target] of this.poisons) strike(poisoner, target, "witch", true);
    for (const target of this.whiteTargets) {
      if (this.isAlive(target) && !this.isCaged(target) && !this.isProtected(target)) dies(target, "whitewolf");
    }
    for (const [dragon, target] of this.dragonFires) strike(dragon, target, "dragon", false);
    for (const { by, target, role } of this.flasks) {
      if (role === "alchemist") strike(by, target, "alchemist", true);
      // The priest's holy water kills a wolf (the white wolf too); thrown at anyone else, it's the priest who dies.
      else if (this.isPack(target)) strike(by, target, "priest", true);
      else if (this.isAlive(target) && !this.isCaged(target)) dies(by, trapped(target) ? "trap" : "priest_fail");
    }
    // The guitarist's song: one of his two picks holds the role he named, and both die of it.
    for (const { by, targets, role } of this.strums) {
      const hit = targets.some((t) => this.roles.get(t) === role);
      if (hit) for (const t of targets) if (this.isAlive(t) && !this.isCaged(t)) dies(t, "guitarist");
      this.logEvent("guitar_result", { hit, role }, by);
    }
    // The cat who went to sleep at a wolf's house.
    for (const [cat, house] of this.catVisits) if (this.isAlive(cat) && this.isPack(house)) dies(cat, "cat");
    // The knight's rusty sword: the wolves killed him, and the first living wolf after him round the table (on his
    // left) dies of it the same morning.
    for (const [id, cause] of [...deaths]) {
      if (cause !== "wolves" || this.powerOf(id) !== "knight") continue;
      const seats = this.livingSeats();
      const from = seats.indexOf(id);
      const round = seats.map((_, i) => seats[(from + 1 + i) % seats.length]);
      const wolf = round.find((w) => this.isPack(w) && !deaths.has(w) && !this.isCaged(w));
      if (wolf) deaths.set(wolf, "knight");
    }
    this.state.nightStep = "";
    this.state.nightRoles = "";
    // The log reads: "Day N", "the village wakes up", then one line per death (who killed whom).
    this.logEvent("day", { day: this.state.dayNumber });
    this.logEvent("village_wakes", { deaths: deaths.size });
    for (const role of this.seerNews) this.logEvent("seer_public", { role }); // the role, not who
    for (const same of this.detectiveNews) this.logEvent("detective_public", { same }); // the verdict, not who
    // The shepherd counts his sheep, the rabbit his chocolates (the village hears it too, if the room says so).
    for (const { by, role, count } of this.gifts) {
      // All three sheep came back, or both chocolates were eaten: no wolf found, and his power is gone.
      const lost = (role === "shepherd" && count === 3) || (role === "rabbit" && count === 2);
      if (lost) {
        this.spent.add(by);
        this.sendRole(by);
      }
      this.logEvent("gifts_back", { role, count, lost }, by);
      if (this.option(role === "shepherd" ? "talkingShepherd" : "talkingRabbit")) this.logEvent("gifts_public", { role, count });
    }
    // The narrator tells what the night hid (without him it all stays secret): the witch's save, an attack that
    // came to nothing (a protected player, Red Hood, the ancient), an infection. Never who.
    const told = this.state.narrator;
    if (told && this.reviving) this.logEvent("witch_saved");
    if (told) for (const what of this.nightNews) this.logEvent("narrator", { what });
    // A dragon's fire comes back when it took a wolf or a loner; burning a villager puts it out for good.
    for (const [dragon, burned] of this.dragonFires) {
      if (deaths.get(burned) !== "dragon" || !this.againstVillage(burned)) continue;
      this.spent.delete(dragon);
      this.sendRole(dragon);
      this.logEvent("dragon_recharged", {}, dragon);
    }
    // (Everyone learns whose house the cat died in.)
    for (const [id, cause] of deaths) this.kill(id, cause, cause === "cat" ? { house: this.nameOf(this.catVisits.get(id)) } : {});
    this.morningNews();
    this.broadcast("night_result", { deaths: [...deaths.keys()], saved: told && this.reviving });
    if (this.endGameIfOver()) return;
    this.afterDeaths(() => this.startDay());
  }

  /** The father's bite: he joins the pack right away (their chat and voice) and is told so. */
  private infect(turned: string) {
    this.infected.add(turned);
    this.clients.getById(turned)?.send("infected");
    this.logEvent("you_infected", {}, turned);
    for (const w of this.packIds()) {
      if (w !== turned) this.logEvent("pack_joined", { name: this.nameOf(turned) }, w);
      this.sendRole(w); // everyone in the pack gets the new pack list
    }
  }

  /** What the night did to the living, told at daybreak: silenced, robbed of a role, marked, tricked. */
  private morningNews() {
    for (const silenced of new Set(this.silences.values())) {
      if (!this.isAlive(silenced)) continue;
      if (this.state.protectorShield && this.isProtected(silenced)) continue; // the shield stops the silence too
      this.state.players.get(silenced)!.silenced = true;
      this.clients.getById(silenced)?.send("silenced");
      this.logEvent("silenced", { name: this.nameOf(silenced) });
    }
    for (const robbed of this.stolenFrom) {
      if (!this.isAlive(robbed)) continue;
      this.clients.getById(robbed)?.send("role_stolen");
      this.logEvent("role_stolen", {}, robbed);
      this.sendRole(robbed);
    }
    // The ravens' and the owls' marks, for everyone to see in today's vote.
    for (const [target, bonus] of this.voteMarks) {
      if (!this.isAlive(target)) continue;
      this.state.players.get(target)!.voteBonus += bonus;
      this.logEvent(bonus > 0 ? "raven_mark" : "owl_mark", { name: this.nameOf(target) });
    }
    // A trickster shows his pick's real card to the whole village (and the infection, if any).
    for (const tricked of this.tricks) {
      if (!this.isAlive(tricked)) continue;
      const p = this.state.players.get(tricked)!;
      p.revealedRole = this.roles.get(tricked) ?? "";
      p.infectedShown = this.infected.has(tricked);
      this.logEvent("tricked", { name: p.name, role: p.revealedRole, infected: p.infectedShown });
    }
  }

  /**
   * After deaths: wait for the clients' card reveals, then each dead hunter shoots, then a dead mayor
   * names a successor; then [next] runs.
   */
  private afterDeaths(next: () => void): void {
    if (this.revealsPending > 0) {
      const ms = this.revealsPending * REVEAL_MS;
      this.revealsPending = 0;
      this.state.phase = "reveal";
      this.setPhaseTimer(ms, () => this.afterDeaths(next));
      return;
    }
    const shooter = this.pendingShooters.shift();
    if (shooter) return this.startHunterShot(shooter, next);
    const from = this.pendingSuccession;
    this.pendingSuccession = null;
    if (!from) return next();
    this.state.phase = "succession";
    this.state.successionFrom = from;
    this.logEvent("succession", { name: this.nameOf(from) });
    this.afterSuccession = next;
    this.setPhaseTimer(this.stepMs(), () => this.endSuccession(null));
  }

  private afterSuccession: () => void = () => {};
  private afterShot: () => void = () => {};

  /**
   * A dead hunter takes someone with him: aimed at random already, he has 10s to aim elsewhere and
   * shoot. Everyone sees where he's aiming (state.shooterAim); at the end of the 10s that one is shot.
   */
  private startHunterShot(hunterId: string, next: () => void): void {
    const prey = [...this.state.players.keys()].filter((id) => this.isAlive(id) && id !== hunterId);
    if (!prey.length) {
      this.stand(hunterId);
      return this.afterDeaths(next);
    }
    this.afterShot = next;
    this.state.phase = "hunter";
    this.state.shooterId = hunterId;
    this.state.shooterAim = pickRandom(prey);
    this.logEvent("hunter_turn", { name: this.nameOf(hunterId) });
    this.setPhaseTimer(this.stepMs(), () => this.endHunterShot());
  }

  private handleHunterAim(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "hunter" || client.sessionId !== this.state.shooterId) return;
    if (this.isAlive(msg?.targetId)) this.state.shooterAim = msg.targetId;
  }

  private handleHunterShoot(client: Client, msg: { targetId: string }) {
    if (this.state.phase !== "hunter" || client.sessionId !== this.state.shooterId) return;
    if (!this.isAlive(msg?.targetId)) return;
    this.state.shooterAim = msg.targetId;
    this.endHunterShot();
  }

  /**
   * A dead player with something left to do keeps standing in the apps (as he looked alive) until it's done:
   * a hunter until his shot is over, a mayor until his successor is named. Called whenever one of those changes.
   */
  private stand(id: string) {
    const player = this.state.players.get(id);
    if (!player) return;
    const st = this.state;
    const waiting = this.pendingShooters.includes(id) || st.shooterId === id || this.pendingSuccession === id || st.successionFrom === id;
    player.aiming = !player.alive && waiting;
  }

  private endHunterShot() {
    const target = this.state.shooterAim;
    const hunter = this.state.shooterId;
    this.state.shooterAim = "";
    this.state.shooterId = "";
    this.stand(hunter);
    if (target && this.isAlive(target)) {
      this.kill(target, "hunter");
    }
    if (this.endGameIfOver()) return;
    this.afterDeaths(this.afterShot);
  }

  private handleSuccessor(client: Client, msg: { targetId: string } | null) {
    if (this.state.phase !== "succession" || client.sessionId !== this.state.successionFrom) return;
    if (msg && !this.isAlive(msg.targetId)) return;
    this.endSuccession(msg?.targetId ?? null);
  }

  /** A null successor (pass or timeout) leaves the village without a mayor for the rest of the game. */
  private endSuccession(successor: string | null) {
    const from = this.state.successionFrom;
    this.state.mayorId = successor ?? "";
    this.state.successionFrom = "";
    this.stand(from);
    this.broadcast("mayor_result", { mayorId: successor, successor: true });
    this.logEvent("mayor", { name: this.nameOf(successor), successor: true });
    this.afterSuccession();
  }

  // ---- mayor election, day discussion, exclusion vote ----

  /**
   * The mayor election opens the game, before night 1: a whole day to talk and vote, same length and rules as any
   * day (plus the time of the card deal playing in the app). The village elects once; a dead mayor can only hand
   * the title on.
   */
  private startMayorVote() {
    this.state.phase = "mayor";
    this.clearVotes();
    this.dayShrunk = false;
    this.logEvent("mayor_election");
    this.setPhaseTimer(this.state.roundSeconds * 1000 + this.dealTime, () => this.resolveMayor());
    this.dealTime = 0;
  }

  private resolveMayor() {
    const mayor = topVoted(this.aliveVotes(1)) ?? ""; // a tie (or no vote): no mayor
    // The vote log keeps the election too ("mayor_votes": older apps would take it for a day's vote).
    this.mayorVote = { day: this.state.dayNumber, excluded: mayor || null, ballots: this.ballots(), mayorId: "", mayor: true };
    this.broadcast("mayor_votes", this.mayorVote);
    this.state.mayorId = mayor;
    this.broadcast("mayor_result", { mayorId: mayor || null });
    this.logEvent("mayor", { name: this.nameOf(mayor), successor: false });
    this.startNight();
  }

  /** Daybreak: the bear sniffs, the dictators who said so last night strike, then the debate. */
  private startDay() {
    this.bearSniffs(); // ("Day N" was logged at dawn)
    this.nextBomb();
  }

  /** Each bomb planted last night goes round the table; then the dictators' moment and the debate. */
  private nextBomb(): void {
    this.state.bombHolder = "";
    const bomb = this.bombs.shift();
    if (!bomb) return this.dictatorsMoment();
    if (!this.isAlive(bomb.target)) return this.nextBomb(); // its first holder didn't see the morning: no bomb
    this.bombFuse = bomb.count;
    this.bombFrom = "";
    this.logEvent("bomb_start", { name: this.nameOf(bomb.target) });
    this.holdBomb(bomb.target);
  }

  /**
   * [id] has the bomb, and everyone sees it (never how many hands it has left). On its last holder it blows; before
   * that he hands it on within the step's time, or it flies off by itself.
   */
  private holdBomb(id: string) {
    this.state.phase = "bomb";
    this.state.bombHolder = id;
    const others = this.bombTargets(id);
    if (--this.bombFuse > 0 && others.length > 0) {
      this.setPhaseTimer(this.stepMs(), () => this.passBomb(id, pickRandom(others)));
      return;
    }
    this.kill(id, "bomb");
    if (!this.endGameIfOver()) this.afterDeaths(() => this.nextBomb());
  }

  /**
   * Who the holder can hand it to: anyone alive but himself and the player he got it from (with two players left,
   * back to him). The first holder got it from the bomber, in secret: he can hand it to anyone.
   */
  private bombTargets(holder: string): string[] {
    const others = this.livingSeats().filter((id) => id !== holder);
    const fresh = others.filter((id) => id !== this.bombFrom);
    return fresh.length ? fresh : others;
  }

  private handleBombPass(client: Client, msg: { targetId: string }) {
    const id = client.sessionId;
    if (this.state.phase !== "bomb" || id !== this.state.bombHolder || !this.bombTargets(id).includes(msg?.targetId)) return;
    this.passBomb(id, msg.targetId);
  }

  private passBomb(from: string, to: string) {
    this.bombFrom = from;
    this.logEvent("bomb_passed", { from: this.nameOf(from), name: this.nameOf(to), fromId: from });
    this.holdBomb(to);
  }

  /**
   * The alien names a living player's role, as often as he likes in a day. Right: that player dies at once. Wrong:
   * one of the wrong guesses he can afford is gone (5 on village roles, 3 on wolves), and with none left of that
   * kind, he dies of it. Any role dealt in this game, never another loner's (for him the white wolf is a wolf).
   */
  private handleAlienGuess(client: Client, msg: { targetId: string; role: string }) {
    const id = this.dayActor(client, "alien");
    const left = id ? this.alienLeft.get(id) : undefined;
    const target = msg?.targetId;
    const guess = msg?.role as Role;
    if (!id || !left || !this.isAlive(target) || target === id) return;
    if (!this.dealt.has(guess) || (LONERS.has(guess) && guess !== "whitewolf")) return;
    const right = this.roles.get(target) === guess;
    const kind = WOLF_ROLES.has(guess) ? "wolves" : "village";
    const dead = right ? target : left[kind] === 0 ? id : null;
    if (!right && left[kind] > 0) left[kind]--;
    client.send("alien_result", { targetId: target, role: guess, right, ...left });
    this.logEvent("alien_guessed", { name: this.nameOf(target), role: guess, right, ...left }, id);
    if (!dead) return;
    this.kill(dead, right ? "alien" : "alien_fail");
    this.afterDayPower();
  }

  /** While a dictator who armed himself last night still can strike: his moment (again after each strike's deaths). */
  private dictatorsMoment() {
    for (const id of this.armed) {
      if (!this.isAlive(id) || this.powerOf(id) !== "dictator" || this.spent.has(id)) this.armed.delete(id);
    }
    if (this.armed.size === 0) return this.openDebate();
    this.state.phase = "dictator";
    this.logEvent("dictator_deciding");
    this.setPhaseTimer(this.stepMs(), () => {
      for (const id of this.armed) {
        this.spent.add(id); // he let his moment pass: the power is lost
        this.sendRole(id);
        this.logEvent("dictator_lost", {}, id);
      }
      this.armed.clear();
      this.openDebate();
    });
  }

  /** The day: players debate and vote at the same time; the vote is counted when the time runs out. */
  private openDebate(ms = this.state.roundSeconds * 1000) {
    this.state.phase = "day";
    this.clearVotes();
    this.dayShrunk = false;
    this.tieExtended = false;
    this.setPhaseTimer(ms, () => this.resolveVote());
  }

  /** Living, connected players who may vote today (the silenced can't). */
  private eligibleVoters() {
    return [...this.state.players.values()].filter((p) => p.alive && p.connected && !p.silenced);
  }

  /** Once all of them but one have voted, the day's (or election day's) time drops to 30 seconds (if it was longer). */
  private maybeShrinkDay() {
    if ((this.state.phase !== "day" && this.state.phase !== "mayor") || this.dayShrunk) return;
    const voters = this.eligibleVoters();
    if (voters.filter((p) => p.votedFor).length < voters.length - 1) return;
    if (this.state.phaseEndsAt - Date.now() <= SHRINK_MS) return;
    this.dayShrunk = true; // stays at 30s even if someone takes his vote back
    const phase = this.state.phase;
    this.setPhaseTimer(SHRINK_MS, () => (phase === "mayor" ? this.resolveMayor() : this.resolveVote()));
  }

  /** A living player using his one-shot day power ([role]) during the discussion. */
  private dayActor(client: Client, role: Role, phase = "day"): string | null {
    const id = client.sessionId;
    const ok = this.state.phase === phase && this.powerOf(id) === role && this.isAlive(id) && !this.spent.has(id);
    return ok ? id : null;
  }

  /** Enemies of the village for barbé and the dictator: any wolf, infected or turned player, and loners. */
  private againstVillage(id: string) {
    return this.teamOf(id) !== "village";
  }

  /**
   * Barbé asks the role of the player speaking (the app only offers the one voice it hears): it's
   * shown to everyone; an enemy of the village dies, anyone else — she dies.
   */
  private handleBarbe(client: Client, msg: { targetId: string }) {
    const id = this.dayActor(client, "barbe");
    const target = msg?.targetId;
    if (!id || !this.isAlive(target) || target === id) return;
    this.spent.add(id);
    this.sendRole(id);
    const guilty = this.againstVillage(target);
    // An enemy's real card is shown (an infected player's original role); an innocent shows a simple villager.
    const shown = guilty ? (this.roles.get(target) ?? "") : "villager";
    this.state.players.get(target)!.revealedRole = shown;
    if (!guilty) this.logEvent("barbe", { name: this.nameOf(target), role: shown, guilty });
    if (guilty) this.kill(target, "barbe");
    else this.kill(id, "barbe_fail");
    this.afterDayPower();
  }

  /** Right: the target dies and the dictator takes the mayor's title. Wrong: they both die. */
  private handleDictator(client: Client, msg: { targetId: string }) {
    const id = this.dayActor(client, "dictator", "dictator");
    const target = msg?.targetId;
    if (!id || !this.isAlive(target) || target === id) return;
    this.spent.add(id);
    this.sendRole(id);
    const right = this.againstVillage(target);
    this.kill(target, "dictator");
    if (right) {
      if (this.pendingSuccession === target) {
        this.pendingSuccession = null; // the title goes to him
        this.stand(target);
      }
      this.state.mayorId = id;
      this.broadcast("mayor_result", { mayorId: id, dictator: true });
    } else {
      this.kill(id, "dictator_fail");
    }
    if (!this.endGameIfOver()) this.afterDeaths(() => this.dictatorsMoment());
  }

  /** After a day power's deaths: reveals, hunters, succession — then the discussion goes on. */
  private afterDayPower() {
    if (this.endGameIfOver()) return;
    const left = Math.max(10_000, this.state.phaseEndsAt - Date.now());
    this.afterDeaths(() => {
      this.state.phase = "day"; // the votes already cast stay
      this.setPhaseTimer(left, () => this.resolveVote());
    });
  }

  /** At daybreak the bear roars if a wolf sits next to him (the nearest living player on each side). */
  private bearSniffs() {
    const seats = this.livingSeats();
    const n = seats.length;
    const smells = (id: string, i: number) =>
      this.powerOf(id) === "bear" && [seats[(i + 1) % n], seats[(i - 1 + n) % n]].some((x) => x !== id && this.isPack(x));
    if (seats.some(smells)) this.logEvent("bear_roar");
  }

  private clearVotes() {
    for (const p of this.state.players.values()) p.votedFor = "";
    this.votedAt.clear();
  }

  /** Who each living player voted for (voter → target). */
  private ballots(): Record<string, string> {
    const ballots: Record<string, string> = {};
    for (const [id, p] of this.state.players) if (p.votedFor && p.alive) ballots[id] = p.votedFor;
    return ballots;
  }

  /** Every living player's vote; the mayor's counts [mayorWeight] times. */
  private aliveVotes(mayorWeight: number): string[] {
    const votes: string[] = [];
    for (const [id, p] of this.state.players) {
      if (!p.alive || !p.votedFor) continue;
      for (let i = 0; i < (id === this.state.mayorId ? mayorWeight : 1); i++) votes.push(p.votedFor);
    }
    return votes;
  }

  private handleDayVote(client: Client, msg: { targetId: string }) {
    const phase = this.state.phase;
    if (phase !== "day" && phase !== "mayor") return;
    const voter = this.state.players.get(client.sessionId);
    if (!voter?.alive || voter.silenced) return; // the black wolf's victim doesn't vote today…
    if (!this.isAlive(msg?.targetId)) return; // voting for yourself is allowed
    if (this.state.players.get(msg.targetId)?.silenced) return; // …and can't be voted against
    if (phase === "day" && msg.targetId === this.state.spared) return; // the judge's revote spares him
    if (voter.votedFor === msg.targetId) {
      voter.votedFor = ""; // tapped again: vote taken back
      return;
    }
    voter.votedFor = msg.targetId;
    this.votedAt.set(client.sessionId, ++this.voteSeq);
    this.maybeShrinkDay(); // the vote is counted when the day's time ends
  }

  /** A vote that puts someone out first gives the (secret) judge a few seconds to order a new one. */
  private resolveVote() {
    const votes = this.withMarks(this.aliveVotes(2));
    // The day ends on a tie at the top: a bell, and a little more time to break it (once: still tied, nobody goes).
    if (!this.tieExtended && topCandidates(votes).length > 1) {
      this.tieExtended = true;
      this.logEvent("vote_tie_extra", { seconds: TIE_MS / 1000 });
      this.setPhaseTimer(TIE_MS, () => this.resolveVote());
      return;
    }
    const excluded = topVoted(votes); // ponytail: a tie skips elimination; add a runoff vote if that feels unsatisfying
    const judge = this.idsWithRole("judge").some((id) => this.isAlive(id) && !this.spent.has(id));
    if (excluded && judge && !this.state.spared) {
      this.pendingVote = votes;
      this.state.phase = "judge";
      this.state.judgeTarget = excluded;
      this.logEvent("judge_deciding", { name: this.nameOf(excluded) });
      this.setPhaseTimer(JUDGE_MS, () => this.finishVote(excluded, votes));
      return;
    }
    this.finishVote(excluded, votes);
  }

  private handleJudge(client: Client, msg: { revote: boolean }) {
    const id = client.sessionId;
    if (this.state.phase !== "judge" || this.powerOf(id) !== "judge" || !this.isAlive(id) || this.spent.has(id)) return;
    const target = this.state.judgeTarget;
    if (!msg?.revote) return this.finishVote(target, this.pendingVote);
    this.spent.add(id);
    this.sendRole(id);
    this.state.judgeTarget = "";
    this.state.spared = target; // the new vote is final, and can't put him out
    this.logEvent("judge_revote", { name: this.nameOf(target) });
    this.openDebate(REVOTE_MS); // a short day: talk and vote again
  }

  /** The raven's +2 and the owl's −2 (never below zero) added to the ballots. */
  private withMarks(votes: string[]): string[] {
    const out = [...votes];
    for (const [id, p] of this.state.players) {
      if (!p.alive || !p.voteBonus) continue;
      for (let i = 0; i < Math.abs(p.voteBonus); i++) {
        if (p.voteBonus > 0) out.push(id);
        else if (out.includes(id)) out.splice(out.indexOf(id), 1);
      }
    }
    return out;
  }

  private finishVote(excluded: string | null, votes: string[]) {
    this.state.judgeTarget = "";
    this.state.spared = "";
    // The joker is never voted out: he picks someone to die in his place (or dies if he doesn't).
    if (excluded && this.powerOf(excluded) === "joker") {
      this.pendingVote = votes;
      this.state.phase = "joker";
      this.state.jokerId = excluded;
      this.logEvent("joker_turn", { name: this.nameOf(excluded) });
      this.setPhaseTimer(this.stepMs(), () => this.endJoker(null));
      return;
    }
    this.completeVote(excluded, votes, "vote");
  }

  private handleJokerPick(client: Client, msg: { targetId: string }) {
    const target = msg?.targetId;
    if (this.state.phase !== "joker" || client.sessionId !== this.state.jokerId) return;
    if (!this.isAlive(target) || target === client.sessionId) return;
    this.endJoker(target);
  }

  private endJoker(target: string | null) {
    const joker = this.state.jokerId;
    this.state.jokerId = "";
    if (target) this.completeVote(target, this.pendingVote, "joker");
    else this.completeVote(joker, this.pendingVote, "vote");
  }

  private completeVote(excluded: string | null, votes: string[], cause: DeathCause) {
    const bestCount = excluded ? votes.filter((v) => v === excluded).length : 0;

    const voters = this.aliveCount() + (this.isAlive(this.state.mayorId) ? 1 : 0);
    // The record first: a death wipes the votes against the dead (and a dead mayor's title).
    const ballots = this.ballots();
    // The village's idiot: the first vote against him shows his card and lets him live — and he keeps his own vote.
    const idiot = cause === "vote" && !!excluded && this.powerOf(excluded) === "idiot" && !this.spent.has(excluded);
    const record: VoteRecord = { day: this.state.dayNumber, excluded: idiot ? null : excluded, ballots, mayorId: this.state.mayorId };
    this.voteHistory.push(record);
    if (idiot) {
      this.spent.add(excluded!);
      this.state.players.get(excluded!)!.revealedRole = "idiot";
      this.sendRole(excluded!);
    } else if (excluded) this.kill(excluded, cause);

    this.broadcast("vote_result", { ...record, votes: bestCount, voters });
    if (excluded && !idiot && cause === "vote") this.chameleonsRob(excluded);
    if (idiot) this.logEvent("idiot_saved", { name: this.nameOf(excluded) });
    else if (cause === "vote") this.logEvent("vote_result", {
      name: this.nameOf(excluded),
      role: excluded ? this.roles.get(excluded) : null,
      ...(excluded ? this.deathMarks(excluded) : { infected: false }),
    });
    if (!this.endGameIfOver()) this.afterDeaths(() => this.startNight());
  }

  /**
   * The chameleon wolf's one theft. The village voted, he got votes, and another player was put out: he takes the
   * role of the first living villager who voted against him, as the green wolf does. He stays a wolf; that player is
   * a simple villager from now on. (Voted out himself, he just dies.)
   */
  private chameleonsRob(excluded: string) {
    for (const thief of this.idsWithRole("chameleonwolf")) {
      if (!this.isAlive(thief) || thief === excluded) continue;
      const voters = [...this.state.players].filter(([id, p]) => p.alive && p.votedFor === thief && this.teamOf(id) === "village");
      const [first] = voters.map(([id]) => id).sort((a, b) => (this.votedAt.get(a) ?? 0) - (this.votedAt.get(b) ?? 0));
      if (!first) continue;
      const role = this.powerOf(first)!;
      this.rob(thief, first);
      this.logEvent("chameleon_stole", { name: this.nameOf(first), role }, thief);
      this.clients.getById(first)?.send("role_stolen", { by: "chameleonwolf" });
      this.logEvent("role_stolen", { by: "chameleonwolf" }, first);
      this.sendRole(thief);
      this.sendRole(first);
    }
  }

  // ---- chat ----

  /** A VIP spectator starts talking to the dead: a line in their chat says so (one a minute at most). */
  private handleSpectatorSpeaking(client: Client) {
    const id = client.sessionId;
    if (!this.spectators.has(id) || !this.vipPros.has(id) || !this.inGraveyard(id)) return;
    const now = Date.now();
    if (now - (this.spokeAt.get(id) ?? 0) < SPEAKING_LINE_MS) return;
    this.spokeAt.set(id, now);
    const account: Account | null = client.auth?.account ?? null;
    const line: ChatLine = {
      from: id,
      name: account?.name ?? "spectator",
      uid: account?.uid ?? "",
      avatar: account?.avatar ?? 0,
      frame: account?.frame ?? 0,
      vip: vipLevel(account),
      text: "",
      at: now,
      wolvesOnly: false,
      dead: true,
      speaking: true,
    };
    this.deadChatLog.push(line);
    for (const c of this.clients) if (this.inGraveyard(c.sessionId)) c.send("chat", line);
  }

  private handleChat(client: Client, msg: { text: string }) {
    const id = client.sessionId;
    const player = this.state.players.get(id);
    const text = typeof msg?.text === "string" ? msg.text.trim().slice(0, CHAT_MAX) : "";
    if (!text || this.admins.has(id)) return;
    const account: Account | null = client.auth?.account ?? null;
    const phase = this.state.phase;
    const payload: ChatLine = {
      from: id,
      name: player?.name ?? account?.name ?? "spectator",
      uid: player?.uid ?? account?.uid ?? "",
      avatar: player?.avatar ?? account?.avatar ?? 0,
      frame: player?.frame ?? account?.frame ?? 0,
      vip: vipLevel(account),
      text,
      at: Date.now(),
      wolvesOnly: phase === "night",
    };
    // Out of the game while it runs (dead, or watching): they write to each other, the living never read it.
    if (this.inGraveyard(id)) {
      Object.assign(payload, { wolvesOnly: false, dead: true });
      this.deadChatLog.push(payload);
      for (const c of this.clients) if (this.inGraveyard(c.sessionId)) c.send("chat", payload);
      return;
    }
    if (!player) return; // watching a room that isn't playing: nobody to write to
    if (player.silenced && this.gameRunning()) {
      client.send("error", { code: "silenced_chat" }); // no voice, no vote, no writing today
      return;
    }

    if (phase !== "night") {
      // The host may close the chat to the living while the game runs: then only the dead and the spectators write.
      if (this.option("noLivingChat") && !this.chatOnly && this.gameRunning()) {
        client.send("error", { code: "living_chat_off" });
        return;
      }
      this.chatLog.push(payload);
      this.broadcast("chat", payload);
      return;
    }
    // At night only the pack talks, and only to itself.
    if (!this.isPack(id)) return;
    this.wolfChatLog.push(payload);
    const pack = this.packIds().filter((id) => this.isAlive(id)); // a dead wolf reads no more of it
    for (const id of [...pack, ...this.admins]) this.clients.getById(id)?.send("chat", payload);
  }

  /**
   * An emoji over a player's avatar, for everyone to see — but none from the living at night (it would show who is
   * awake) or from a silenced player; while the game runs, a dead player's goes to the dead and the spectators only.
   */
  private handleEmoji(client: Client, msg: { id: string }) {
    const id = client.sessionId;
    const player = this.state.players.get(id); // (spectators have no seat to show it over)
    if (!player) return;
    const graveyard = this.inGraveyard(id);
    if (!graveyard && this.gameRunning() && (this.state.phase === "night" || player.silenced)) return;
    const emoji = msg?.id;
    if (!emojisOpen(this.vips.has(id)) || !emojiAllowed(this.emojiAt, id, emoji)) return;
    const payload = { from: id, id: emoji };
    if (!graveyard) return this.broadcast("emoji", payload);
    for (const c of this.clients) if (this.inGraveyard(c.sessionId)) c.send("emoji", payload);
  }

  // ---- shared helpers ----

  /** Still to act in the one-role night step [step], as [role]. */
  private stepActor(client: Client, step: string, role: Role): boolean {
    const id = client.sessionId;
    const st = this.state;
    return st.phase === "night" && st.nightStep === step && this.acting.has(id) && this.powerOf(id) === role && this.isAlive(id);
  }

  /** What he does at night: his role, or the one the green wolf stole ("villager" for the victim). */
  private powerOf(id: string): Role | undefined {
    const power = this.powers.get(id) ?? this.roles.get(id);
    // After the ancient's curse, the village's special players are plain villagers (their role stays).
    if (this.villageDisabled && power && power !== "villager" && this.teamOf(id) === "village") return "villager";
    return power;
  }

  /** Wolves of every kind, the white wolf, the players a father wolf infected, a turned wild child, a wolfdog who chose them. */
  private isPack(id: string | undefined): boolean {
    const role = id ? this.roles.get(id) : undefined;
    return !!role && (WOLF_ROLES.has(role) || this.infected.has(id!) || this.turned.has(id!));
  }

  private packIds(): string[] {
    return [...this.roles.keys()].filter((id) => this.isPack(id));
  }

  /** Who he wins with: a loner alone (unless a father wolf turned him), the pack (infected included), or the village. */
  private teamOf(id: string): Team {
    const role = this.roles.get(id);
    if (role && LONERS.has(role) && !this.infected.has(id)) return role as Loner;
    return this.isPack(id) ? "wolves" : "village";
  }

  private idsWithRole(role: Role): string[] {
    return [...this.roles.keys()].filter((id) => this.powerOf(id) === role);
  }

  private aliveWithRole(role: Role): string | undefined {
    return this.idsWithRole(role).find((id) => this.isAlive(id));
  }

  /** Everyone who plays [role] tonight: alive, not paralysed by a red wolf, not in the policeman's cage. */
  private holders(role: Role): string[] {
    return this.idsWithRole(role).filter((id) => this.isAlive(id) && !this.isParalysed(id) && !this.isCaged(id));
  }

  private isCaged(id: string): boolean {
    return [...this.cages.values()].includes(id);
  }

  /** The red wolf's spell holds on anyone but a loner. */
  private isParalysed(id: string): boolean {
    return [...this.paralysed.values()].includes(id) && !LONERS.has(this.roles.get(id)!);
  }

  private isProtected(id: string): boolean {
    return [...this.protects.values()].includes(id);
  }

  /** The other brothers of [id] (two are dealt; a doubler's copy makes a third). */
  private brothersOf(id: string): string[] {
    return this.idsWithRole("brothers").filter((b) => b !== id);
  }

  /** What a death shows besides the card: an infection, and the side a wolfdog chose. */
  private deathMarks(id: string) {
    const wolfdog = this.roles.get(id) === "wolfdog" ? { wolfdogWolves: this.turned.has(id) } : {};
    return { infected: this.infected.has(id), ...wolfdog };
  }

  /**
   * Every death goes through here: the app plays a card reveal for each death_reveal. A hunter killed
   * in play (not by leaving) shoots once the reveals are over; his own app skips his reveal.
   */
  private kill(sessionId: string, cause: DeathCause, more: Record<string, unknown> = {}) {
    const player = this.state.players.get(sessionId);
    if (!player?.alive) return;
    player.alive = false;
    player.revealedRole = this.roles.get(sessionId) ?? "";
    if (this.infected.has(sessionId)) player.infectedShown = true;
    const inPlay = cause !== "quit" && cause !== "timeout";
    const shooter = inPlay && this.isHunter(sessionId);
    const marks = this.deathMarks(sessionId);
    this.broadcast("death_reveal", { id: sessionId, name: player.name, role: player.revealedRole, cause, shooter, ...marks, ...more });
    // The vote and leaving have their own lines; every other death says who killed whom.
    if (!["vote", "quit", "timeout"].includes(cause)) {
      this.logEvent("death", { name: player.name, role: player.revealedRole, cause, ...marks, ...more });
    }
    if (inPlay) this.revealsPending++;
    if (shooter) this.pendingShooters.push(sessionId);
    if (this.state.mayorId === sessionId) {
      this.state.mayorId = "";
      this.pendingSuccession = sessionId;
    }
    this.stand(sessionId);
    for (const p of this.state.players.values()) if (p.votedFor === sessionId) p.votedFor = ""; // no votes for the dead
    // A lover dies of a broken heart; the wild child's model's death turns him into a wolf.
    const partner = this.lovers?.find((id) => id !== sessionId && this.lovers!.includes(sessionId));
    if (partner && this.isAlive(partner)) {
      this.kill(partner, "love");
    }
    this.turnWildChildren(sessionId);
    // The first wolf of the pack to die (the white wolf isn't one) leaves his role to the puppet.
    const card = this.roles.get(sessionId);
    if (!this.wolfLost && card && WOLF_ROLES.has(card) && !LONERS.has(card)) {
      this.wolfLost = true;
      for (const puppet of this.idsWithRole("puppet")) if (this.isAlive(puppet)) this.takeOver(puppet, sessionId);
    }
    // A brother who loses his brother takes up his gun: he'll shoot when he dies, like a hunter.
    if (this.powerOf(sessionId) === "brothers") {
      for (const b of this.brothersOf(sessionId)) if (this.isAlive(b)) this.logEvent("brother_avenger", { name: player.name }, b);
    }
    // The village killed its own ancient: every village power is gone for the rest of the game.
    if (this.roles.get(sessionId) === "ancient" && VILLAGE_KILLS.includes(cause) && !this.villageDisabled) {
      this.villageDisabled = true;
      this.logEvent("ancient_curse");
      // The village's special players are simple villagers from now on, card and all; the wolves keep everything.
      for (const [id, role] of this.roles) {
        if (id === sessionId || role === "villager" || !this.isAlive(id) || this.teamOf(id) !== "village") continue;
        this.roles.set(id, "villager");
        this.powers.delete(id);
        this.potions.delete(id);
        this.clients.getById(id)?.send("cursed");
      }
      for (const id of this.roles.keys()) this.sendRole(id);
    }
  }

  /** The hunter, the hunter wolf, the triple face from night 3 on — and a brother who has lost his brother. */
  private isHunter(id: string): boolean {
    const role = this.powerOf(id);
    if (role === "brothers") return this.brothersOf(id).some((b) => !this.isAlive(b));
    return role === "hunter" || role === "juniorwolf" || (role === "tripleface" && this.faceNight(id) >= 3);
  }

  private isAlive(sessionId: string | undefined): boolean {
    return !!sessionId && this.state.players.get(sessionId)?.alive === true;
  }

  private aliveCount(): number {
    let count = 0;
    for (const p of this.state.players.values()) if (p.alive) count++;
    return count;
  }

  /**
   * The village wins when every wolf (white wolf included) is dead; the pack when the village and the
   * white wolf are; the white wolf when he's the last one standing. A witch with potions can still win a 1-v-1.
   */
  private endGameIfOver(): boolean {
    const living = this.livingSeats();
    const sides = [...new Set(living.map((id) => this.teamOf(id)))];
    // Lovers from opposite sides win together when they're the last two standing.
    const [a, b] = this.lovers ?? [];
    const loversWin = living.length === 2 && this.isAlive(a) && this.isAlive(b) && this.teamOf(a!) !== this.teamOf(b!);
    // The piper wins as soon as every other living player is under his spell.
    const piperWins = sides.includes("piper") && living.every((id) => this.teamOf(id) === "piper" || this.charmed.has(id));
    const last = sides.length === 1 ? sides[0] : null; // one side left standing
    const winner: Winner | null =
      loversWin ? "lovers"
      : piperWins ? "piper"
      : sides.every((side) => side === "village") ? "villagers" // (nobody left at all: the village's game too)
      : last === "wolves" ? "werewolves"
      : last && last !== "village" ? last // a loner, alone at last
      : null;
    if (winner) this.endGame(winner);
    return winner !== null;
  }

  /** He's gone for good: his profile no longer says he's in this room. */
  private clearRoomOf(sessionId: string) {
    const uid = this.members.get(sessionId);
    if (!uid) return;
    this.members.delete(sessionId);
    if ([...this.members.values()].includes(uid)) return; // still here on another connection
    leaveRoom(uid, this.roomId);
  }

  onDispose() {
    for (const id of [...this.members.keys()]) this.clearRoomOf(id);
    if (this.voiceOn) closeVoice(this.roomId).catch(() => {});
  }

  // ---- voice ----

  /**
   * The living voice room, now: lobby and game over, every player talks; night, only living wolves
   * talk and hear each other (the other living hear nothing); votes, nobody talks; otherwise the living
   * talk. The dead listen (they talk in the graveyard); spectators too, except at night.
   */
  private voiceRightsOf(id: string): VoiceRights {
    if (this.admins.has(id)) return { talk: false, hear: true };
    // Dusk and dawn (the night starting, the night ending): nobody talks and nobody hears until the voice server has
    // made it so for everyone (checkVoice); only then the pack talks (night) or the village hears (day). Without it a
    // wolf still talking at daybreak was heard by all, his circle lit, and the village heard the night's first words.
    if (this.voiceGate && this.gameRunning()) return NO_VOICE;
    const phase = this.state.phase;
    const night = phase === "night";
    if (this.spectators.has(id)) return { talk: false, hear: !night };
    const player = this.state.players.get(id);
    if (!player) return { talk: false, hear: false };
    if (!this.gameRunning()) return { talk: true, hear: true };
    // the dead: nothing of the night (the pack's talk). A dead hunter or mayor still to choose stays with the living
    // (he talks as they do) until his shot or his successor.
    if (!player.alive && !player.aiming) return { talk: false, hear: !night };
    if (night) {
      const wolf = this.isPack(id);
      return { talk: wolf, hear: wolf };
    }
    return { talk: phase !== "judge" && phase !== "dictator" && phase !== "joker" && !player.silenced, hear: true };
  }

  private gameRunning() {
    const phase = this.state.phase;
    return phase !== "lobby" && phase !== "starting" && phase !== "gameover";
  }

  /** Out of the game (dead, or watching) while it runs: he gets the graveyard voice room. */
  private inGraveyard(id: string) {
    if (this.admins.has(id)) return this.gameRunning();
    const player = this.state.players.get(id);
    // (a dead hunter or mayor still to choose isn't there yet: he stays with the living until it's done)
    return this.gameRunning() && (this.spectators.has(id) || (player?.alive === false && !player.aiming));
  }

  private graveSent = new Set<string>(); // given graveyard access

  /** The graveyard: the dead talk among themselves; of those watching, only VIP Pro may talk to them. */
  private graveRightsOf(id: string): VoiceRights {
    return { talk: !this.admins.has(id) && (!this.spectators.has(id) || this.vipPros.has(id)), hear: true };
  }

  // A voice access gives no rights (NO_VOICE): checkVoice grants the rights of the moment once he's in. An access is
  // good for hours, and LiveKit's app comes back with the same one after a dropped connection: with the rights it
  // carried (those of the waiting room: hear everyone) a villager whose connection dropped at night heard the pack
  // until the room closed, and one put out of the voice came straight back.
  private async sendGraveyard(id: string) {
    this.graveSent.add(id);
    const name = this.state.players.get(id)?.name ?? "spectator";
    const access = await voiceToken(this.roomId, id, name, NO_VOICE, true, this.admins.has(id));
    this.clients.getById(id)?.send("voice_grave", access);
  }

  private async handleVoiceJoin(client: Client) {
    if (!this.voiceOn) return client.send("voice", { enabled: false, chat: this.chatOnly });
    const id = client.sessionId;
    this.voiceRights.set(id, "joining"); // (checkVoice grants his rights once he's in)
    const name = this.state.players.get(id)?.name ?? "spectator";
    const hidden = this.admins.has(id);
    client.send("voice", { enabled: true, ...(await voiceToken(this.roomId, id, name, NO_VOICE, false, hidden)) });
  }

  private voiceGate = false; // dusk or dawn: nobody talks or hears until the voice server has done it (voiceRightsOf)
  private wasNight = false;
  private checkingVoice = false;

  /**
   * The voice rooms as the voice server has them, against the game: whoever has other rights than his is corrected,
   * and whoever the game doesn't know (he left, or was put out) is put out again. Every second; every 200 ms at dusk
   * and dawn, whose gate opens once a check finds nobody to correct.
   */
  private async checkVoice() {
    if (!this.voiceOn || this.checkingVoice) return;
    this.checkingVoice = true;
    try {
      let corrected = false;
      for (const p of await voiceParticipants(this.roomId)) {
        if (!this.voiceRights.has(p.identity)) {
          await dropFromVoice(this.roomId, p.identity).catch(() => {});
          continue;
        }
        const rights = this.voiceRightsOf(p.identity);
        this.voiceRights.set(p.identity, `${rights.talk},${rights.hear}`);
        if (p.talk === rights.talk && p.hear === rights.hear) continue;
        corrected = true;
        await grantVoice(this.roomId, p.identity, rights, { hidden: this.admins.has(p.identity) }).catch(() => {});
      }
      if (this.voiceGate && !corrected) this.voiceGate = false; // all as the gate wants: the next patch opens it
      if (this.graveSent.size > 0) {
        for (const p of await voiceParticipants(this.roomId, true)) {
          if (!this.graveSent.has(p.identity)) {
            await dropFromVoice(this.roomId, p.identity, true).catch(() => {});
            continue;
          }
          const rights = this.graveRightsOf(p.identity);
          if (p.talk === rights.talk && p.hear === rights.hear) continue;
          await grantVoice(this.roomId, p.identity, rights, { grave: true, hidden: this.admins.has(p.identity) }).catch(() => {});
        }
      }
    } catch {
      // (The voice server didn't answer: the next check tries again, and a gate stays shut until then.)
    } finally {
      this.checkingVoice = false;
    }
  }

  /** At dusk and dawn: checks every 200 ms until the gate opens. */
  private checkVoiceSoon() {
    this.clock.setTimeout(async () => {
      await this.checkVoice();
      if (this.voiceGate) this.checkVoiceSoon();
    }, 200);
  }

  /** Runs before each patch: pushes changed rights to LiveKit (only when they change). */
  private syncVoice() {
    if (!this.voiceOn) return;
    const night = this.gameRunning() && this.state.phase === "night";
    if (night !== this.wasNight) {
      this.wasNight = night;
      if (this.gameRunning() && !this.voiceGate) {
        this.voiceGate = true; // (pushed below, before the clients learn of the new phase)
        this.checkVoiceSoon();
      }
    }
    if (!this.gameRunning() && this.graveSent.size > 0) {
      this.graveSent.clear(); // game over: everyone back together in the living room
      closeVoice(this.roomId, { graveOnly: true }).catch(() => {});
    }
    for (const id of this.voiceRights.keys()) {
      if (!this.graveSent.has(id) && this.inGraveyard(id)) this.sendGraveyard(id).catch(() => {});
    }
    for (const [id, last] of this.voiceRights) {
      const rights = this.voiceRightsOf(id);
      const now = `${rights.talk},${rights.hear}`;
      if (now === last) continue;
      this.voiceRights.set(id, now);
      setVoiceRights(this.roomId, id, rights).catch(() => {}); // not connected (yet): his token has them
    }
  }

  /** A null winner means the room ran out of time: nobody wins. The room then closes after a visible 60s. */
  private endGame(winner: Winner | null) {
    this.state.phase = "gameover";
    this.passHostIfGone(); // a host who quit mid-game can't recreate the room
    this.state.nightStep = "";
    this.state.nightRoles = "";
    this.state.winner = winner ?? "none";
    this.state.shooterId = "";
    this.state.shooterAim = "";
    this.state.bombHolder = "";
    this.phaseTimer?.clear();
    for (const [id, player] of this.state.players) {
      player.revealedRole = this.roles.get(id) ?? "";
      player.aiming = false;
    }
    this.broadcast("game_over", { winner, reason: winner ? "win" : "expired" });
    this.logEvent("game_over", { winner, reason: winner ? "win" : "expired" });
    if (winner) this.awardResults(winner); // an expired room counts for nobody
    this.state.phaseEndsAt = Date.now() + CLOSE_AFTER_GAME_MS; // clients count down to the room closing
    this.closeTimer ??= this.clock.setTimeout(() => this.disconnect(), CLOSE_AFTER_GAME_MS);
    this.updateListing();
  }

  /**
   * Each signed-in player's result: his side won or lost (leaving while alive is a loss), over the
   * whole minutes played since the deal (at least 1). Written to his account; he's told his reward.
   */
  private awardResults(winner: Winner) {
    const winners: Team | "lovers" =
      winner === "werewolves" ? "wolves" : winner === "villagers" ? "village" : winner;
    const now = Date.now();
    const results: GameResult[] = [];
    for (const [id, uid] of this.accounts) {
      const role = this.roles.get(id);
      if (!role) continue; // joined the lobby but never got a role
      const left = this.quitAlive.get(id);
      const minutes = Math.max(1, Math.floor(((left ?? now) - this.gameStartedAt) / 60_000));
      const team = this.teamOf(id);
      const won = left === undefined && (winners === "lovers" ? !!this.lovers?.includes(id) : team === winners);
      const p = this.state.players.get(id);
      const side = team === "wolves" ? "wolf" : team === "village" ? "village" : "solo";
      const result: GameResult = {
        uid, role, side, won, minutes, survived: p?.alive === true, name: p?.name ?? "?", avatar: p?.avatar ?? 0, frame: p?.frame ?? 0,
      };
      results.push(result);
      const { xp, coins } = rewardFor(result);
      this.logEvent("reward", { won, xp, coins, minutes }, id);
    }
    this.lastResults = results;
    recordResults(results).catch((e) => console.error("recording results failed", e));
  }

  private lastResults: GameResult[] = []; // for tests

  /** A night step's timer; the game's first one also covers the card deal animation. */
  private setStepTimer(onExpire: () => void) {
    this.setPhaseTimer(this.stepMs() + this.dealTime, onExpire);
    this.dealTime = 0;
  }

  /** The host's phase time (night steps, votes, the hunter's shot, the succession). */
  private stepMs() {
    return this.state.stepSeconds * 1000;
  }

  private setPhaseTimer(ms: number, onExpire: () => void) {
    this.phaseTimer?.clear();
    this.state.phaseEndsAt = Date.now() + ms;
    this.phaseTimer = this.clock.setTimeout(onExpire, ms);
  }
}

/**
 * Roles for [players] seats. Fewer players than planned: drop villagers, then specials (DROP_ORDER),
 * then plain wolves — always keeping at least one village role and one wolf or loner. More players
 * than planned: the extras are villagers.
 */
function buildDeck(c: Composition, players: number): Role[] {
  let { werewolf, villager } = c;
  let specials: Role[] = SPECIALS.flatMap((r) => (c[r] ? Array<Role>(cardsOf(r)).fill(r) : []));
  const evil = () => werewolf + specials.filter(isEvil).length;
  const good = () => villager + specials.filter((r) => !isEvil(r)).length;
  let extra = werewolf + villager + specials.length - players;
  for (; extra > 0 && villager > 0 && good() > 1; extra--) villager--;
  for (const r of DROP_ORDER) {
    const cards = specials.filter((s) => s === r).length; // (the two brothers leave together)
    if (extra <= 0 || cards === 0 || (isEvil(r) ? evil() : good()) <= cards) continue; // the last of its side stays
    specials = specials.filter((s) => s !== r);
    extra -= cards;
  }
  for (; extra > 0 && werewolf > 0 && evil() > 1; extra--) werewolf--;
  villager += Math.max(0, -extra);
  // The blue wolf hides behind a simple villager: with none dealt, he's a plain wolf.
  if (villager === 0 && specials.includes("bluewolf")) specials.splice(specials.indexOf("bluewolf"), 1, "werewolf");
  return [...Array<Role>(werewolf).fill("werewolf"), ...specials, ...Array<Role>(villager).fill("villager")];
}

/** Every target sharing the highest vote count (empty when nobody voted). */
function topCandidates(votes: Iterable<string>): string[] {
  const tally = new Map<string, number>();
  for (const v of votes) tally.set(v, (tally.get(v) ?? 0) + 1);
  const best = Math.max(0, ...tally.values());
  return [...tally].filter(([, count]) => count === best && best > 0).map(([target]) => target);
}

/** The single most-voted target, or null when nobody voted or the top is tied. */
function topVoted(votes: Iterable<string>): string | null {
  const top = topCandidates(votes);
  return top.length === 1 ? top[0] : null;
}

function shuffleCopy<T>(items: T[]): T[] {
  const copy = [...items];
  shuffle(copy);
  return copy;
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function shuffle<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

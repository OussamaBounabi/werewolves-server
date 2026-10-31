import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
  createMiddleware,
  matchMaker,
  WebSocketTransport,
} from "colyseus";

/**
 * Import your Room files
 */
import { WerewolfRoom } from "./rooms/WerewolfRoom.js";
import { RummyRoom } from "./rooms/RummyRoom.js";
import { DominoRoom } from "./rooms/DominoRoom.js";
import { BilliardRoom } from "./rooms/BilliardRoom.js";
import { ChessRoom } from "./rooms/ChessRoom.js";
import { LudoRoom } from "./rooms/LudoRoom.js";
import { GuessRoom, MysteryRoom } from "./rooms/GuessRoom.js";
import { ITEMS, MYSTERY_CATEGORIES } from "./mysteryItems.js";
import { ImposterRoom } from "./rooms/ImposterRoom.js";
import { MimicRoom } from "./rooms/MimicRoom.js";
import { ChessAnalysisRoom } from "./rooms/ChessAnalysisRoom.js";
import { ClanLoungeRoom } from "./rooms/ClanLoungeRoom.js";
import { kickFromApp, PresenceRoom } from "./rooms/PresenceRoom.js";
import { onlineCount, roomsOf, whereIs } from "./presence.js";
import { todayNow } from "./metrics.js";
import express from "express";
import { fileURLToPath } from "node:url";
import { catalog, legends, playerInfo } from "./guess.js";
import {
  adminAccounts, adminBan, adminBans, adminNotice, adminPlayer, adminReports, adminRole, adminStats, announce, AuthError, BanError, settings,
  type Staff,
  buyAvatar, buyCoins, buyFrame, claimAchievement, pushClanLine, setNotify, claimDaily, claimMission, ClaimError, currentPlans, exchangeToken, grantVip, isAdmin, PRO_KICKS, ProfileError, pushMessage, freeCoins, savePushToken, sendGift, spinWheel,
  savePlan, StoreError, supportReply, supportThread, supportThreads, updateProfile, VIP_DIAMONDS, type ProfileChanges,
} from "./accounts.js";
import { AVATARS, FRAMES, FREE_AVATARS } from "./avatars.js";
import {
  adminClan, adminClanAct, adminClanChat, adminClans, answerRequest, changeMember, chests, ClanError, createClan, editClan, inviteToClan,
  joinClan, leaveClan, pinClan, removeInactive, loungeOf, shareRoom,
} from "./clans.js";
import {
  adminItem, adminLog, adminReset, adminWallet, backupNow, cheatFlags, content, crashList, deleteCrash, economy, gameHistory, handleReport,
  health, logAction, playerExtra, publicConfig, pushSegment, recordCrash, reportPicture, reportQueue, restartSoon, retention, setStaff,
  staffList, versions, walletHistory, type Segment,
} from "./admin.js";
import { moderate, roomPeople } from "./rooms/moderate.js";
import { dayKey, MISSIONS, periodEnds, weekKey } from "./missions.js";
import { stakeLedger, stakePlan } from "./stakes.js";
import { SCRAPER } from "./scraper.js";
import {
  avatarPrice, cardPrice, cleanChests, cleanEvents, cleanMissionPlan, cleanScheduled, cleanSettings, cleanStakePlan, cleanStorePlan, cleanTiers,
  framePrice, missionsNow, ROLE_CARDS, SETTINGS, storeNow,
} from "./plans.js";

function roomInfo(r: { roomId: string; metadata?: any }) {
  return {
    roomId: r.roomId,
    host: r.metadata?.host ?? "",
    avatar: r.metadata?.hostAvatar ?? 0, // the host's, shown in the room lists
    frame: r.metadata?.hostFrame ?? 0,
    hostVip: r.metadata?.hostVip ?? "", // "vip" | "pro": his badge
    roomName: r.metadata?.roomName ?? "", // a VIP Pro host's name for his room…
    roomStyle: r.metadata?.roomStyle ?? "", // …and its card's style
    roomType: r.metadata?.roomType ?? "public",
    players: r.metadata?.players ?? 0,
    maxPlayers: r.metadata?.maxPlayers ?? 0,
    spectators: r.metadata?.spectators ?? 0,
    started: r.metadata?.started === true,
    mode: r.metadata?.mode ?? "", // guess who: duel | cup
    stake: r.metadata?.stake ?? 0, // coins each player puts in (0: free)
    chat: r.metadata?.chat === true, // a chat room: no voice
  };
}

/** A query parameter of a request. */
const param = (ctx: { request?: Request }, key: string) => new URL(ctx.request?.url ?? "http://x/").searchParams.get(key) ?? "";

const OWNER = true; // an endpoint for the owner alone

/** What a change in the admin app was made to (the log's target): a player, a room, a clan… */
const targetOf = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return String(b.uid ?? b.roomId ?? b.id ?? b.who ?? "");
};

/**
 * An endpoint of the admin app: its Firebase ID token (Authorization: Bearer) is the owner's or a moderator's
 * (accounts.adminRole); [owner]: the owner's alone. Every change (a POST) that worked is written to the log.
 */
function adminEndpoint(
  path: string,
  method: "GET" | "POST",
  run: (ctx: { body?: unknown; request?: Request }, staff: Staff) => Promise<unknown>,
  owner = false,
) {
  return createEndpoint(path, { method }, async (ctx) => {
    const staff = await adminRole(bearer(ctx));
    if (!staff) throw ctx.error(403, { error: "admins only" });
    if (owner && staff.role !== "owner") throw ctx.error(403, { error: "owner only" });
    try {
      const out = await run(ctx, staff);
      if (method === "POST") {
        logAction(staff, path.replace("/api/admin/", ""), targetOf(ctx.body), ctx.body).catch((e) => console.error("admin log failed", e));
      }
      return out;
    } catch (e) {
      throw ctx.error(400, { error: (e as Error).message });
    }
  });
}

/** An app's Firebase ID token, from "Authorization: Bearer <token>". */
const bearer = (ctx: { request?: Request }) => ctx.request?.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

/** The HTTP status for what went wrong with an account request: a bad token, a refusal, or our fault. */
function statusFor(e: unknown) {
  if (e instanceof AuthError) return 401;
  if (e instanceof ClanError) return 409;
  if (e instanceof ProfileError) return e.status;
  if (e instanceof StoreError || e instanceof ClaimError) return 409;
  console.error("account request failed", e);
  return 500;
}

async function publicRooms(name: string) {
  return (await matchMaker.query({ name }))
    .filter((r) => !r.private && !r.unlisted && (r.metadata?.roomType ?? "public") === "public")
    .map(roomInfo);
}

const server = defineServer({
  // A message up to 160 KB (Colyseus's default is 4 KB): Mystery Item's own pictures (100 KB, base64'd) come in one.
  transport: new WebSocketTransport({ maxPayload: 160 * 1024 }),

  /**
   * Define your room handlers:
   */
  rooms: {
    werewolf: defineRoom(WerewolfRoom),
    rummy: defineRoom(RummyRoom),
    domino: defineRoom(DominoRoom),
    billiard: defineRoom(BilliardRoom),
    chess: defineRoom(ChessRoom),
    ludo: defineRoom(LudoRoom),
    guess: defineRoom(GuessRoom),
    mystery: defineRoom(MysteryRoom),
    imposter: defineRoom(ImposterRoom),
    mimic: defineRoom(MimicRoom),
    presence: defineRoom(PresenceRoom), // every app, while open: who's online
    clan_lounge: defineRoom(ClanLoungeRoom).filterBy(["clan"]), // a clan's voice lounge, one per clan
    chess_analysis: defineRoom(ChessAnalysisRoom), // the analysis board after a chess game (private: joined by its id)
  },

  /**
   * Experimental: Define API routes. Built-in integration with the "playground" and SDK.
   *
   * Usage from SDK:
   *   client.http.get("/api/hello").then((response) => {})
   *
   */
  routes: createRouter({
    // The room list: public rooms only (friends/private rooms are reached by invite or through a friend).
    api_rooms: createEndpoint("/api/rooms", { method: "GET" }, async () => publicRooms("werewolf")),
    api_rummy_rooms: createEndpoint("/api/rummy/rooms", { method: "GET" }, async () => publicRooms("rummy")),
    api_domino_rooms: createEndpoint("/api/domino/rooms", { method: "GET" }, async () => publicRooms("domino")),
    api_billiard_rooms: createEndpoint("/api/billiard/rooms", { method: "GET" }, async () => publicRooms("billiard")),
    api_chess_rooms: createEndpoint("/api/chess/rooms", { method: "GET" }, async () => publicRooms("chess")),
    api_ludo_rooms: createEndpoint("/api/ludo/rooms", { method: "GET" }, async () => publicRooms("ludo")),
    api_guess_rooms: createEndpoint("/api/guess/rooms", { method: "GET" }, async () => publicRooms("guess")),
    api_mystery_rooms: createEndpoint("/api/mystery/rooms", { method: "GET" }, async () => publicRooms("mystery")),
    api_imposter_rooms: createEndpoint("/api/imposter/rooms", { method: "GET" }, async () => publicRooms("imposter")),
    api_mimic_rooms: createEndpoint("/api/mimic/rooms", { method: "GET" }, async () => publicRooms("mimic")),
    // The home: how many public rooms each game has now, and how many players are online.
    api_room_counts: createEndpoint("/api/room-counts", { method: "GET" }, async () => {
      const games = ["werewolf", "rummy", "domino", "ludo", "guess", "imposter", "mimic", "mystery", "billiard", "chess"];
      const rooms = Object.fromEntries(await Promise.all(games.map(async (g) => [g, (await publicRooms(g)).length])));
      return { ...rooms, online: onlineCount() }; // (and how many have the app open)
    }),
    // Round-trip check for the app's ping display.
    api_ping: createEndpoint("/api/ping", { method: "GET" }, async () => ({ t: Date.now() })),
    // Today's and this week's missions, and the current periods (the app reads progress from PocketBase).
    api_missions: createEndpoint("/api/missions", { method: "GET" }, async () => {
      const now = missionsNow(currentPlans().missions);
      return { missions: [...now.daily, ...now.weekly], dailyBonus: now.bonus, day: dayKey(), week: weekKey(), ends: periodEnds() };
    }),
    // The store this week (it changes on Monday): avatars, frames and role cards on sale and their prices, VIP Pro's own
    // avatars and frames, whether emojis are for VIPs only; VIP's diamonds a month and VIP Pro's kicks a month.
    api_store: createEndpoint("/api/store", { method: "GET" }, async () => ({
      ...storeNow(currentPlans().store),
      ends: periodEnds().week,
      vipDiamonds: VIP_DIAMONDS,
      proKicks: PRO_KICKS,
    })),
    // What each place of the weekly ranking wins (the ranking shows it): [{ from, to, coins, diamonds, vipDays }].
    api_rewards: createEndpoint("/api/rewards", { method: "GET" }, async () => ({ tiers: currentPlans().rewards ?? [] })),
    // Who's in a clan's voice lounge now: { talking: [{ name, avatar }], listeners }.
    api_clan_lounge: createEndpoint("/api/clans/lounge/:clan", { method: "GET" }, async (ctx) =>
      loungeOf(String((ctx.params as { clan?: string }).clan ?? ""))),
    // The clan ranking's prizes (each member who played) and the weekly chest's: { tiers, chests }.
    // Mystery Item's own images: the script the apps run in Google Images to find the thumbnails.
    api_mystery_scraper: createEndpoint("/api/mystery/scraper", { method: "GET" }, async () => ({ script: SCRAPER })),
    // Playing for coins: the stakes a host may pick, each from a player level, and the house's cut (%).
    api_stakes: createEndpoint("/api/stakes", { method: "GET" }, async () => stakePlan()),
    api_clan_rewards: createEndpoint("/api/clan-rewards", { method: "GET" }, async () => ({
      tiers: currentPlans().clanrewards ?? [],
      chests: chests(),
    })),
    // Claim a mission's reward: Authorization: Bearer <Firebase ID token>, body { id }.
    api_claim: createEndpoint("/api/missions/claim", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx);
      const id = (ctx.body as { id?: string } | undefined)?.id;
      if (!token || !id) throw ctx.error(400, { error: "missing token or id" });
      try {
        return { ok: true, reward: await claimMission(token, id) };
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // Clans (Authorization: Bearer <ID token>; src/clans.ts says what each one does and refuses).
    ...Object.fromEntries(
      (
        [
          ["create", (t, b) => createClan(t, b.look)],
          ["edit", (t, b) => editClan(t, b.look)],
          ["join", (t, b) => joinClan(t, String(b.clan ?? ""))],
          ["leave", (t) => leaveClan(t)],
          ["answer", (t, b) => answerRequest(t, String(b.user ?? ""), b.accept === true)],
          ["member", (t, b) => changeMember(t, String(b.user ?? ""), String(b.action ?? ""))],
          ["inactive", (t) => removeInactive(t)],
          ["invite", (t, b) => inviteToClan(t, String(b.user ?? ""))],
          ["pin", (t, b) => pinClan(t, b.text)],
          ["room", (t, b) => shareRoom(t, b.roomId, b.game)],
          ["line", (t, b) => pushClanLine(t, String(b.id ?? ""))], // a line just written: to the others' phones
          ["notify", (t, b) => setNotify(t, b)], // my clan notifications on or off
        ] as [string, (token: string, body: Record<string, unknown>) => Promise<unknown>][]
      ).map(([name, run]) => [
        `api_clan_${name}`,
        createEndpoint(`/api/clans/${name}`, { method: "POST" }, async (ctx) => {
          const token = bearer(ctx);
          if (!token) throw ctx.error(400, { error: "missing token" });
          try {
            return (await run(token, (ctx.body ?? {}) as Record<string, unknown>)) as Record<string, unknown>;
          } catch (e) {
            throw ctx.error(statusFor(e), { error: (e as Error).message });
          }
        }),
      ]),
    ),
    // An achievement's prize (Authorization: Bearer <ID token>, body { id }): { coins, diamonds }.
    api_achievement_claim: createEndpoint("/api/achievements/claim", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx), id = (ctx.body as { id?: unknown } | undefined)?.id;
      if (!token || typeof id !== "string") throw ctx.error(400, { error: "missing token or id" });
      try {
        return await claimAchievement(token, id);
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // Today's daily reward (Authorization: Bearer <ID token>): { day, at, streak, coins, diamonds }.
    api_daily_claim: createEndpoint("/api/daily/claim", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx);
      if (!token) throw ctx.error(400, { error: "missing token" });
      try {
        return await claimDaily(token);
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // A turn of the lucky wheel (Authorization: Bearer <ID token>): { index, prize, paid }.
    api_wheel_spin: createEndpoint("/api/wheel/spin", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx);
      if (!token) throw ctx.error(400, { error: "missing token" });
      try {
        return await spinWheel(token);
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // A coin pack for diamonds (Authorization: Bearer <ID token>, body { pack }: its place in the list).
    api_coins_buy: createEndpoint("/api/coins/buy", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx), pack = Number((ctx.body as { pack?: unknown } | undefined)?.pack);
      if (!token || !Number.isInteger(pack)) throw ctx.error(400, { error: "missing token or pack" });
      try {
        return await buyCoins(token, pack);
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // The store's free coins of the day (Authorization: Bearer <ID token>).
    api_coins_free: createEndpoint("/api/coins/free", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx);
      if (!token) throw ctx.error(400, { error: "missing token" });
      try {
        return await freeCoins(token);
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // A gift to a friend (Authorization: Bearer <ID token>, body { to, kind: "avatar" | "frame", id, note }).
    api_gift: createEndpoint("/api/gift", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx);
      const { to, kind, id, note } = (ctx.body ?? {}) as { to?: unknown; kind?: unknown; id?: unknown; note?: unknown };
      if (!token || typeof to !== "string" || (kind !== "avatar" && kind !== "frame") || !Number.isInteger(id)) {
        throw ctx.error(400, { error: "missing token, friend or item" });
      }
      try {
        return await sendGift(token, to, kind, id as number, typeof note === "string" ? note : "");
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // Buy an avatar (Authorization: Bearer <ID token>, body { id }): the server takes the price and the player wears it.
    api_avatar_buy: createEndpoint("/api/avatars/buy", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx);
      const id = Number((ctx.body as { id?: unknown } | undefined)?.id);
      if (!token || !Number.isInteger(id)) throw ctx.error(400, { error: "missing token or id" });
      try {
        return await buyAvatar(token, id);
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // Buy an animated frame (Authorization: Bearer <ID token>, body { id }): price taken, the frame worn.
    api_frame_buy: createEndpoint("/api/frames/buy", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx);
      const id = Number((ctx.body as { id?: unknown } | undefined)?.id);
      if (!token || !Number.isInteger(id)) throw ctx.error(400, { error: "missing token or id" });
      try {
        return await buyFrame(token, id);
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // Notifications: his phone's token (Authorization: Bearer <ID token>, body { token }).
    api_push_token: createEndpoint("/api/push/token", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx), push = (ctx.body as { token?: unknown } | undefined)?.token;
      if (!token || typeof push !== "string" || !push || push.length > 400) throw ctx.error(400, { error: "missing token" });
      try {
        await savePushToken(token, push);
        return { ok: true };
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // A message he just saved, pushed to his friend's phones (Authorization: Bearer <ID token>, body { id }).
    api_push_message: createEndpoint("/api/push/message", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx), id = (ctx.body as { id?: unknown } | undefined)?.id;
      if (!token || typeof id !== "string" || !id) throw ctx.error(400, { error: "missing token or id" });
      try {
        await pushMessage(token, id);
        return { ok: true };
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // His own profile (Authorization: Bearer <ID token>, body { name?, avatar?, frame?, username? }): the name once
    // a day, owned or free avatars and frames, a username only if he has none. Answers the profile as it is now.
    api_profile: createEndpoint("/api/profile", { method: "POST" }, async (ctx) => {
      const token = bearer(ctx);
      if (!token) throw ctx.error(400, { error: "missing token" });
      try {
        return await updateProfile(token, (ctx.body ?? {}) as ProfileChanges);
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // The app's Firebase ID token (body { idToken }) for a PocketBase token of the same player, to read and
    // write the database directly: { token, expires (epoch ms), record }. His account is made at his first one.
    api_auth_exchange: createEndpoint("/api/auth/exchange", { method: "POST" }, async (ctx) => {
      const idToken = (ctx.body as { idToken?: unknown } | undefined)?.idToken;
      if (typeof idToken !== "string" || !idToken) throw ctx.error(400, { error: "missing idToken" });
      try {
        const { version, device, lang } = ctx.body as { version?: unknown; device?: unknown; lang?: unknown };
        return await exchangeToken(idToken, version, device, lang);
      } catch (e) {
        // A ban says until when and why (year 9999: for good), and whether it's his phone's.
        if (e instanceof BanError) throw ctx.error(403, { error: "banned", until: e.until, reason: e.reason, phone: e.phone });
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // ---- the admin app (Authorization: Bearer <the admin's Firebase ID token>) ----
    // Who is asking: the owner or a moderator. The owner alone has the economy, the store, the plans, the settings,
    // the staff and the log.
    api_admin_me: adminEndpoint("/api/admin/me", "GET", async (_ctx, staff) => ({ role: staff.role, email: staff.email })),
    // A message from support to every player, body { ar, en, fr } (at least one).
    api_admin_announce: adminEndpoint("/api/admin/announce", "POST", async (ctx) => {
      const sent = await announce((ctx.body ?? {}) as { ar?: unknown; en?: unknown; fr?: unknown });
      return { id: sent.id };
    }, OWNER),
    // Every room of a game (?game=, werewolf by default), private ones included.
    api_admin_rooms: adminEndpoint("/api/admin/rooms", "GET", async (ctx) => {
      const game = param(ctx, "game") || "werewolf";
      const rooms = (await matchMaker.query({ name: game })).map((r) => ({
        ...roomInfo(r),
        phase: r.metadata?.phase ?? "",
        day: r.metadata?.day ?? 0,
        clients: r.clients,
      }));
      return { rooms };
    }),
    // One room's people (?roomId=) and its chat; support's action there (body { roomId, action: close | kick | mute |
    // unmute | say, uid, text }).
    api_admin_room: adminEndpoint("/api/admin/room", "GET", async (ctx) => roomPeople(param(ctx, "roomId"))),
    api_admin_room_act: adminEndpoint("/api/admin/room/act", "POST", async (ctx) => {
      const { roomId, action, uid, text } = (ctx.body ?? {}) as Record<string, unknown>;
      await moderate(String(roomId ?? ""), String(action ?? ""), String(uid ?? ""), String(text ?? ""));
      return { ok: true };
    }),
    // Finished games, newest first: one game's (?game=), one player's (?uid=), ?page=.
    api_admin_history: adminEndpoint("/api/admin/history", "GET", async (ctx) =>
      gameHistory(param(ctx, "game"), param(ctx, "uid"), Number(param(ctx, "page")) || 1)),
    // The home: the accounts, the last 30 days, and now (online, each game's rooms and players; today's online count
    // every ten minutes).
    api_admin_stats: adminEndpoint("/api/admin/stats", "GET", async () => {
      const stats = await adminStats();
      const today = todayNow();
      const last = stats.days.at(-1);
      if (last?.day === today.day) Object.assign(last, { games: today.games, active: today.active, peak: today.peak });
      const now: Record<string, { rooms: number; players: number; spectators: number }> = {};
      for (const r of await matchMaker.query({})) {
        if (r.name === "presence") continue;
        const game = (now[r.name] ??= { rooms: 0, players: 0, spectators: 0 });
        game.rooms++;
        game.players += Number(r.metadata?.players) || 0;
        game.spectators += Number(r.metadata?.spectators) || 0;
      }
      return { ...stats, online: onlineCount(), onlineToday: today.online, now };
    }),
    api_admin_retention: adminEndpoint("/api/admin/retention", "GET", () => retention()),
    api_admin_versions: adminEndpoint("/api/admin/versions", "GET", () => versions()),
    api_admin_health: adminEndpoint("/api/admin/health", "GET", () => health(), OWNER),
    api_admin_backup: adminEndpoint("/api/admin/backup", "POST", () => backupNow(), OWNER),
    // The server restarts in a minute, everyone told (only once RESTART_BUTTON=1 says systemd starts it again).
    api_admin_restart: adminEndpoint("/api/admin/restart", "POST", () => restartSoon(), OWNER),
    api_admin_crashes: adminEndpoint("/api/admin/crashes", "GET", (ctx) => crashList(Number(param(ctx, "page")) || 1), OWNER),
    api_admin_crash_delete: adminEndpoint("/api/admin/crash/delete", "POST", async (ctx) => {
      await deleteCrash(String((ctx.body as { id?: unknown } | undefined)?.id ?? ""));
      return { ok: true };
    }, OWNER),
    // The accounts, newest first (?q= searches the names, ?page=), each with where he is now.
    api_admin_accounts: adminEndpoint("/api/admin/accounts", "GET", async (ctx) => {
      const list = await adminAccounts(param(ctx, "q"), Number(param(ctx, "page")) || 1);
      return { ...list, items: list.items.map((u) => ({ ...u, where: whereIs(u.uid).state })) };
    }),
    // Support: the reported players (most reported first), the reports one by one (?handled=1: those dealt with), a
    // reported picture, one player (?uid=), who is banned, support's conversations and one of them (?uid=); a message
    // or a warning to a player (body { uid, kind, text }), a ban (body { uid, days: -1 for good, 0 lifts, reason,
    // phone }), an answer (body { uid, text }), an offensive name or avatar reset (body { uid, what }).
    api_admin_reports: adminEndpoint("/api/admin/reports", "GET", async () => ({ players: await adminReports() })),
    api_admin_report_queue: adminEndpoint("/api/admin/report-queue", "GET", (ctx) =>
      reportQueue(param(ctx, "handled") === "1", Number(param(ctx, "page")) || 1)),
    api_admin_report_handle: adminEndpoint("/api/admin/report/handle", "POST", async (ctx) => {
      const { id, handled } = (ctx.body ?? {}) as { id?: unknown; handled?: unknown };
      await handleReport(String(id ?? ""), handled !== false);
      return { ok: true };
    }),
    api_admin_report_picture: adminEndpoint("/api/admin/report-picture", "GET", async (ctx) => {
      const { type, body } = await reportPicture(param(ctx, "id"));
      return { type, data: body.toString("base64") };
    }),
    api_admin_flags: adminEndpoint("/api/admin/flags", "GET", () => cheatFlags()),
    api_admin_player: adminEndpoint("/api/admin/player", "GET", async (ctx) => {
      const uid = param(ctx, "uid");
      return { ...(await adminPlayer(uid)), ...(await playerExtra(uid)), where: whereIs(uid).state };
    }),
    api_admin_wallet_log: adminEndpoint("/api/admin/wallet-log", "GET", (ctx) => walletHistory(param(ctx, "uid"), Number(param(ctx, "page")) || 1)),
    api_admin_wallet: adminEndpoint("/api/admin/wallet", "POST", async (ctx) => {
      const { uid, coins, diamonds, reason } = (ctx.body ?? {}) as Record<string, unknown>;
      return adminWallet(String(uid ?? ""), Number(coins) || 0, Number(diamonds) || 0, String(reason ?? ""));
    }, OWNER),
    api_admin_item: adminEndpoint("/api/admin/item", "POST", async (ctx) => {
      const { uid, kind, id, give } = (ctx.body ?? {}) as Record<string, unknown>;
      return adminItem(String(uid ?? ""), kind, Number(id), give !== false);
    }, OWNER),
    api_admin_reset: adminEndpoint("/api/admin/reset", "POST", async (ctx) => {
      const { uid, what } = (ctx.body ?? {}) as Record<string, unknown>;
      return adminReset(String(uid ?? ""), what);
    }),
    api_admin_economy: adminEndpoint("/api/admin/economy", "GET", (ctx) => economy(Math.min(90, Number(param(ctx, "days")) || 7)), OWNER),
    api_admin_bans: adminEndpoint("/api/admin/bans", "GET", () => adminBans()),
    api_admin_support: adminEndpoint("/api/admin/support", "GET", async () => ({ threads: await supportThreads() })),
    api_admin_thread: adminEndpoint("/api/admin/support/thread", "GET", (ctx) => supportThread(param(ctx, "uid"))),
    api_admin_notice: adminEndpoint("/api/admin/notice", "POST", async (ctx) => {
      const { uid, kind, text } = (ctx.body ?? {}) as { uid?: unknown; kind?: unknown; text?: unknown };
      await adminNotice(String(uid), kind, text);
      return { ok: true };
    }),
    api_admin_ban: adminEndpoint("/api/admin/ban", "POST", async (ctx) => {
      const { uid, days, reason, phone } = (ctx.body ?? {}) as { uid?: unknown; days?: unknown; reason?: unknown; phone?: unknown };
      const done = await adminBan(String(uid), Number(days), reason, phone === true);
      if (Number(days) !== 0) {
        kickFromApp(String(uid)); // out now: his app finds the ban as it reconnects…
        for (const roomId of roomsOf(String(uid))) { // …and out of the rooms he's in ("removed by support")
          (matchMaker.getLocalRoomById(roomId) as unknown as { removeBanned?: (uid: string) => void } | undefined)?.removeBanned?.(String(uid));
        }
      }
      return done;
    }),
    api_admin_reply: adminEndpoint("/api/admin/support/reply", "POST", async (ctx) => {
      const { uid, text } = (ctx.body ?? {}) as { uid?: unknown; text?: unknown };
      await supportReply(String(uid), text);
      return { ok: true };
    }),
    // Clans: the list (?q=, ?sort= xp | members | week | new, ?page=), one clan (?id=), its chat (?id=, ?before=);
    // support's action on one (body { id, action, … }: see adminClanAct).
    api_admin_clans: adminEndpoint("/api/admin/clans", "GET", (ctx) => adminClans(param(ctx, "q"), param(ctx, "sort"), Number(param(ctx, "page")) || 1)),
    api_admin_clan: adminEndpoint("/api/admin/clan", "GET", (ctx) => adminClan(param(ctx, "id"))),
    api_admin_clan_chat: adminEndpoint("/api/admin/clan/chat", "GET", (ctx) => adminClanChat(param(ctx, "id"), param(ctx, "before"))),
    api_admin_clan_act: adminEndpoint("/api/admin/clan/act", "POST", async (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      return adminClanAct(String(body.id ?? ""), String(body.action ?? ""), body);
    }),
    // The owner's: the staff (body { who: a username or e-mail / a moderator's uid, add }), the log (?page=, ?target=),
    // the settings (body { settings: the sections to change, null puts one back }), the events, the scheduled
    // announcements, a notification to some players (body { segment, title, body, send: false only counts them}), the
    // games' content.
    api_admin_staff: adminEndpoint("/api/admin/staff", "GET", async () => ({ staff: staffList() }), OWNER),
    api_admin_staff_set: adminEndpoint("/api/admin/staff/set", "POST", async (ctx) => {
      const { who, add } = (ctx.body ?? {}) as { who?: unknown; add?: unknown };
      return { staff: await setStaff(String(who ?? "").trim(), add !== false) };
    }, OWNER),
    api_admin_log: adminEndpoint("/api/admin/log", "GET", (ctx) => adminLog(Number(param(ctx, "page")) || 1, param(ctx, "target")), OWNER),
    api_admin_settings: adminEndpoint("/api/admin/settings", "GET", async () => ({
      settings: settings(), saved: currentPlans().settings ?? {}, defaults: SETTINGS,
      avatars: Object.keys(AVATARS).map(Number).filter((id) => !FREE_AVATARS.includes(id)), frames: Object.keys(FRAMES).map(Number),
    }), OWNER),
    api_admin_settings_save: adminEndpoint("/api/admin/settings/save", "POST", async (ctx) => {
      const saved = cleanSettings((ctx.body as { settings?: unknown } | undefined)?.settings, currentPlans().settings);
      await savePlan("settings", saved);
      return { settings: settings(), saved };
    }, OWNER),
    api_admin_events: adminEndpoint("/api/admin/events", "GET", async () => ({ events: currentPlans().events ?? [], now: new Date().toISOString() }), OWNER),
    api_admin_events_save: adminEndpoint("/api/admin/events/save", "POST", async (ctx) => {
      const events = cleanEvents((ctx.body as { events?: unknown } | undefined)?.events);
      await savePlan("events", events);
      return { events };
    }, OWNER),
    api_admin_scheduled: adminEndpoint("/api/admin/scheduled", "GET", async () => ({ scheduled: currentPlans().scheduled ?? [] }), OWNER),
    api_admin_scheduled_save: adminEndpoint("/api/admin/scheduled/save", "POST", async (ctx) => {
      const scheduled = cleanScheduled((ctx.body as { scheduled?: unknown } | undefined)?.scheduled, currentPlans().scheduled);
      await savePlan("scheduled", scheduled);
      return { scheduled };
    }, OWNER),
    api_admin_push: adminEndpoint("/api/admin/push", "POST", async (ctx) => {
      const { segment, title, body, send } = (ctx.body ?? {}) as Record<string, unknown>;
      return pushSegment((segment ?? {}) as Segment, String(title ?? ""), String(body ?? ""), send === true);
    }, OWNER),
    api_admin_content: adminEndpoint("/api/admin/content", "GET", async () => content(), OWNER),
    // Store and Missions: each plan as saved (null: none yet) with what's live now and the defaults; saved back whole
    // to …/save (body { plan } / { tiers }), checked first. VIP for a player: body { uid, level: "vip" | "pro" | "off",
    // days: null for good }.
    api_admin_store: adminEndpoint("/api/admin/store", "GET", async () => {
      const plan = currentPlans().store;
      const avatars = Object.keys(AVATARS).map(Number).filter((id) => !FREE_AVATARS.includes(id));
      return {
        plan,
        now: storeNow(plan),
        defaults: {
          avatars: Object.fromEntries(avatars.map((id) => [id, avatarPrice(null, id)])),
          frames: Object.fromEntries(Object.keys(FRAMES).map(Number).map((id) => [id, framePrice(null, id)])),
          cards: Object.fromEntries(Object.keys(ROLE_CARDS).map((role) => [role, cardPrice(null, role)])),
        },
      };
    }, OWNER),
    api_admin_store_save: adminEndpoint("/api/admin/store/save", "POST", async (ctx) => {
      const plan = cleanStorePlan((ctx.body as { plan?: unknown } | undefined)?.plan);
      await savePlan("store", plan);
      return { plan, now: storeNow(plan) };
    }, OWNER),
    api_admin_missions: adminEndpoint("/api/admin/missions", "GET", async () => {
      const plan = currentPlans().missions;
      const now = missionsNow(plan);
      return {
        plan,
        day: dayKey(),
        week: weekKey(),
        dayIndex: now.dayIndex,
        weekIndex: now.weekIndex,
        defaults: { daily: MISSIONS.filter((m) => m.period === "daily"), weekly: MISSIONS.filter((m) => m.period === "weekly"), bonus: missionsNow(null).bonus },
      };
    }, OWNER),
    api_admin_missions_save: adminEndpoint("/api/admin/missions/save", "POST", async (ctx) => {
      const plan = cleanMissionPlan((ctx.body as { plan?: unknown } | undefined)?.plan);
      await savePlan("missions", plan);
      const now = missionsNow(plan);
      return { plan, dayIndex: now.dayIndex, weekIndex: now.weekIndex };
    }, OWNER),
    api_admin_rewards: adminEndpoint("/api/admin/rewards", "GET", async () => ({ tiers: currentPlans().rewards ?? [] }), OWNER),
    api_admin_clan_rewards: adminEndpoint("/api/admin/clan-rewards", "GET", async () => ({
      tiers: currentPlans().clanrewards ?? [],
      chests: chests(),
    }), OWNER),
    // The weekly clan chest's goals (a 20-seat clan's) and prizes: { chests: [{ goal, coins, diamonds }] × 3 }.
    // Playing for coins: the plan (the house's cut, the levels) and the last staked games, with what the house kept.
    api_admin_stakes: adminEndpoint("/api/admin/stakes", "GET", async () => ({ plan: stakePlan(), ...(await stakeLedger()) }), OWNER),
    api_admin_stakes_save: adminEndpoint("/api/admin/stakes/save", "POST", async (ctx) => {
      const plan = cleanStakePlan((ctx.body as { plan?: unknown } | undefined)?.plan);
      await savePlan("stakes", plan);
      return { plan };
    }, OWNER),
    api_admin_clan_chests_save: adminEndpoint("/api/admin/clan-chests/save", "POST", async (ctx) => {
      const list = cleanChests((ctx.body as { chests?: unknown } | undefined)?.chests);
      await savePlan("chests", list);
      return { chests: list };
    }, OWNER),
    api_admin_clan_rewards_save: adminEndpoint("/api/admin/clan-rewards/save", "POST", async (ctx) => {
      const tiers = cleanTiers((ctx.body as { tiers?: unknown } | undefined)?.tiers);
      await savePlan("clanrewards", tiers);
      return { tiers };
    }, OWNER),
    api_admin_rewards_save: adminEndpoint("/api/admin/rewards/save", "POST", async (ctx) => {
      const tiers = cleanTiers((ctx.body as { tiers?: unknown } | undefined)?.tiers);
      await savePlan("rewards", tiers);
      return { tiers };
    }, OWNER),
    api_admin_vip: adminEndpoint("/api/admin/vip", "POST", async (ctx) => {
      const { uid, level, days } = (ctx.body ?? {}) as { uid?: unknown; level?: unknown; days?: unknown };
      if (level !== "vip" && level !== "pro" && level !== "off") throw new Error("level");
      const user = await grantVip(String(uid), level, days === null || days === undefined ? null : Number(days));
      return { vip: user.vip === true, vipPro: user.vipPro === true, vipUntil: user.vipUntil ?? "", vipProUntil: user.vipProUntil ?? "" };
    }, OWNER),
    // What the apps read at start and now and then: the owner's switches, daily reward, wheel, clan prices, oldest
    // build allowed, bad words, bots, and the events on now.
    api_config: createEndpoint("/api/config", { method: "GET" }, async () => publicConfig()),
    // An app's error, counted for the admin app (body { message, stack, version, uid }).
    api_crash: createEndpoint("/api/crash", { method: "POST" }, async (ctx) => {
      const ip = ctx.request?.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
      await recordCrash(ip, (ctx.body ?? {}) as Record<string, unknown>).catch((e) => console.error("crash report failed", e));
      return { ok: true };
    }),
    // One room by id, whatever its type (invites, joining a friend): { found: false } when it's gone.
    api_room: createEndpoint("/api/rooms/:roomId", { method: "GET" }, async (ctx) => {
      const [room] = await matchMaker.query({ roomId: ctx.params.roomId });
      return room ? { found: true, game: room.name, ...roomInfo(room) } : { found: false };
    }),
  }),

  /**
   * Bind your custom express routes here:
   * Read more: https://expressjs.com/en/starter/basic-routing.html
   */
  express: (app) => {

    // Guess Who's footballers, clubs, leagues and nations, and their portraits (/guess/img/<id>.webp). Through
    // express: the router above never ends a response this big (80 KB) — clients wait forever.
    app.get("/api/guess/catalog", (_req, res) => {
      res.json(catalog);
    });
    // Mystery Item's categories and things (photo: its picture is at /guess/img/<id>.webp; a country shows its flag).
    app.get("/api/mystery/items", (_req, res) => {
      res.json({ categories: MYSTERY_CATEGORIES, items: ITEMS });
    });
    // The legends (trust mode): names, levels, careers and trophies for the info sheet. Fetched only when played.
    app.get("/api/guess/legends", (_req, res) => {
      res.json({ legends });
    });
    // The easy level's footballers' info sheets (trust mode): {version, players: {id: details}}.
    app.get("/api/guess/player-info", (_req, res) => {
      res.json(playerInfo);
    });
    // Mimic Party's takes: a player sends his (?room&session&token&round&score, a WAV), everyone hears them.
    app.post("/api/mimic/clip", express.raw({ type: "*/*", limit: "450kb" }), (req, res) => {
      const room = matchMaker.getLocalRoomById(String(req.query.room ?? ""));
      const q = (k: string) => String(req.query[k] ?? "");
      const ok =
        room instanceof MimicRoom && Buffer.isBuffer(req.body) &&
        room.addTake(q("session"), q("token"), Number(q("round")), Number(q("score")), req.body);
      res.status(ok ? 200 : 403).json({ ok });
    });
    app.get("/api/mimic/clip/:room/:round/:session", (req, res) => {
      const room = matchMaker.getLocalRoomById(req.params.room);
      const wav = room instanceof MimicRoom ? room.clip(Number(req.params.round), req.params.session.replace(/\.wav$/, "")) : undefined;
      if (!wav) return void res.status(404).end();
      res.type("audio/wav").send(wav);
    });
    app.use("/guess/img", express.static(fileURLToPath(new URL("../data/guess/img", import.meta.url)), { maxAge: "7d" }));
    // the legends' portraits at the same address: the app shows any face from /guess/img/<id>.webp
    app.use("/guess/img", express.static(fileURLToPath(new URL("../data/guess/legends", import.meta.url)), { maxAge: "7d" }));
    app.use("/guess/img", express.static(fileURLToPath(new URL("../data/mystery/img", import.meta.url)), { maxAge: "7d" })); // Mystery Item's

    app.get("/hi", (req, res) => {
      res.send("It's time to kick ass and chew bubblegum!");
    });

    /**
     * Use @colyseus/monitor
     * If you expose it in production, make sure to protect it with a password:
     * https://docs.colyseus.io/tools/monitoring#password-protection
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
    }

    /**
     * Use @colyseus/playground
     * In production, only through an SSH tunnel to the server — `ssh -L 2580:127.0.0.1:2567 <server>`, then
     * http://localhost:2580/playground/ — since everything from the internet comes through the HTTPS proxy,
     * which adds X-Forwarded-For (and the game port itself is firewalled).
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/", playground());
    } else {
      const tunnelOnly = createMiddleware(async (ctx) => {
        if (ctx.getHeader("x-forwarded-for")) throw ctx.error(404, { message: "Not found" });
      });
      app.use("/playground", playground({ use: [tunnelOnly] }));
    }
  }
});

export default server;


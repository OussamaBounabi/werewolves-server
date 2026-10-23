import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
  createMiddleware,
  matchMaker,
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
import { kickFromApp, PresenceRoom } from "./rooms/PresenceRoom.js";
import { onlineCount, roomsOf, whereIs } from "./presence.js";
import { todayNow } from "./metrics.js";
import express from "express";
import { fileURLToPath } from "node:url";
import { catalog, legends, playerInfo } from "./guess.js";
import {
  adminAccounts, adminBan, adminBans, adminNotice, adminPlayer, adminReports, adminStats, announce, AuthError, BanError,
  buyAvatar, buyFrame, claimMission, ClaimError, currentPlans, exchangeToken, grantVip, isAdmin, PRO_KICKS, ProfileError, pushMessage, savePushToken,
  savePlan, StoreError, supportReply, supportThread, supportThreads, updateProfile, VIP_DIAMONDS, type ProfileChanges,
} from "./accounts.js";
import { AVATARS, FRAMES, FREE_AVATARS } from "./avatars.js";
import { dayKey, MISSIONS, periodEnds, weekKey } from "./missions.js";
import {
  avatarPrice, cardPrice, cleanMissionPlan, cleanStorePlan, cleanTiers, framePrice, missionsNow, ROLE_CARDS, storeNow,
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
  };
}

/** A query parameter of a request. */
const param = (ctx: { request?: Request }, key: string) => new URL(ctx.request?.url ?? "http://x/").searchParams.get(key) ?? "";

/** An endpoint of the admin app: its Firebase ID token (Authorization: Bearer) is one of ADMIN_EMAILS'. */
function adminEndpoint(path: string, method: "GET" | "POST", run: (ctx: { body?: unknown; request?: Request }) => Promise<unknown>) {
  return createEndpoint(path, { method }, async (ctx) => {
    if (!(await isAdmin(bearer(ctx)))) throw ctx.error(403, { error: "admins only" });
    try {
      return await run(ctx);
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
        const { version, device } = ctx.body as { version?: unknown; device?: unknown };
        return await exchangeToken(idToken, version, device);
      } catch (e) {
        // A ban says until when and why (year 9999: for good), and whether it's his phone's.
        if (e instanceof BanError) throw ctx.error(403, { error: "banned", until: e.until, reason: e.reason, phone: e.phone });
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // Admins only: a message from support to every player, body { ar, en, fr } (at least one).
    api_admin_announce: createEndpoint("/api/admin/announce", { method: "POST" }, async (ctx) => {
      if (!(await isAdmin(bearer(ctx)))) throw ctx.error(403, { error: "admins only" });
      try {
        const sent = await announce((ctx.body ?? {}) as { ar?: unknown; en?: unknown; fr?: unknown });
        return { id: sent.id };
      } catch (e) {
        throw ctx.error(400, { error: (e as Error).message });
      }
    }),
    // Admins only (Authorization: Bearer <ID token>): every room of a game (?game=, werewolf by default), private ones
    // included.
    api_admin_rooms: createEndpoint("/api/admin/rooms", { method: "GET" }, async (ctx) => {
      if (!(await isAdmin(bearer(ctx)))) throw ctx.error(403, { error: "admins only" });
      const game = new URL(ctx.request?.url ?? "http://x/").searchParams.get("game") || "werewolf";
      const rooms = (await matchMaker.query({ name: game })).map((r) => ({
        ...roomInfo(r),
        phase: r.metadata?.phase ?? "",
        day: r.metadata?.day ?? 0,
      }));
      return { rooms };
    }),
    // Admins only: the admin app's home — the accounts, the last 30 days, and now (online, each game's rooms and
    // players; today's online count every ten minutes).
    api_admin_stats: createEndpoint("/api/admin/stats", { method: "GET" }, async (ctx) => {
      if (!(await isAdmin(bearer(ctx)))) throw ctx.error(403, { error: "admins only" });
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
    // Admins only: the accounts, newest first (?q= searches the names, ?page=), each with where he is now.
    api_admin_accounts: createEndpoint("/api/admin/accounts", { method: "GET" }, async (ctx) => {
      if (!(await isAdmin(bearer(ctx)))) throw ctx.error(403, { error: "admins only" });
      const url = new URL(ctx.request?.url ?? "http://x/");
      const list = await adminAccounts(url.searchParams.get("q") ?? "", Number(url.searchParams.get("page")) || 1);
      return { ...list, items: list.items.map((u) => ({ ...u, where: whereIs(u.uid).state })) };
    }),
    // Admins only, for the admin app's Support: the reported players (most reported first), one player (?uid=),
    // who is banned, support's conversations and one of them (?uid=); a message or a warning to a player (body
    // { uid, kind, text }), a ban (body { uid, days: -1 for good, 0 lifts, reason, phone }), an answer (body { uid, text }).
    api_admin_reports: adminEndpoint("/api/admin/reports", "GET", async () => ({ players: await adminReports() })),
    api_admin_player: adminEndpoint("/api/admin/player", "GET", async (ctx) => {
      const uid = param(ctx, "uid");
      return { ...(await adminPlayer(uid)), where: whereIs(uid).state };
    }),
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
    // Admins only, for the admin app's Store and Missions: each plan as saved (null: none yet) with what's live now and
    // the defaults; saved back whole to …/save (body { plan } / { tiers }), checked first. VIP for a player: body { uid, level:
    // "vip" | "pro" | "off", days: null for good }.
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
    }),
    api_admin_store_save: adminEndpoint("/api/admin/store/save", "POST", async (ctx) => {
      const plan = cleanStorePlan((ctx.body as { plan?: unknown } | undefined)?.plan);
      await savePlan("store", plan);
      return { plan, now: storeNow(plan) };
    }),
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
    }),
    api_admin_missions_save: adminEndpoint("/api/admin/missions/save", "POST", async (ctx) => {
      const plan = cleanMissionPlan((ctx.body as { plan?: unknown } | undefined)?.plan);
      await savePlan("missions", plan);
      const now = missionsNow(plan);
      return { plan, dayIndex: now.dayIndex, weekIndex: now.weekIndex };
    }),
    api_admin_rewards: adminEndpoint("/api/admin/rewards", "GET", async () => ({ tiers: currentPlans().rewards ?? [] })),
    api_admin_rewards_save: adminEndpoint("/api/admin/rewards/save", "POST", async (ctx) => {
      const tiers = cleanTiers((ctx.body as { tiers?: unknown } | undefined)?.tiers);
      await savePlan("rewards", tiers);
      return { tiers };
    }),
    api_admin_vip: adminEndpoint("/api/admin/vip", "POST", async (ctx) => {
      const { uid, level, days } = (ctx.body ?? {}) as { uid?: unknown; level?: unknown; days?: unknown };
      if (level !== "vip" && level !== "pro" && level !== "off") throw new Error("level");
      const user = await grantVip(String(uid), level, days === null || days === undefined ? null : Number(days));
      return { vip: user.vip === true, vipPro: user.vipPro === true, vipUntil: user.vipUntil ?? "", vipProUntil: user.vipProUntil ?? "" };
    }),
    api_admin_reply: adminEndpoint("/api/admin/support/reply", "POST", async (ctx) => {
      const { uid, text } = (ctx.body ?? {}) as { uid?: unknown; text?: unknown };
      await supportReply(String(uid), text);
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


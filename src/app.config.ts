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
import { LudoRoom } from "./rooms/LudoRoom.js";
import { GuessRoom } from "./rooms/GuessRoom.js";
import { ImposterRoom } from "./rooms/ImposterRoom.js";
import { MimicRoom } from "./rooms/MimicRoom.js";
import { PresenceRoom } from "./rooms/PresenceRoom.js";
import express from "express";
import { fileURLToPath } from "node:url";
import { catalog } from "./guess.js";
import {
  AuthError, buyAvatar, buyFrame, claimMission, ClaimError, exchangeToken, isAdmin, ProfileError, StoreError, updateProfile,
  type ProfileChanges,
} from "./accounts.js";
import { DAILY_BONUS, dayKey, MISSIONS, periodEnds, weekKey } from "./missions.js";

function roomInfo(r: { roomId: string; metadata?: any }) {
  return {
    roomId: r.roomId,
    host: r.metadata?.host ?? "",
    avatar: r.metadata?.hostAvatar ?? 0, // the host's, shown in the room lists
    frame: r.metadata?.hostFrame ?? 0,
    roomType: r.metadata?.roomType ?? "public",
    players: r.metadata?.players ?? 0,
    maxPlayers: r.metadata?.maxPlayers ?? 0,
    spectators: r.metadata?.spectators ?? 0,
    started: r.metadata?.started === true,
    mode: r.metadata?.mode ?? "", // guess who: duel | cup
  };
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
    ludo: defineRoom(LudoRoom),
    guess: defineRoom(GuessRoom),
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
    api_ludo_rooms: createEndpoint("/api/ludo/rooms", { method: "GET" }, async () => publicRooms("ludo")),
    api_guess_rooms: createEndpoint("/api/guess/rooms", { method: "GET" }, async () => publicRooms("guess")),
    api_imposter_rooms: createEndpoint("/api/imposter/rooms", { method: "GET" }, async () => publicRooms("imposter")),
    api_mimic_rooms: createEndpoint("/api/mimic/rooms", { method: "GET" }, async () => publicRooms("mimic")),
    // The home: how many public rooms each game has now.
    api_room_counts: createEndpoint("/api/room-counts", { method: "GET" }, async () => {
      const games = ["werewolf", "rummy", "domino", "ludo", "guess", "imposter", "mimic"];
      return Object.fromEntries(await Promise.all(games.map(async (g) => [g, (await publicRooms(g)).length])));
    }),
    // Round-trip check for the app's ping display.
    api_ping: createEndpoint("/api/ping", { method: "GET" }, async () => ({ t: Date.now() })),
    // Mission definitions and the current periods (the app reads progress from PocketBase).
    api_missions: createEndpoint("/api/missions", { method: "GET" }, async () => ({
      missions: MISSIONS,
      dailyBonus: DAILY_BONUS,
      day: dayKey(),
      week: weekKey(),
      ends: periodEnds(),
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
        return await exchangeToken(idToken);
      } catch (e) {
        throw ctx.error(statusFor(e), { error: (e as Error).message });
      }
    }),
    // Admins only (Authorization: Bearer <ID token>): every room, private ones included.
    api_admin_rooms: createEndpoint("/api/admin/rooms", { method: "GET" }, async (ctx) => {
      if (!(await isAdmin(bearer(ctx)))) throw ctx.error(403, { error: "admins only" });
      return (await matchMaker.query({ name: "werewolf" })).map((r) => ({
        ...roomInfo(r),
        phase: r.metadata?.phase ?? "",
        day: r.metadata?.day ?? 0,
      }));
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


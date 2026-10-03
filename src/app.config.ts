import {
  defineServer,
  defineRoom,
  monitor,
  playground,
  createRouter,
  createEndpoint,
  matchMaker,
} from "colyseus";

/**
 * Import your Room files
 */
import { WerewolfRoom } from "./rooms/WerewolfRoom.js";
import { RummyRoom } from "./rooms/RummyRoom.js";
import { claimMission, ClaimError, isAdmin } from "./firebase.js";
import { DAILY_BONUS, dayKey, MISSIONS, periodEnds, weekKey } from "./missions.js";

function roomInfo(r: { roomId: string; metadata?: any }) {
  return {
    roomId: r.roomId,
    host: r.metadata?.host ?? "",
    roomType: r.metadata?.roomType ?? "public",
    players: r.metadata?.players ?? 0,
    maxPlayers: r.metadata?.maxPlayers ?? 0,
    spectators: r.metadata?.spectators ?? 0,
    started: r.metadata?.started === true,
  };
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
    // Round-trip check for the app's ping display.
    api_ping: createEndpoint("/api/ping", { method: "GET" }, async () => ({ t: Date.now() })),
    // Mission definitions and the current periods (the app reads progress from Firestore).
    api_missions: createEndpoint("/api/missions", { method: "GET" }, async () => ({
      missions: MISSIONS,
      dailyBonus: DAILY_BONUS,
      day: dayKey(),
      week: weekKey(),
      ends: periodEnds(),
    })),
    // Claim a mission's reward: Authorization: Bearer <Firebase ID token>, body { id }.
    api_claim: createEndpoint("/api/missions/claim", { method: "POST" }, async (ctx) => {
      const token = ctx.request?.headers.get("authorization")?.replace(/^Bearer /, "");
      const id = (ctx.body as { id?: string } | undefined)?.id;
      if (!token || !id) throw ctx.error(400, { error: "missing token or id" });
      try {
        return { ok: true, reward: await claimMission(token, id) };
      } catch (e) {
        throw ctx.error(e instanceof ClaimError ? 409 : 401, { error: (e as Error).message });
      }
    }),
    // Admins only (Authorization: Bearer <ID token>): every room, private ones included.
    api_admin_rooms: createEndpoint("/api/admin/rooms", { method: "GET" }, async (ctx) => {
      const token = ctx.request?.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!(await isAdmin(token))) throw ctx.error(403, { error: "admins only" });
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
     * (It is not recommended to expose this route in a production environment)
     */
    if (process.env.NODE_ENV !== "production") {
      app.use("/", playground());
    }
  }
});

export default server;


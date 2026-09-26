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

const server = defineServer({

  /**
   * Define your room handlers:
   */
  rooms: {
    werewolf: defineRoom(WerewolfRoom),
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
    api_rooms: createEndpoint("/api/rooms", { method: "GET" }, async () => {
      const rooms = await matchMaker.query({ name: "werewolf" });
      return rooms
        .filter((r) => !r.private && !r.unlisted && (r.metadata?.roomType ?? "public") === "public")
        .map(roomInfo);
    }),
    // One room by id, whatever its type (invites, joining a friend): { found: false } when it's gone.
    api_room: createEndpoint("/api/rooms/:roomId", { method: "GET" }, async (ctx) => {
      const [room] = await matchMaker.query({ name: "werewolf", roomId: ctx.params.roomId });
      return room ? { found: true, ...roomInfo(room) } : { found: false };
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


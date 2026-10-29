import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";

describe("ClanLoungeRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());

  const until = async (cond: () => boolean, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
    assert.ok(cond(), "timed out");
  };

  it("one per clan; eight seats talk, the others listen; a hand, an emoji; it ends once empty", async () => {
    const room: any = await colyseus.createRoom("clan_lounge", { clan: "a" });
    const join = async (name: string) => {
      const client = await colyseus.connectTo(room, { clan: "a", name });
      const p = { client, state: null as any, emojis: [] as any[] };
      client.onMessage("lounge", (s: any) => (p.state = s));
      client.onMessage("lounge_emoji", (e: any) => p.emojis.push(e));
      client.onMessage("voice", () => {});
      return p;
    };
    const [karim, lina] = [await join("Karim"), await join("Lina")];
    await until(() => lina.state?.listeners.length === 2);
    karim.client.send("sit", { seat: 0 });
    lina.client.send("sit", { seat: 0 }); // taken
    await until(() => lina.state?.seats[0]?.name === "Karim");
    assert.deepStrictEqual([lina.state.listeners.map((p: any) => p.name), lina.state.seats.filter(Boolean).length], [["Lina"], 1]);
    lina.client.send("hand");
    await until(() => karim.state?.hands.length === 1);
    lina.client.send("sit", { seat: 7 });
    await until(() => karim.state?.seats[7]?.name === "Lina" && karim.state.hands.length === 0);
    lina.client.send("emoji", { emoji: "🔥" });
    lina.client.send("emoji", { emoji: "<script>" }); // not one of ours
    await until(() => karim.emojis.length === 1);
    assert.strictEqual(karim.emojis[0].emoji, "🔥");
    assert.deepStrictEqual(room.metadata.talking.map((t: any) => t.name), ["Karim", "Lina"]);
    karim.client.send("stand");
    await until(() => lina.state?.seats[0] === null);
    // Members find their clan's lounge; another clan's is another room.
    const same = await colyseus.sdk.joinOrCreate("clan_lounge", { clan: "a", name: "Yasmine" });
    const other = await colyseus.sdk.joinOrCreate("clan_lounge", { clan: "b", name: "Nour" });
    assert.strictEqual(same.roomId, room.roomId);
    assert.notStrictEqual(other.roomId, room.roomId);
    await same.leave();
    await other.leave();
    await karim.client.leave();
    await lina.client.leave();
    await until(() => room.clients.length === 0);
  });
});

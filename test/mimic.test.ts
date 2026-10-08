import assert from "assert";
import { ColyseusTestServer } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { MIMIC_SOUNDS } from "../src/mimicSounds.js";
import { MimicRoom } from "../src/rooms/MimicRoom.js";

describe("mimic sounds", () => {
  it("has 63 sounds in 7 categories, each a few seconds", () => {
    assert.strictEqual(MIMIC_SOUNDS.length, 63);
    assert.strictEqual(new Set(MIMIC_SOUNDS.map((s) => s.cat)).size, 7);
    assert.ok(MIMIC_SOUNDS.every((s) => s.seconds > 0.1 && s.seconds < 5));
  });
});

describe("MimicRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => {
    MimicRoom.pace = 0.01;
    // As boot() does, but not on its 2568: a playground tunnel there would take these connections.
    await appConfig.listen(2569);
    colyseus = new ColyseusTestServer(appConfig);
  });
  after(async () => {
    MimicRoom.pace = 1;
    await colyseus.shutdown();
  });

  const until = async (cond: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.ok(cond(), "timed out");
  };

  async function open(n: number, settings: Record<string, unknown>) {
    const room: any = await colyseus.createRoom("mimic", settings);
    room.setSimulationInterval(() => {}, 5);
    const players: { client: any; state: any }[] = [];
    for (let i = 0; i < n; i++) {
      const client = await colyseus.connectTo(room, { name: `P${i}` });
      const p = { client, state: null as any };
      client.onMessage("mimic", (s: any) => (p.state = s));
      players.push(p);
    }
    await until(() => players.every((p) => p.state?.seats.length === n));
    return { room, players };
  }

  /** A take — a second of 16 kHz audio — and its score, sent as the phone does: its HTTP status. */
  const wav = Buffer.alloc(44 + 32_000);
  const take = (room: any, p: any, score: number, token = p.state.token) =>
    colyseus.http
      .post(`/api/mimic/clip?room=${room.roomId}&session=${p.state.me}&token=${token}&round=${room.round}&score=${score}`, {
        body: wav,
        headers: { "content-type": "application/octet-stream" },
      })
      .then((r: any) => r.statusCode, (e: any) => e.statusCode);
  const clip = (room: any, p: any) =>
    colyseus.http
      .get(`/api/mimic/clip/${room.roomId}/${room.round}/${p.state.me}.wav`)
      .then((r: any) => r.statusCode, (e: any) => e.statusCode);

  it("everyone imitates (the last take counts), the takes are judged lowest first, next when all are ready", async () => {
    const { room, players } = await open(3, { rounds: 5, category: "farm" });
    const [a, b, c] = players;
    a.client.send("start_game");
    const sounds = new Set<string>();
    for (let r = 1; r <= 5; r++) {
      await until(() => room.phase === "record" && room.round === r);
      await until(() => players.every((p) => p.state.phase === "record" && p.state.round === r));
      sounds.add(room.sound);
      assert.ok(MIMIC_SOUNDS.find((s) => s.id === room.sound)!.cat === "farm");
      a.client.send("done"); // no take yet: not done
      assert.strictEqual(await take(room, a, 95), 200);
      assert.strictEqual(await take(room, a, 40 + r), 200); // tried again: this one counts
      assert.strictEqual(await take(room, b, 90), 200);
      assert.strictEqual(await take(room, c, 10), 200);
      if (r === 1) {
        assert.strictEqual(await take(room, a, 50, "nope"), 403); // not his token
        assert.strictEqual(await clip(room, a), 404); // nobody hears a take before the results
        await until(() => c.state.seats.every((s: any) => s.takes > 0));
        assert.ok(c.state.seats.every((s: any) => s.score === -1), "scores hidden while imitating");
        assert.ok(room.seats[0].done === false);
      }
      for (const p of players) p.client.send("done");
      await until(() => room.phase === "judge" && room.round === r);
      assert.deepStrictEqual(room.order, [c.state.me, a.state.me, b.state.me], "lowest first");
      if (r === 1) {
        // While the first take plays, only its score is out.
        await until(() => a.state.phase === "judge" && a.state.judged === 0);
        const score = (id: string) => a.state.seats.find((s: any) => s.id === id).score;
        assert.deepStrictEqual([score(c.state.me), score(a.state.me), score(b.state.me)], [10, -1, -1]);
        assert.strictEqual(a.state.seats.find((s: any) => s.id === c.state.me).ms, 1000);
        assert.ok(a.state.scoreAt - a.state.takeAt === Math.round(1000 * MimicRoom.pace));
        assert.strictEqual(await clip(room, a), 200); // now everyone can hear it
      }
      await until(() => room.phase === "after" && room.round === r);
      await until(() => players.every((p) => p.state.phase === "after"));
      assert.ok(a.state.seats.every((s: any) => s.score >= 0), "every score shown");
      for (const p of players) p.client.send("next");
    }
    await until(() => room.phase === "result");
    assert.strictEqual(sounds.size, 5, "no sound twice");
    assert.deepStrictEqual(
      room.seats.map((s: any) => s.scores),
      [[41, 42, 43, 44, 45], [90, 90, 90, 90, 90], [10, 10, 10, 10, 10]],
    );
    a.client.send("play_again");
    await until(() => room.phase === "lobby");
    room.disconnect();
  });

  it("the timer: whoever never imitated scores 0 and isn't heard; the next sound comes anyway", async () => {
    const { room, players } = await open(2, { rounds: 5 });
    const [a] = players;
    a.client.send("start_game");
    await until(() => room.phase === "record" && a.state?.phase === "record");
    assert.strictEqual(await take(room, a, 50), 200);
    a.client.send("done");
    await until(() => room.seats[0].done);
    assert.strictEqual(await take(room, a, 99), 403); // done: no more takes
    await until(() => room.phase === "judge"); // the other's time ran out
    assert.deepStrictEqual(room.order, [a.state.me]);
    await until(() => room.round === 2); // nobody tapped next
    assert.deepStrictEqual(room.seats.map((s: any) => s.scores[0]), [50, 0]);
    room.disconnect();
  });
});

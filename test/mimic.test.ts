import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

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
    MimicRoom.pace = 0.002;
    colyseus = await boot(appConfig);
  });
  after(async () => {
    MimicRoom.pace = 1;
    await colyseus.shutdown();
  });

  const until = async (cond: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), "timed out");
  };

  async function open(n: number, settings: Record<string, unknown>) {
    const room: any = await colyseus.createRoom("mimic", settings);
    room.setSimulationInterval(() => {}, 5);
    const players: { client: any; state: any; levels: number; seen: any[] }[] = [];
    for (let i = 0; i < n; i++) {
      const client = await colyseus.connectTo(room, { name: `P${i}` });
      const p = { client, state: null as any, levels: 0, seen: [] as any[] };
      client.onMessage("mimic", (s: any) => {
        p.state = s;
        p.seen.push(s); // every state, even the shortest phases
      });
      client.onMessage("mimic_level", () => p.levels++);
      client.onMessage("mimic_error", () => {});
      players.push(p);
    }
    await until(() => players.every((p) => p.state?.seats.length === n));
    return { room, players };
  }

  it("all together: attempts, the best one counts, a recording, the next round when everyone's ready, the average", async () => {
    const { room, players } = await open(3, { mode: "together", rounds: 5, attempts: 2, category: "farm" });
    players[0].client.send("start_game");
    const sounds = new Set<string>();
    for (let r = 1; r <= 5; r++) {
      await until(() => room.phase === "record" && room.round === r);
      sounds.add(room.sound);
      assert.ok(MIMIC_SOUNDS.find((s) => s.id === room.sound)!.cat === "farm");
      const [a, b, c] = players;
      a.client.send("score", { score: 40 });
      a.client.send("score", { score: 70 + r }); // a second attempt: the best of the two
      b.client.send("score", { score: 90 });
      b.client.send("keep"); // happy with one
      // Someone's recording, over HTTP.
      if (r === 1) {
        await until(() => a.state.phase === "record");
        const res = await colyseus.http.post(
          `/api/mimic/clip?room=${room.roomId}&session=${a.state.me}&token=${a.state.token}&round=1`,
          { body: Buffer.from("RIFF fake wav"), headers: { "content-type": "application/octet-stream" } },
        );
        assert.strictEqual(res.statusCode, 200);
        const wrong = await colyseus.http
          .post(`/api/mimic/clip?room=${room.roomId}&session=${a.state.me}&token=nope&round=1`, {
            body: Buffer.from("x"),
            headers: { "content-type": "application/octet-stream" },
          })
          .catch((e: any) => e);
        assert.strictEqual(wrong.statusCode, 403);
        // Hidden until the round's end.
        assert.ok(c.state.seats.every((s: any) => s.best === -1));
      }
      c.client.send("score", { score: 10 });
      c.client.send("keep");
      await until(() => room.phase === "reveal" && room.round === r);
      await until(() => players.every((p) => p.state.phase === "reveal"));
      const best = (p: any) => p.state.seats.find((s: any) => s.id === a.state.me).best;
      assert.strictEqual(best(c), 70 + r);
      if (r === 1) {
        assert.strictEqual(a.state.seats.find((s: any) => s.id === a.state.me).clip, 1);
        const wav = await colyseus.http.get(`/api/mimic/clip/${room.roomId}/1/${a.state.me}.wav`);
        assert.strictEqual(String(wav.data), "RIFF fake wav");
      }
      for (const p of players) p.client.send("next");
    }
    await until(() => room.phase === "result");
    assert.strictEqual(sounds.size, 5, "no sound twice");
    const scores = room.seats.map((s: any) => s.scores);
    assert.deepStrictEqual(scores[0], [71, 72, 73, 74, 75]);
    assert.deepStrictEqual(scores[1], [90, 90, 90, 90, 90]);
    players[0].client.send("play_again");
    await until(() => room.phase === "lobby");
    room.disconnect();
  });

  it("one at a time: each imitates in turn (the others see his waveform), then everyone hears him", async () => {
    const { room, players } = await open(2, { mode: "turns", rounds: 5 });
    players[0].client.send("start_game");
    await until(() => room.phase === "perform");
    const first = players.find((p) => p.state.me === room.performer)!;
    const other = players.find((p) => p !== first)!;
    first.client.send("level", { v: [0.1, 0.5, 0.9] });
    other.client.send("level", { v: [1] }); // not his turn: dropped
    await until(() => other.levels === 1);
    assert.strictEqual(first.levels, 0);
    first.client.send("score", { score: 66 }); // one attempt: his turn is over
    await until(() =>
      other.seen.some((s) => s.phase === "replay" && s.seats.find((x: any) => x.id === first.state.me).best === 66),
    );
    await until(() => room.phase === "perform" && room.performer === other.state.me);
    other.client.send("score", { score: 12 });
    await until(() => room.phase === "reveal");
    assert.deepStrictEqual(room.seats.map((s: any) => s.scores[0]).sort(), [12, 66]);
    room.disconnect();
  });

  it("nobody taps next: the next round comes anyway; who never imitated scores 0", async () => {
    const { room, players } = await open(2, { mode: "together", rounds: 5 });
    players[0].client.send("start_game");
    await until(() => room.phase === "record");
    players[0].client.send("score", { score: 50 });
    await until(() => room.phase === "reveal"); // the other's time ran out
    await until(() => room.round === 2 && room.phase !== "reveal"); // a minute later (sped up)
    assert.deepStrictEqual(room.seats.map((s: any) => s.scores[0]), [50, 0]);
    room.disconnect();
  });
});

import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import {
  botMove, bracket, candidates, catalog, covers, found, nextSlot, possible, randomPlayer, validQuestion, valueOf,
  type Answer,
} from "../src/guess.js";
import { GuessRoom } from "../src/rooms/GuessRoom.js";

const ask = (secret: ReturnType<typeof randomPlayer>, cat: Answer["cat"], items: string[]): Answer => ({
  cat, items, yes: covers({ cat, items }).has(valueOf(secret, cat)),
});

describe("guess who", () => {
  it("has a catalogue: footballers with a known club, nation, position and number", () => {
    assert.ok(catalog.players.length >= 100);
    const clubs = new Set(catalog.clubs.map((c) => c.id)), nations = new Set(catalog.nations.map((n) => n.id));
    for (const p of catalog.players) {
      assert.ok(clubs.has(p.club) && nations.has(p.nation), p.id);
      assert.ok(["GK", "DEF", "MID", "ATT"].includes(p.pos) && p.num >= 1 && p.num <= 99, p.id);
    }
    assert.strictEqual(catalog.nations.length, 211);
  });

  it("covers whole groups: a confederation's nations, a league's clubs", () => {
    const europe = covers({ cat: "nation", items: ["UEFA"] });
    assert.strictEqual(europe.size, 55);
    assert.ok(europe.has("FRA") && europe.has("ENG") && !europe.has("BRA"));
    assert.strictEqual(covers({ cat: "nation", items: ["UEFA", "BRA"] }).size, 56);
    assert.strictEqual(covers({ cat: "club", items: ["esp"] }).size, 20);
    assert.ok(covers({ cat: "club", items: ["esp-RMA"] }).has("esp-RMA"));
    assert.ok(!validQuestion({ cat: "club", items: ["nowhere"] }));
    assert.ok(!validQuestion({ cat: "height", items: ["2m"] }));
    assert.ok(validQuestion({ cat: "num", items: ["10"] }));
  });

  it("finds a category when one value is left; narrows the candidates", () => {
    const secret = catalog.players[0];
    const answers = [ask(secret, "pos", ["GK", "DEF"]), ask(secret, "pos", ["GK"])];
    assert.strictEqual(possible(answers, "pos").size, answers[0].yes ? 1 : 2); // GK or DEF: settled; else MID or ATT
    // "no" twice over three positions leaves one: found without asking it straight.
    const others = ["GK", "DEF", "MID", "ATT"].filter((p) => p !== secret.pos);
    const nos = others.slice(0, 2).map((p) => ask(secret, "pos", [p]));
    assert.strictEqual(found(nos, "pos"), null);
    assert.strictEqual(found([...nos, ask(secret, "pos", [others[2]])], "pos"), secret.pos);
    const left = candidates([ask(secret, "club", [secret.club]), ask(secret, "num", [String(secret.num)])]);
    assert.ok(left.some((p) => p.id === secret.id) && left.length <= 2);
    assert.ok(!candidates([], [secret.id]).some((p) => p.id === secret.id), "a wrong guess is out");
  });

  it("bots find the footballer", () => {
    for (let game = 0; game < 30; game++) {
      const secret = randomPlayer();
      const answers: Answer[] = [], wrong: string[] = [];
      let moves = 0;
      for (; moves < 80; moves++) {
        const move = botMove(answers, wrong);
        if ("guess" in move) {
          if (move.guess === secret.id) break;
          wrong.push(move.guess);
        } else answers.push(ask(secret, move.cat, move.items));
      }
      assert.ok(moves < 80, `found ${secret.name.en} in ${moves} moves`);
    }
  });

  it("draws the cup: everyone once, winners meet in the next round", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const m = bracket(ids);
    assert.strictEqual(m.length, 7);
    assert.deepStrictEqual(m.slice(0, 4).flatMap((x) => [x.a, x.b]).sort(), ids);
    assert.deepStrictEqual(nextSlot(8, 0), { match: 4, side: "a" });
    assert.deepStrictEqual(nextSlot(8, 3), { match: 5, side: "b" });
    assert.deepStrictEqual(nextSlot(8, 5), { match: 6, side: "b" });
    assert.strictEqual(nextSlot(8, 6), null);
    assert.strictEqual(bracket(ids.slice(0, 4)).length, 3);
    assert.deepStrictEqual(nextSlot(4, 1), { match: 2, side: "b" });
    assert.strictEqual(nextSlot(4, 2), null);
  });
});

describe("GuessRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => {
    GuessRoom.botSpeed = 0.01;
    GuessRoom.pace = 0.01;
    colyseus = await boot(appConfig);
  });
  after(async () => {
    GuessRoom.botSpeed = 1;
    GuessRoom.pace = 1;
    await colyseus.shutdown();
  });

  /** A test client that plays like a bot on its turns (and picks a footballer when asked) — unless [passive]. */
  async function player(room: any, passive = false) {
    const client = await colyseus.connectTo(room);
    let last: any = null;
    const peeks: string[] = []; // secrets it saw while waiting (a cup's other match)
    client.onMessage("guess_fx", () => {});
    client.onMessage("guess_error", (e: any) => assert.fail(`error ${e.code}`));
    client.onMessage("guess", (s: any) => {
      last = s;
      const mine = s.sides.find((x: any) => x.id === s.me);
      if (s.phase === "playing" && !mine && !s.spectate) peeks.push(...s.sides.map((x: any) => x.secret).filter(Boolean));
      if (passive) return;
      if (s.phase === "pick" && mine && !mine.secret) client.send("pick", { player: randomPlayer().id });
      if (s.phase === "playing" && s.turn === s.me && mine) {
        const move = botMove(mine.answers, mine.wrong);
        client.send("guess" in move ? "guess" : "ask", "guess" in move ? { player: move.guess } : move);
      }
    });
    return { client, state: () => last, peeks };
  }

  const until = async (cond: () => boolean, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(cond(), "timed out");
  };

  it("1 vs 1, best of 3, footballers picked: someone wins two rounds", async () => {
    const room: any = await colyseus.createRoom("guess", { mode: "duel", rounds: 3, random: false });
    room.setSimulationInterval(() => {}, 5);
    const a = await player(room);
    const b = await player(room);
    await until(() => a.state()?.seats.length === 2);
    a.client.send("start_game");
    await until(() => room.phase === "gameover");
    const m = room.matches[0];
    assert.ok([m.a, m.b].includes(room.champion));
    assert.strictEqual(m.rounds.filter((r: number) => r === (room.champion === m.a ? 0 : 1)).length, 2);
    // Secrets: each sees only his own while playing; both once it's over.
    assert.ok(b.state().sides.every((s: any) => s.secret));
  });

  it("a cup of 8 (bots and me) is played to its champion", async () => {
    const room: any = await colyseus.createRoom("guess", { mode: "cup", cupSize: 8, rounds: 1 });
    room.setSimulationInterval(() => {}, 5);
    const me = await player(room);
    await until(() => me.state()?.seats.length === 1);
    for (let i = 0; i < 7; i++) me.client.send("add_bot");
    await until(() => me.state()?.seats.length === 8);
    me.client.send("start_game");
    await until(() => room.phase === "gameover", 120_000);
    assert.deepStrictEqual(me.peeks, [], "waiting, I don't see the secrets (the room's default)");
    assert.strictEqual(room.matches.length, 7);
    assert.ok(room.matches.every((m: any) => m.winner));
    assert.strictEqual(room.champion, room.matches[6].winner);
  });

  it("leaving a 1 vs 1 hands the match to the other", async () => {
    const room: any = await colyseus.createRoom("guess", { mode: "duel", rounds: 5, time: 900 });
    const a = await player(room, true);
    const b = await player(room, true);
    await until(() => a.state()?.seats.length === 2);
    a.client.send("start_game");
    await until(() => room.phase === "playing");
    const leaver = b.state().me;
    await b.client.leave();
    await until(() => room.phase === "gameover");
    assert.notStrictEqual(room.champion, leaver);
  });
});

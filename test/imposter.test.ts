import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { CATEGORIES, WORDS, wordsOf } from "../src/imposterWords.js";
import { ImposterRoom } from "../src/rooms/ImposterRoom.js";

describe("imposter words", () => {
  it("has 8 categories of 30+ words, in three languages", () => {
    assert.strictEqual(CATEGORIES.length, 8);
    for (const cat of CATEGORIES) assert.ok(wordsOf(cat).length >= 30, cat);
    assert.strictEqual(new Set(WORDS.map((w) => w.id)).size, WORDS.length);
    for (const w of WORDS) assert.ok(w.en && w.fr && w.ar, w.id);
  });
});

describe("ImposterRoom", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => {
    ImposterRoom.pace = 0.01;
    colyseus = await boot(appConfig);
  });
  after(async () => {
    ImposterRoom.pace = 1;
    await colyseus.shutdown();
  });

  const until = async (cond: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 15));
    assert.ok(cond(), "timed out");
  };

  /** A room with [n] players, the game started and everyone past his card: the talk. */
  async function game(n: number, settings: Record<string, unknown> = {}) {
    const room: any = await colyseus.createRoom("imposter", settings);
    room.setSimulationInterval(() => {}, 5);
    const players = [];
    for (let i = 0; i < n; i++) {
      const client = await colyseus.connectTo(room, { name: `P${i}` });
      const p = { client, state: null as any };
      client.onMessage("imposter", (s: any) => (p.state = s));
      client.onMessage("imposter_error", () => {});
      players.push(p);
    }
    await until(() => players.every((p) => p.state?.seats.length === n));
    players[0].client.send("start_game");
    await until(() => room.phase === "reveal");
    for (const p of players) p.client.send("seen");
    await until(() => room.phase === "talk");
    await until(() => players.every((p) => p.state?.phase === "talk"));
    return { room, players };
  }

  const imposterOf = (players: any[]) => players.filter((p) => p.state.card.imposter);

  it("deals one word to all but the imposter, who only knows the category", async () => {
    const { room, players } = await game(4, { category: "food" });
    const imposters = imposterOf(players);
    assert.strictEqual(imposters.length, 1);
    const words = new Set(players.filter((p) => !p.state.card.imposter).map((p) => p.state.card.word.id));
    assert.strictEqual(words.size, 1);
    assert.ok([...words][0].startsWith("food-"));
    assert.strictEqual(imposters[0].state.card.word, undefined);
    assert.ok(players.every((p) => p.state.wordCategory === "food" && p.state.word === null));
    assert.ok(players.every((p) => p.state.seats.every((s: any) => s.role === "")), "roles stay secret");
    room.disconnect();
  });

  it("one vote: the imposter caught guesses wrong — the players win", async () => {
    const { room, players } = await game(4, { mode: "single" });
    const [imp] = imposterOf(players);
    const impId = imp.state.me;
    for (const p of players.slice(0, 3)) p.client.send("vote_now");
    await until(() => room.phase === "vote");
    for (const p of players) p.client.send("vote", { target: p.state.me === impId ? players.find((q) => q !== p)!.state.me : impId });
    await until(() => room.phase === "guess");
    await until(() => imp.state.phase === "guess" && imp.state.options.length >= 30);
    assert.ok(players.filter((p) => p !== imp).every((p) => p.state.options.length === 0));
    const wrong = imp.state.options.find((w: any) => w.id !== room.word.id);
    imp.client.send("guess", { word: wrong.id });
    await until(() => room.phase === "result");
    assert.strictEqual(room.winner, "players");
    await until(() => players.every((p) => p.state.phase === "result"));
    const me = (p: any) => p.state.seats.find((s: any) => s.id === p.state.me);
    assert.ok(players.every((p) => me(p).gained === (p === imp ? 0 : 1)));
    assert.ok(players[0].state.word?.id === room.word.id, "the word is shown at the end");
    // Play again: back to the waiting room, the scores kept.
    players[0].client.send("play_again");
    await until(() => room.phase === "lobby");
    assert.ok(room.seats.filter((s: any) => s.score === 1).length === 3);
    room.disconnect();
  });

  it("a caught imposter who guesses the word wins anyway", async () => {
    const { room, players } = await game(3);
    const [imp] = imposterOf(players);
    for (const p of players) p.client.send("vote_now");
    await until(() => room.phase === "vote");
    for (const p of players) if (p !== imp) p.client.send("vote", { target: imp.state.me });
    imp.client.send("vote", { target: "" });
    await until(() => room.phase === "guess" && imp.state.options.length > 0);
    imp.client.send("guess", { word: room.word.id });
    await until(() => room.phase === "result");
    assert.strictEqual(room.winner, "imposters");
    assert.strictEqual(room.seats.find((s: any) => s.imposter).gained, 2);
    room.disconnect();
  });

  it("a tie, in one vote: nobody caught, the imposter wins", async () => {
    const { room, players } = await game(4);
    for (const p of players) p.client.send("vote_now");
    await until(() => room.phase === "vote");
    // Two votes each on two players.
    const [a, b] = players.map((p) => p.state.me);
    players[0].client.send("vote", { target: b });
    players[1].client.send("vote", { target: a });
    players[2].client.send("vote", { target: a });
    players[3].client.send("vote", { target: b });
    await until(() => room.phase === "result");
    assert.strictEqual(room.votedOut, "");
    assert.strictEqual(room.winner, "imposters");
    room.disconnect();
  });

  it("elimination: an innocent out, then the imposter — the players win", async () => {
    const { room, players } = await game(5, { mode: "elimination" });
    const [imp] = imposterOf(players);
    const innocent = players.find((p) => p !== imp)!;
    const voteOut = async (target: any) => {
      for (const p of players) p.client.send("vote_now");
      await until(() => room.phase === "vote");
      for (const p of players) if (!room.seat(p.state.me).out && p !== target) p.client.send("vote", { target: target.state.me });
      target.client.send("vote", { target: "" });
    };
    await voteOut(innocent);
    await until(() => room.phase === "talk" && room.round === 2);
    await until(() => innocent.state.seats.find((s: any) => s.id === innocent.state.me).out);
    assert.strictEqual(players[0].state.seats.find((s: any) => s.id === innocent.state.me).role, "player");
    await voteOut(imp);
    await until(() => room.phase === "guess");
    imp.client.send("guess", { word: wordsOf(room.word.cat).find((w) => w.id !== room.word.id)!.id });
    await until(() => room.phase === "result");
    assert.strictEqual(room.winner, "players");
    room.disconnect();
  });

  it("two imposters need five players", async () => {
    const room: any = await colyseus.createRoom("imposter", { imposters: 2 });
    let error = "";
    const host = await colyseus.connectTo(room);
    host.onMessage("imposter", () => {});
    host.onMessage("imposter_error", (e: any) => (error = e.code));
    for (let i = 0; i < 3; i++) (await colyseus.connectTo(room)).onMessage("imposter", () => {});
    await until(() => room.seats.length === 4);
    host.send("start_game");
    await until(() => error === "too_few_for_two");
    assert.strictEqual(room.phase, "lobby");
    room.disconnect();
  });
});

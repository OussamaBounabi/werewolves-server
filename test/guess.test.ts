import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import {
  botMove, bracket, candidates, catalog, covers, found, legend, legends, LEVELS, nextSlot, playerInfo, possible, randomLegend, randomPlayer,
  validQuestion, valueOf,
  type Answer,
} from "../src/guess.js";
import { item, itemsOf, MYSTERY_CATEGORIES } from "../src/mysteryItems.js";
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

  it("draws by difficulty: the giants' clubs, 20 well-known ones, the rest", () => {
    const clubs = new Set(catalog.clubs.map((c) => c.id));
    const easy = ["eng-LIV", "esp-RMA", "ita-INT", "ger-DOR", "fra-OM"], medium = ["eng-NEW", "esp-SEV", "fra-OL"];
    assert.equal(catalog.clubs.filter((c) => LEVELS.easy(c.id)).length, 18);
    assert.equal(catalog.clubs.filter((c) => LEVELS.medium(c.id)).length, 20);
    for (const c of [...easy, ...medium]) assert.ok(clubs.has(c), c);
    for (let i = 0; i < 300; i++) {
      assert.ok(LEVELS.easy(randomPlayer("easy").club));
      assert.ok(LEVELS.medium(randomPlayer("medium").club));
      const h = randomPlayer("hard").club;
      assert.ok(!LEVELS.easy(h) && !LEVELS.medium(h), h);
    }
  });

  it("the legends: 60 easy, 60 medium, 78 hard, all with a portrait, drawn by level, each with his career", () => {
    assert.deepStrictEqual(["easy", "medium", "hard"].map((v) => legends.filter((l) => l.level === v).length), [60, 60, 78]);
    assert.ok(legends.every((l) => l.photo), "no legend without a portrait");
    for (let i = 0; i < 200; i++) assert.strictEqual(randomLegend("hard").level, "hard");
    const zidane = legends.find((l) => l.name.en === "Zinedine Zidane")!;
    assert.strictEqual(zidane.born, 1972);
    assert.strictEqual(zidane.retired, 2006);
    assert.ok((zidane.clubs as any[]).some((c) => c.name.en === "Real Madrid" && c.from === 2001 && c.to === 2006));
    assert.ok((zidane.trophies as any[]).some((t) => t.icon === "worldcup" && t.years.includes("1998")));
    assert.ok((zidane.awards as any[]).some((t) => t.icon === "ballon"));
    assert.ok(legends.every((l) => (l.positions as string[]).length > 0));
    // the checks by hand stick: no false Ballon d'Or (Ibrahimović's nominations, Xavi's podiums), the real ones kept
    const ballons = (n: string) => ((legends.find((l) => l.name.en === n)!.awards as any[]).find((a) => a.icon === "ballon")?.years ?? []).length;
    assert.deepStrictEqual(["Lionel Messi", "Cristiano Ronaldo", "Zlatan Ibrahimović", "Xavi", "Ruud Gullit", "Mario Kempes"].map(ballons), [8, 5, 0, 0, 1, 0]);
  });

  it("the easy level's footballers have an info sheet", () => {
    const easy = catalog.players.filter((p) => LEVELS.easy(p.club));
    assert.ok(easy.every((p) => playerInfo.players[p.id]), "every easy footballer");
    const mbappe = playerInfo.players[catalog.players.find((p) => p.name.en === "Kylian Mbappé")!.id] as any;
    assert.strictEqual(mbappe.retired, null);
    assert.ok(mbappe.clubs.some((c: any) => c.name.en === "Real Madrid" && c.to === null));
    assert.ok(mbappe.trophies.some((t: any) => t.icon === "worldcup" && t.years.includes("2018")));
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

  it("draws a cup of 6: two byes, one in each half, straight into the semi-finals", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    for (let i = 0; i < 50; i++) {
      const m = bracket(ids);
      assert.strictEqual(m.length, 7);
      assert.deepStrictEqual(m.slice(0, 4).flatMap((x) => [x.a, x.b]).filter(Boolean).sort(), ids);
      assert.deepStrictEqual([m[1].b, m[3].b], ["", ""], "the byes: quarter-finals 2 and 4");
      assert.deepStrictEqual([m[1].winner, m[3].winner], [m[1].a, m[3].a]);
      assert.deepStrictEqual([m[4].b, m[5].b], [m[1].a, m[3].a], "waiting in the semi-finals");
      assert.ok(m[0].b && m[2].b && !m[0].winner && !m[2].winner, "the other four play");
    }
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

  it("legends only in trust mode: drawn at the room's level, the round ends when one is found", async () => {
    const plain: any = await colyseus.createRoom("guess", { mode: "duel", legends: true });
    assert.strictEqual(plain.legends, false, "no legends without trust mode");
    const room: any = await colyseus.createRoom("guess", { mode: "duel", rounds: 1, trust: true, legends: true, level: "medium" });
    const a = await player(room, true);
    const b = await player(room, true);
    await until(() => a.state()?.seats.length === 2);
    assert.strictEqual(a.state().legends, true);
    a.client.send("start_game");
    await until(() => room.phase === "playing");
    for (const s of room.sides) assert.strictEqual(legend(s.secret)?.level, "medium");
    b.client.send("concede");
    await until(() => room.phase === "gameover");
  });

  it("1 vs 1 or a cup is chosen in the waiting room; a cup of 6 is played to its champion", async () => {
    const room: any = await colyseus.createRoom("guess", { rounds: 1 });
    room.setSimulationInterval(() => {}, 5);
    const me = await player(room);
    await until(() => me.state()?.seats.length === 1);
    assert.strictEqual(me.state().mode, "duel");
    me.client.send("settings", { mode: "cup", cupSize: 6 });
    await until(() => me.state()?.maxPlayers === 6);
    for (let i = 0; i < 5; i++) me.client.send("add_bot");
    await until(() => me.state()?.seats.length === 6);
    me.client.send("settings", { mode: "duel" });
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(me.state().mode, "cup", "six seated: not back to 1 vs 1");
    me.client.send("start_game");
    await until(() => room.phase === "gameover", 120_000);
    assert.strictEqual(room.matches.filter((m: any) => m.b === "").length, 2);
    assert.ok(room.matches.every((m: any) => m.winner));
    assert.strictEqual(room.champion, room.matches[6].winner);
  });

  // ---- Mystery Item: the same room with things ----

  /** Two players in a Mystery Item room made with [options]; their last states and any errors. */
  async function mysteryPair(options: Record<string, unknown>) {
    const room: any = await colyseus.createRoom("mystery", { rounds: 1, ...options });
    const join = async () => {
      const client = await colyseus.connectTo(room);
      const seen = { state: null as any, errors: [] as string[] };
      client.onMessage("guess_fx", () => {});
      client.onMessage("guess", (s: any) => (seen.state = s));
      client.onMessage("guess_error", (e: any) => seen.errors.push(e.code));
      return { client, seen };
    };
    const a = await join(), b = await join();
    await until(() => a.seen.state?.seats.length === 2);
    return { room, a, b };
  }

  it("Mystery Item: 7 categories of 50 well-known things (49 fruits and vegetables), countries by their flag", () => {
    assert.deepStrictEqual(MYSTERY_CATEGORIES, ["animals", "food", "fruits", "things", "vehicles", "places", "countries"]);
    for (const c of MYSTERY_CATEGORIES) assert.strictEqual(itemsOf(c).length, c === "fruits" ? 49 : 50, c);
    assert.ok(itemsOf("countries").every((i) => i.flag && i.name.ar));
    assert.strictEqual(item("animals-polar-bear")?.name.fr, "Ours polaire");
  });

  it("Mystery Item: always trust mode; one category for both, then any category, the same or each his own", async () => {
    const { room, a, b } = await mysteryPair({ category: "animals" });
    a.client.send("settings", { trust: false, legends: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(a.seen.state.trust, true);
    assert.strictEqual(a.seen.state.legends, false);
    assert.strictEqual(a.seen.state.game, "mystery");
    a.client.send("start_game");
    await until(() => room.phase === "playing");
    const [x, y] = room.sides;
    assert.ok(x.secret !== y.secret && item(x.secret)?.cat === "animals" && item(y.secret)?.cat === "animals");
    await until(() => a.seen.state.phase === "playing");
    const theirs = a.seen.state.sides.find((s: any) => s.id !== a.seen.state.me);
    assert.deepStrictEqual([theirs.secret, theirs.cat], ["", "animals"], "their category shows, not their item");
    b.client.send("concede");
    await until(() => room.phase === "gameover");

    for (const same of [true, false]) {
      for (let i = 0; i < 3; i++) {
        const { room: r, a: p } = await mysteryPair({ category: "all", same });
        p.client.send("start_game");
        await until(() => r.phase === "playing");
        const [c1, c2] = r.sides.map((s: any) => item(s.secret)!.cat);
        assert.strictEqual(c1 === c2, same, `same: ${same} (${c1}, ${c2})`);
        await r.disconnect();
      }
    }
  });

  it("Mystery Item: picking my own thing, only in my category", async () => {
    const { room, a, b } = await mysteryPair({ category: "fruits", random: false });
    a.client.send("start_game");
    await until(() => room.phase === "pick");
    a.client.send("pick", { player: "animals-lion" });
    await until(() => a.seen.errors.includes("unknown_player"));
    a.client.send("pick", { player: "fruits-mango" });
    b.client.send("pick", { player: "fruits-banana" });
    await until(() => room.phase === "playing");
    assert.deepStrictEqual(room.sides.map((s: any) => s.secret).sort(), ["fruits-banana", "fruits-mango"]);
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

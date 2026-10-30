import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Stockfish (the VPS's own program, STOCKFISH_BIN in .env; GPL, so it stays on the server), spoken to in UCI. One
 * process, one job at a time (the VPS has two cores, the game server's too), one thread and a small hash. No engine
 * set: engineAvailable() is false and the callers use our own bot. A job that hangs kills the process; the next one
 * starts a new one.
 */
// (STOCKFISH_BIN may carry arguments, split on spaces: a local test engine "node --import tsx test/fake-stockfish.ts".)
let command: string[] | null = process.env.STOCKFISH_BIN ? process.env.STOCKFISH_BIN.trim().split(/\s+/) : null;
let proc: ChildProcessWithoutNullStreams | null = null;
let started: Promise<void> | null = null;
let pending = "";
let listener: ((line: string) => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** The tests' own engine (a command and its arguments), or none. */
export function setEngineCommand(next: string[] | null) {
  command = next;
  stopEngine();
}

export const engineAvailable = () => command !== null;

export function stopEngine() {
  proc?.kill();
  proc = null;
  started = null;
}

function send(line: string) {
  proc?.stdin.write(`${line}\n`);
}

/** The engine's lines until one passes [done] (all of them, that one last); [ms] at most. */
function until(done: (line: string) => boolean, ms: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const timer = setTimeout(() => {
      listener = null;
      stopEngine(); // (hung: a new one next time)
      reject(new Error("engine: no answer"));
    }, ms);
    listener = (line) => {
      lines.push(line);
      if (!done(line)) return;
      clearTimeout(timer);
      listener = null;
      resolve(lines);
    };
  });
}

function ready(): Promise<void> {
  if (started) return started;
  if (!command) return Promise.reject(new Error("engine: none"));
  const [bin, ...args] = command;
  const p = spawn(bin, args);
  proc = p;
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) listener?.(line.trim());
  });
  p.on("error", (e) => console.error("engine:", e.message));
  p.on("exit", () => {
    if (proc === p) stopEngine();
  });
  started = (async () => {
    const ok = until((l) => l === "uciok", 10_000);
    send("uci");
    await ok;
    send("setoption name Threads value 1");
    send("setoption name Hash value 16");
    const isReady = until((l) => l === "readyok", 10_000);
    send("isready");
    await isReady;
  })();
  started.catch(() => stopEngine());
  return started;
}

/** One job at a time, in the order asked. */
function job<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/** Stockfish's weakest and strongest ratings (UCI_Elo). */
export const ENGINE_ELO = { min: 1320, max: 3190 };

/** Its move in [fen] ("e2e4"), playing at [elo], thinking [ms]. */
export const engineMove = (fen: string, elo: number, ms = 500): Promise<string | null> =>
  job(async () => {
    await ready();
    const limit = elo < ENGINE_ELO.max;
    send(`setoption name UCI_LimitStrength value ${limit}`);
    if (limit) send(`setoption name UCI_Elo value ${Math.max(ENGINE_ELO.min, Math.round(elo))}`);
    send("setoption name MultiPV value 1");
    send(`position fen ${fen}`);
    const lines = until((l) => l.startsWith("bestmove"), ms + 5000);
    send(`go movetime ${ms}`);
    const best = (await lines).at(-1)!.split(" ")[1];
    return best && best !== "(none)" ? best : null;
  });

/** One line the engine sees: its score for the side to move (centipawns, or mate in n: negative, he's mated), its moves. */
export type EngineLine = { cp?: number; mate?: number; pv: string[] };

/** Its full-strength view of [fen]: its [lines] best lines, thinking [ms]. */
export const engineEval = (fen: string, ms = 800, lines = 1): Promise<{ depth: number; lines: EngineLine[] }> =>
  job(async () => {
    await ready();
    send("setoption name UCI_LimitStrength value false");
    send(`setoption name MultiPV value ${lines}`);
    send(`position fen ${fen}`);
    const out = until((l) => l.startsWith("bestmove"), ms + 5000);
    send(`go movetime ${ms}`);
    const found: EngineLine[] = [];
    let depth = 0;
    for (const l of await out) {
      if (!l.startsWith("info ") || !l.includes(" pv ")) continue;
      const word = (key: string) => {
        const t = l.split(" ");
        const i = t.indexOf(key);
        return i >= 0 ? t[i + 1] : undefined;
      };
      const k = Number(word("multipv") ?? 1) - 1;
      const score = l.match(/ score (cp|mate) (-?\d+)/);
      if (!score) continue;
      depth = Math.max(depth, Number(word("depth") ?? 0));
      found[k] = { ...(score[1] === "cp" ? { cp: Number(score[2]) } : { mate: Number(score[2]) }), pv: l.split(" pv ")[1].split(" ") };
    }
    return { depth, lines: found.filter(Boolean) };
  });

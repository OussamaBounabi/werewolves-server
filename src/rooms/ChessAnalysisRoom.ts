import { Room, Client, ServerError } from "colyseus";
import { accountFor, accountsEnabled, type Account } from "../accounts.js";
import { chessEnd, fen, fromUci, inCheck, kingOf, legalMoves, makeMove, posKey, san, startPos, uci, type ChessPos } from "../chess.js";
import { engineAvailable, engineEval, type EngineLine } from "../engine.js";
import { review, type Seen } from "../review.js";

/**
 * The analysis board (chess): a game's moves (its main line) and the variations its owner tries, as a tree; he walks
 * it and plays moves (checked against the rules), and whoever joins by its id watches him. Private (never listed),
 * gone once empty. A new owner when he leaves: the first of those watching. One watching may ask to move the board
 * ("ask_lead"): the owner is asked ("lead_asked") and answers ("give_lead"); a yes makes him the owner ("lead_answer").
 * create("chess_analysis", { idToken?, moves: ["e2e4", …], white?, black?, result? }); joinById(id) to watch.
 * To everyone as "analysis": the tree, where the owner is, the board there and (his) moves from it.
 * The engine (VIP Pro: the owner's account): the position's score (white's) and best line as he walks the tree, and on
 * "review" the game's review (its main line): each move's mark, each side's accuracy and estimated rating. Those
 * watching him see them too.
 */
type Node = { id: number; parent: number; uci: string; san: string; from: number; to: number; ply: number; children: number[] };
type Options = { idToken?: string; name?: string; moves?: unknown; white?: unknown; black?: unknown; result?: unknown };
/** The engine's view of a position, for white: centipawns or a mate in n (negative: white is mated), its best line. */
type Eval = { cp?: number; mate?: number; line: string[]; depth: number };

const EVAL_MS = 700; // the live score, each position
const REVIEW_MS = 250; // each position of a review

const MAX_NODES = 2000; // a tree no bigger (moves past it are refused)
const MAX_WATCHERS = 10;

export class ChessAnalysisRoom extends Room {
  maxClients = 1 + MAX_WATCHERS;
  private nodes: Node[] = [{ id: 0, parent: -1, uci: "", san: "", from: -1, to: -1, ply: 0, children: [] }];
  private positions = new Map<number, ChessPos>([[0, startPos()]]);
  private current = 0;
  private owner = "";
  private header = { white: "", black: "", result: "" };
  private names = new Map<string, string>(); // session → name
  private pros = new Set<string>(); // sessions of VIP Pro accounts
  private asks = new Set<string>(); // watchers asking to move the board
  private evals = new Map<number, Eval>();
  private evaluating = false;
  private reviewed: (ReturnType<typeof review> & { nodes: number[] }) | null = null;
  private reviewing: { done: number; total: number } | null = null;
  static proForAll = process.env.ANALYSIS_PRO_FOR_ALL === "1"; // tests and a local server: everyone is VIP Pro

  async onAuth(_client: Client, options: Options = {}): Promise<{ account: Account | null }> {
    if (!options.idToken || !accountsEnabled) return { account: null };
    try {
      return { account: await accountFor(String(options.idToken)) };
    } catch {
      throw new ServerError(4401, "auth");
    }
  }

  onCreate(options: Options = {}) {
    this.setPrivate(true).catch(() => {});
    const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 40) : "");
    this.header = { white: text(options.white), black: text(options.black), result: text(options.result) };
    // The game's moves: the main line, as far as they are legal.
    let at = 0;
    for (const m of Array.isArray(options.moves) ? options.moves.slice(0, 600) : []) {
      const next = this.add(at, String(m));
      if (next < 0) break;
      at = next;
    }
    this.current = at; // it opens where the game ended
    this.onMessage("go", (client, msg: { node?: number }) => {
      if (client.sessionId !== this.owner || !this.nodes[Number(msg?.node)]) return;
      this.current = Number(msg.node);
      this.sync();
    });
    this.onMessage("ask_lead", (client) => {
      const id = client.sessionId;
      if (id === this.owner || this.asks.has(id)) return;
      this.asks.add(id);
      this.clients.getById(this.owner)?.send("lead_asked", { id, name: this.names.get(id) ?? "" });
      this.sync();
    });
    this.onMessage("give_lead", (client, msg: { id?: string; yes?: boolean }) => {
      const id = String(msg?.id ?? "");
      if (client.sessionId !== this.owner || !this.asks.delete(id)) return;
      if (msg.yes === true && this.clients.getById(id)) this.owner = id;
      this.clients.getById(id)?.send("lead_answer", { yes: msg.yes === true, by: this.names.get(client.sessionId) ?? "" });
      this.sync();
    });
    this.onMessage("review", (client) => {
      if (client.sessionId !== this.owner || !this.ownerPro() || this.reviewing || this.reviewed) return;
      this.runReview().catch((e) => {
        console.error("analysis: review failed", e);
        this.reviewing = null;
        this.broadcast("analysis_error", { code: "review" });
        this.sync();
      });
    });
    this.onMessage("move", (client, msg: { from?: number; to?: number; promo?: string }) => {
      if (client.sessionId !== this.owner) return;
      const pos = this.positions.get(this.current)!;
      const m = legalMoves(pos).find((x) => x.from === msg?.from && x.to === msg?.to && (x.promo ?? "") === (msg?.promo ?? ""));
      if (!m) return client.send("analysis_error", { code: "illegal" });
      const next = this.add(this.current, uci(m));
      if (next < 0) return client.send("analysis_error", { code: "full" });
      this.current = next;
      this.sync();
    });
  }

  /** The move [text] from [parent]: the child already there, or a new one (-1: illegal, or the tree is full). */
  private add(parent: number, text: string): number {
    const same = this.nodes[parent].children.find((c) => this.nodes[c].uci === text);
    if (same !== undefined) return same;
    const pos = this.positions.get(parent)!;
    const m = fromUci(pos, text);
    if (!m || this.nodes.length >= MAX_NODES) return -1;
    const node: Node = { id: this.nodes.length, parent, uci: text, san: san(pos, m), from: m.from, to: m.to, ply: this.nodes[parent].ply + 1, children: [] };
    this.nodes.push(node);
    this.nodes[parent].children.push(node.id); // (the first child is the line, the others its variations)
    this.positions.set(node.id, makeMove(pos, m));
    return node.id;
  }

  onJoin(client: Client, options: Options = {}) {
    const account: Account | null = client.auth?.account ?? null;
    this.names.set(client.sessionId, account?.name ?? (String(options.name ?? "").slice(0, 24) || "?"));
    if (account?.vipPro || ChessAnalysisRoom.proForAll) this.pros.add(client.sessionId);
    if (!this.owner) this.owner = client.sessionId;
    this.sync();
  }

  onLeave(client: Client) {
    this.names.delete(client.sessionId);
    this.pros.delete(client.sessionId);
    this.asks.delete(client.sessionId);
    if (this.owner === client.sessionId) this.owner = this.clients.find((c) => c.sessionId !== client.sessionId)?.sessionId ?? "";
    this.sync();
  }

  private ownerPro() {
    return this.pros.has(this.owner) && engineAvailable();
  }

  /** The engine's lines in [pos] for white, the best one in moves as players read them. */
  private static forWhite(pos: ChessPos, line: EngineLine | undefined, depth: number): Eval {
    const sign = pos.turn === 0 ? 1 : -1;
    const moves: string[] = [];
    let at = pos;
    for (const text of line?.pv.slice(0, 8) ?? []) {
      const m = fromUci(at, text);
      if (!m) break;
      moves.push(san(at, m));
      at = makeMove(at, m);
    }
    if (!line) return { cp: 0, line: [], depth };
    return { ...(line.mate !== undefined ? { mate: sign * line.mate } : { cp: sign * (line.cp ?? 0) }), line: moves, depth };
  }

  /** The score where the owner is (VIP Pro), once a position: told to everyone when it comes. */
  private evaluate() {
    const id = this.current;
    if (!this.ownerPro() || this.evaluating || this.evals.has(id)) return;
    const pos = this.positions.get(id)!;
    if (legalMoves(pos).length === 0) {
      // Over: checkmate (the side to move lost: ±10000, the apps' "#"), or stalemate.
      this.evals.set(id, { cp: inCheck(pos) ? (pos.turn === 0 ? -10_000 : 10_000) : 0, line: [], depth: 0 });
      return;
    }
    this.evaluating = true;
    engineEval(fen(pos, this.nodes[id].ply), EVAL_MS, 1)
      .then(({ depth, lines }): void => void this.evals.set(id, ChessAnalysisRoom.forWhite(pos, lines[0], depth)))
      .catch((): void => {})
      .finally(() => {
        this.evaluating = false;
        this.sync(); // (and the owner's next position, if he moved meanwhile)
      });
  }

  /** The main line, from the start. */
  private mainLine(): number[] {
    const line = [0];
    while (this.nodes[line.at(-1)!].children.length) line.push(this.nodes[line.at(-1)!].children[0]);
    return line;
  }

  /** The review: the engine on every position of the main line (two lines each), then the marks and the accuracies. */
  private async runReview() {
    const line = this.mainLine();
    this.reviewing = { done: 0, total: line.length };
    this.sync();
    const seen: Seen[] = [];
    for (const id of line) {
      const pos = this.positions.get(id)!;
      if (legalMoves(pos).length === 0) {
        seen.push({ best: "", score: inCheck(pos) ? { mate: -1 } : { cp: 0 } }); // (mated, or stalemate)
      } else {
        const { lines } = await engineEval(fen(pos, this.nodes[id].ply), REVIEW_MS, 2);
        const [first, second] = lines;
        seen.push({ best: first?.pv[0] ?? "", score: first ?? { cp: 0 }, ...(second ? { second } : {}) });
      }
      this.reviewing = { done: seen.length, total: line.length };
      this.sync();
    }
    const positions = line.map((id) => this.positions.get(id)!);
    const moves = line.slice(1).map((id, i) => ({ uci: this.nodes[id].uci, move: fromUci(positions[i], this.nodes[id].uci)! }));
    this.reviewed = { ...review(positions, moves, seen), nodes: line.slice(1) };
    this.reviewing = null;
    this.sync();
  }

  /** The keys of the positions on the way to [id] (the draw by repetition). */
  private keysTo(id: number): string[] {
    const keys: string[] = [];
    for (let n = id; n >= 0; n = this.nodes[n].parent) keys.unshift(posKey(this.positions.get(n)!));
    return keys;
  }

  private sync() {
    const pos = this.positions.get(this.current)!;
    const end = chessEnd(pos, this.keysTo(this.current));
    const node = this.nodes[this.current];
    const table = {
      owner: this.owner,
      watchers: [...this.names].filter(([id]) => id !== this.owner).map(([, name]) => name),
      ownerName: this.names.get(this.owner) ?? "",
      asking: [...this.asks], // (an asker's app shows "asked")
      header: this.header,
      nodes: this.nodes.map(({ id, parent, san, ply, children }) => ({ id, parent, san, ply, children })),
      current: this.current,
      board: pos.board,
      turn: pos.turn,
      check: inCheck(pos) ? kingOf(pos.board, pos.turn) : -1,
      last: node.from >= 0 ? { from: node.from, to: node.to } : null,
      end: end?.end ?? "",
      pro: this.ownerPro(), // the engine is on (the owner's a VIP Pro and this server has it)
      eval: this.evals.get(this.current) ?? null,
      reviewing: this.reviewing,
      review: this.reviewed
        ? {
            marks: this.reviewed.nodes.map((node, i) => ({ node, mark: this.reviewed!.marks[i] })),
            white: this.reviewed.white,
            black: this.reviewed.black,
          }
        : null,
    };
    const moves = end ? [] : legalMoves(pos).map((m) => (m.promo ? [m.from, m.to, m.promo] : [m.from, m.to]));
    for (const client of this.clients) {
      client.send("analysis", { ...table, me: client.sessionId, moves: client.sessionId === this.owner ? moves : [] });
    }
    this.evaluate();
  }
}

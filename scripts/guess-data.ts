/**
 * Builds Guess Who's catalogue from the big five leagues' current squads:
 *  - each club's English Wikipedia page: shirt number, position, nationality (its "current squad" table)
 *    and kit colors (the club's badge is drawn from them);
 *  - Wikidata (CC0): names in Arabic and French, and fame (how many Wikipedias have an article) — the best
 *    known players make the game.
 * Portraits (3D, made separately) go in data/guess/img/<wikidata id>.webp: a player shows his once it's there.
 *
 *   FLAGS_DIR=../WereWolves/assets/images/flags npx tsx scripts/guess-data.ts
 *
 * Writes data/guess/catalog.json; FLAGS_DIR gets every nation's flag (flagcdn.com, public domain).
 * Re-run after a transfer window.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SEASON = "2026–27";
const TOP = 250;
const UA = "PlayRoomGuessWho/1.0 (https://github.com/OussamaBounabi/werewolves-server)";
const OUT = "data/guess";
const FLAGS_DIR = process.env.FLAGS_DIR;

type Names = { en: string; fr: string; ar: string };

const LEAGUES: { id: string; page: string; flag: string; name: Names }[] = [
  { id: "eng", page: "Premier League", flag: "gb-eng", name: { en: "Premier League", fr: "Premier League", ar: "الدوري الإنجليزي الممتاز" } },
  { id: "esp", page: "La Liga", flag: "es", name: { en: "LaLiga", fr: "LaLiga", ar: "الدوري الإسباني" } },
  { id: "ita", page: "Serie A", flag: "it", name: { en: "Serie A", fr: "Serie A", ar: "الدوري الإيطالي" } },
  { id: "ger", page: "Bundesliga", flag: "de", name: { en: "Bundesliga", fr: "Bundesliga", ar: "الدوري الألماني" } },
  { id: "fra", page: "Ligue 1", flag: "fr", name: { en: "Ligue 1", fr: "Ligue 1", ar: "الدوري الفرنسي" } },
];

/** FIFA's 211 members: code and flag (ISO 3166, flagcdn's names), by confederation. */
const MEMBERS = `
UEFA: ALB al, AND ad, ARM am, AUT at, AZE az, BLR by, BEL be, BIH ba, BUL bg, CRO hr, CYP cy, CZE cz, DEN dk,
  ENG gb-eng, EST ee, FRO fo, FIN fi, FRA fr, GEO ge, GER de, GIB gi, GRE gr, HUN hu, ISL is, ISR il, ITA it,
  KAZ kz, KVX xk, LVA lv, LIE li, LTU lt, LUX lu, MLT mt, MDA md, MNE me, NED nl, MKD mk, NIR gb-nir, NOR no,
  POL pl, POR pt, IRL ie, ROU ro, RUS ru, SMR sm, SCO gb-sct, SRB rs, SVK sk, SVN si, ESP es, SWE se, SUI ch,
  TUR tr, UKR ua, WAL gb-wls
CONMEBOL: ARG ar, BOL bo, BRA br, CHI cl, COL co, ECU ec, PAR py, PER pe, URU uy, VEN ve
CONCACAF: AIA ai, ATG ag, ARU aw, BAH bs, BRB bb, BLZ bz, BER bm, VGB vg, CAN ca, CAY ky, CRC cr, CUB cu,
  CUW cw, DMA dm, DOM do, SLV sv, GRN gd, GUA gt, GUY gy, HAI ht, HON hn, JAM jm, MEX mx, MSR ms, NCA ni,
  PAN pa, PUR pr, SKN kn, LCA lc, VIN vc, SUR sr, TRI tt, TCA tc, USA us, VIR vi
CAF: ALG dz, ANG ao, BEN bj, BOT bw, BFA bf, BDI bi, CMR cm, CPV cv, CTA cf, CHA td, COM km, CGO cg, COD cd,
  DJI dj, EGY eg, EQG gq, ERI er, SWZ sz, ETH et, GAB ga, GAM gm, GHA gh, GUI gn, GNB gw, CIV ci, KEN ke,
  LES ls, LBR lr, LBY ly, MAD mg, MWI mw, MLI ml, MTN mr, MRI mu, MAR ma, MOZ mz, NAM na, NIG ne, NGA ng,
  RWA rw, STP st, SEN sn, SEY sc, SLE sl, SOM so, RSA za, SSD ss, SDN sd, TAN tz, TOG tg, TUN tn, UGA ug,
  ZAM zm, ZIM zw
AFC: AFG af, AUS au, BHR bh, BAN bd, BHU bt, BRU bn, CAM kh, CHN cn, TPE tw, GUM gu, HKG hk, IND in, IDN id,
  IRN ir, IRQ iq, JPN jp, JOR jo, KOR kr, PRK kp, KUW kw, KGZ kg, LAO la, LIB lb, MAC mo, MAS my, MDV mv,
  MNG mn, MYA mm, NEP np, OMA om, PAK pk, PLE ps, PHI ph, QAT qa, KSA sa, SIN sg, SRI lk, SYR sy, TJK tj,
  THA th, TLS tl, TKM tm, UAE ae, UZB uz, VIE vn, YEM ye
OFC: ASA as, COK ck, FIJ fj, NCL nc, NZL nz, PNG pg, SAM ws, SOL sb, TAH pf, TGA to, VAN vu
`;
const ALIASES: Record<string, string> = { KOS: "KVX" }; // Wikipedia's spelling → FIFA's
// Wikidata items for the flags no ISO code names.
const NATION_ITEMS: Record<string, string> = { "gb-eng": "Q21", "gb-sct": "Q22", "gb-wls": "Q25", "gb-nir": "Q26", xk: "Q1246" };
const NAME_FIXES: Record<string, Partial<Names>> = { CHN: { en: "China" }, TPE: { en: "Chinese Taipei" } };
const POSITIONS: Record<string, string> = { GK: "GK", DF: "DEF", MF: "MID", FW: "ATT" };
/** Badge colors where the kit's first color misleads (stripes, halves, sashes): club, main, second. */
const CLUB_COLORS = `
eng-BOU DA291C 000000, eng-LIV C8102E FFFFFF, eng-NEW 241F20 FFFFFF, eng-TOT FFFFFF 132257, eng-LEE FFFFFF 1D428A,
eng-CRY 1B458F C4122E, eng-HUL F5A12D 000000, eng-EVE 003399 FFFFFF, eng-SUN EB172B FFFFFF, eng-BRE E30613 FFFFFF,
esp-BAR A50044 004D98, esp-RMA FFFFFF FEBE10, esp-ATM CB3524 272E61, esp-ATH EE2523 FFFFFF, esp-CEL 8AC3EE FFFFFF,
esp-DEP 0055A5 FFFFFF, esp-ELC FFFFFF 05642C, esp-ESP 007FC8 FFFFFF, esp-OSA D91A21 0A346F, esp-ALA 0761AF FFFFFF,
esp-RAC FFFFFF 00A650, esp-RAY FFFFFF E53027, esp-LEV B4053F 004A9F, esp-MAL 0A5DA6 FFFFFF, esp-VIL FFE667 005187,
ita-JUV 000000 FFFFFF, ita-INT 010E80 000000, ita-MIL FB090B 000000, ita-NAP 12A0D7 FFFFFF, ita-ATA 1E71B8 000000,
ita-UDI FFFFFF 000000, ita-ROM 8E1F2F F0BC42, ita-BOL A21C26 1A2F48, ita-GEN AD1919 001E50, ita-CAG 0E2A51 AD1919,
ita-VEN 000000 F26522, ita-PAR FFD200 1B4094, ita-LEC FFD700 D7191F, ita-FRO FFD800 004C97,
ger-LEV E32221 000000, ger-FRA E1000F 000000, ger-STU FFFFFF E32219, ger-KOL FFFFFF ED1C24, ger-MON FFFFFF 00A651,
ger-HAM FFFFFF 0A3F86, ger-BRE 1D9053 FFFFFF, ger-PAD 005BAB 000000, ger-ELV 000000 FFFFFF,
fra-PSG 004170 DA291C, fra-OM FFFFFF 2FAEE0, fra-OL FFFFFF 14387F, fra-LEN FFD700 E30613, fra-STR 009FE3 FFFFFF,
fra-TRO 004B9C FFFFFF, fra-LOR F58113 000000, fra-AUX FFFFFF 0068A8
`;
const CLUB_SHORT: Record<string, string> = { "ger-KOL": "KOE", "ger-MON": "BMG" };
const clubColors = new Map(
  CLUB_COLORS.trim().split(/,\s*/).map((e) => {
    const [id, a, b] = e.split(/\s+/);
    return [id, [a, b] as [string, string]];
  }),
);

const nations = MEMBERS.trim()
  .split(/\n(?=[A-Z]+:)/)
  .flatMap((block) => {
    const [conf, list] = block.split(":");
    return list.split(",").map((pair) => {
      const [id, flag] = pair.trim().split(/\s+/);
      return { id, flag, conf: conf.trim() };
    });
  });
const nationIds = new Set(nations.map((n) => n.id));

/** A name without the encyclopedia's note in brackets: "Nuno Mendes (footballer, born 2002)" → "Nuno Mendes". */
const plain = (name: string) => name.replace(/\s*\(.*\)\s*$/, "").trim() || name;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) } });
    if (res.ok) return res;
    if (attempt >= 4 || (res.status < 500 && res.status !== 429)) throw new Error(`${res.status} ${url}`);
    await sleep(3000 * (attempt + 1));
  }
}
const getJson = async (url: string, init?: RequestInit): Promise<any> => (await get(url, init)).json();
const wikiApi = (params: Record<string, string>) =>
  getJson("https://en.wikipedia.org/w/api.php?" + new URLSearchParams({ format: "json", formatversion: "2", ...params }));

async function wikitext(title: string): Promise<string> {
  const j = await wikiApi({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", redirects: "1", titles: title });
  return j.query.pages[0]?.revisions?.[0]?.slots?.main?.content ?? "";
}

/** Every {{name ...}} in [text], nested templates and links included. */
function templates(text: string, name: RegExp): string[] {
  const found: string[] = [];
  const re = new RegExp(`\\{\\{\\s*(?:${name.source})\\s*\\|`, "gi");
  for (let m; (m = re.exec(text)); ) {
    let depth = 0, i = m.index;
    for (; i < text.length - 1; i++) {
      if (text.startsWith("{{", i)) (depth++, i++);
      else if (text.startsWith("}}", i) && --depth === 0) break;
      else if (text.startsWith("}}", i)) i++;
    }
    found.push(text.slice(m.index, i + 2));
  }
  return found;
}

/** A template's named parameters (the pipes inside its links and nested templates kept). */
function params(tpl: string): Record<string, string> {
  const inner = tpl.slice(2, -2), parts: string[] = [];
  let depth = 0, cur = "";
  for (let i = 0; i < inner.length; i++) {
    const two = inner.slice(i, i + 2);
    if (two === "[[" || two === "{{") (depth++, (cur += two), i++);
    else if (two === "]]" || two === "}}") (depth--, (cur += two), i++);
    else if (inner[i] === "|" && depth === 0) (parts.push(cur), (cur = ""));
    else cur += inner[i];
  }
  parts.push(cur);
  const out: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) out[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
  }
  return out;
}

/** "[[Title|Name]]" or "{{sortname|First|Last|Title}}" → the article and the name shown. */
function personLink(v: string): { title: string; name: string } | null {
  let m = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(v);
  if (m) return { title: m[1].trim(), name: (m[2] ?? m[1].replace(/\s*\(.*\)$/, "")).trim() };
  m = /\{\{\s*sortname\s*\|([^|}]*)\|([^|}]*)(?:\|([^|}]*))?/i.exec(v);
  if (!m) return null;
  const name = `${m[1].trim()} ${m[2].trim()}`.trim();
  const link = m[3]?.trim();
  return { title: link && !link.includes("=") ? link : name, name };
}

/** The first team's rows: "current squad" / "first-team squad" sections, not the loans, reserves or youth
 * (nor anything under them: a B team's own "current squad"). */
function squadRows(text: string): string[] {
  const rows: string[] = [];
  let take = false, chunk: string[] = [];
  let skipping = 99; // the level of the excluded section we're in
  const flush = () => {
    if (take) rows.push(...templates(chunk.join("\n"), /fs player|football squad player/));
    chunk = [];
  };
  for (const line of text.split("\n")) {
    const h = /^(={2,6})(.+?)\1\s*$/.exec(line.replace(/<!--.*?-->/g, "").trimEnd());
    if (!h) {
      chunk.push(line);
      continue;
    }
    flush();
    const level = h[1].length;
    const name = h[2].replace(/<[^>]*>/g, "").replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1").trim().toLowerCase();
    if (level <= skipping) skipping = 99;
    if (/loan|reserve|youth|academy|women|under|retired|former|notable|second|development|\bii\b|\bb\b|u-?\d/.test(name)) {
      skipping = Math.min(skipping, level);
    }
    take = skipping === 99 && /squad|current|first[- ]team|players/.test(name);
  }
  flush();
  return rows;
}

async function leagueClubs(league: (typeof LEAGUES)[number]) {
  for (const title of [`${SEASON} ${league.page}`, `Template:${SEASON} ${league.page} table`]) {
    const found = new Map<string, { code: string; title: string; short: string }>();
    for (const m of (await wikitext(title)).matchAll(/\|\s*name_([^\s=|]+)\s*=\s*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
      found.set(m[2], { code: m[1], title: m[2], short: (m[3] ?? m[2]).trim() });
    }
    if (found.size >= 16) return [...found.values()];
  }
  throw new Error(`no clubs found for ${league.page}`);
}

/** Wikipedia titles → their article (redirects followed) and Wikidata item. */
async function pages(titles: string[]) {
  const out = new Map<string, { title: string; item?: string }>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const j = await wikiApi({ action: "query", redirects: "1", titles: batch.join("|"), prop: "pageprops", ppprop: "wikibase_item" });
    const hop = new Map<string, string>();
    for (const r of [...(j.query.normalized ?? []), ...(j.query.redirects ?? [])]) hop.set(r.from, r.to);
    const byTitle = new Map<string, any>((j.query.pages ?? []).map((p: any) => [p.title, p]));
    for (const t of batch) {
      let to = t;
      for (let k = 0; k < 3 && hop.has(to); k++) to = hop.get(to)!;
      const p = byTitle.get(to);
      if (p && !p.missing) out.set(t, { title: p.title, item: p.pageprops?.wikibase_item });
    }
  }
  return out;
}

/** Wikidata: fame (sitelinks) and the French and Arabic names of [items]. */
async function wikidata(items: string[]) {
  const out = new Map<string, { links: number; fr?: string; ar?: string; en?: string }>();
  for (let i = 0; i < items.length; i += 250) {
    const values = items.slice(i, i + 250).map((q) => `wd:${q}`).join(" ");
    const query = `SELECT ?item ?links ?en ?fr ?ar WHERE { VALUES ?item { ${values} }
      ?item wikibase:sitelinks ?links .
      OPTIONAL { ?item rdfs:label ?en FILTER(lang(?en)="en") }
      OPTIONAL { ?item rdfs:label ?fr FILTER(lang(?fr)="fr") }
      OPTIONAL { ?item rdfs:label ?ar FILTER(lang(?ar)="ar") } }`;
    const j = await getJson("https://query.wikidata.org/sparql", {
      method: "POST",
      headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query }).toString(),
    });
    for (const b of j.results.bindings) {
      const q = b.item.value.split("/").pop();
      out.set(q, { links: Number(b.links.value), en: b.en?.value, fr: b.fr?.value, ar: b.ar?.value });
    }
  }
  return out;
}

async function nationNames() {
  const iso = nations.filter((n) => !NATION_ITEMS[n.flag]).map((n) => `"${n.flag.toUpperCase()}"`).join(" ");
  const query = `SELECT ?code ?links ?en ?fr ?ar WHERE {
      { VALUES ?code { ${iso} } ?c wdt:P297 ?code . }
      UNION { VALUES (?c ?code) { ${Object.entries(NATION_ITEMS).map(([f, q]) => `(wd:${q} "${f}")`).join(" ")} } }
      ?c wikibase:sitelinks ?links .
      OPTIONAL { ?c rdfs:label ?en FILTER(lang(?en)="en") }
      OPTIONAL { ?c rdfs:label ?fr FILTER(lang(?fr)="fr") }
      OPTIONAL { ?c rdfs:label ?ar FILTER(lang(?ar)="ar") } }`;
  const j = await getJson("https://query.wikidata.org/sparql", {
    method: "POST",
    headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ query }).toString(),
  });
  const best = new Map<string, any>(); // an ISO code on several items: the best known one
  for (const b of j.results.bindings) {
    const code = b.code.value.toLowerCase();
    if (!best.has(code) || Number(b.links.value) > Number(best.get(code).links.value)) best.set(code, b);
  }
  return best;
}

const hex = (c: string | undefined) => (c && /^[0-9A-F]{6}$/i.test(c) ? c.toUpperCase() : undefined);
const light = (c: string) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
};
const far = (a: string, b: string) => {
  const d = [0, 2, 4].reduce((s, i) => s + Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)), 0);
  return d > 120;
};

/** The badge's two colors: the shirt, and the first part of the kit that stands out from it. */
function kitColors(text: string): [string, string] {
  const kit = (k: string) => hex(new RegExp(`\\|\\s*${k}\\s*=\\s*#?([0-9A-Fa-f]{6})\\b`).exec(text)?.[1]);
  const body = kit("body1") ?? "333333";
  const second = ["shorts1", "leftarm1", "socks1"].map(kit).find((c) => c && far(c, body));
  return [body, second ?? (light(body) ? "1A1A1A" : "FFFFFF")];
}

async function main() {
  mkdirSync(`${OUT}/img`, { recursive: true });

  // ---- the clubs and their squads ----
  const clubs: any[] = [];
  const rows: { title: string; name: string; num: number; pos: string; nation: string; club: string }[] = [];
  const seen = new Set<string>();
  for (const league of LEAGUES) {
    for (const c of await leagueClubs(league)) {
      const text = await wikitext(c.title);
      const code = c.code.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase(); // KÖL → KOL
      const id = `${league.id}-${code}`;
      const short = CLUB_SHORT[id] ?? code;
      clubs.push({ id, league: league.id, short, title: c.title, en: c.short, colors: clubColors.get(id) ?? kitColors(text) });
      let n = 0;
      for (const row of squadRows(text)) {
        const p = params(row);
        const who = personLink(p.name ?? "");
        const num = Number.parseInt(p.no ?? "", 10);
        const nation = ALIASES[p.nat?.toUpperCase()] ?? p.nat?.toUpperCase();
        if (!who || !Number.isInteger(num) || !POSITIONS[p.pos?.toUpperCase()] || !nationIds.has(nation)) continue;
        if (seen.has(who.title)) continue; // listed twice (a loan): the first club
        seen.add(who.title);
        rows.push({ ...who, num, pos: POSITIONS[p.pos.toUpperCase()], nation, club: id });
        n++;
      }
      console.log(`${id.padEnd(8)} ${String(n).padStart(2)} players  ${c.title}`);
      if (n < 15) console.warn(`  !! few players found for ${c.title}`);
    }
  }

  // ---- who they are: Wikidata items, fame, names ----
  const pageInfo = await pages([...rows.map((r) => r.title), ...clubs.map((c) => c.title)]);
  const items = [...new Set([...pageInfo.values()].map((p) => p.item).filter((q): q is string => !!q))];
  const data = await wikidata(items);
  const ranked = rows
    .map((r) => ({ ...r, page: pageInfo.get(r.title) }))
    .filter((r) => r.page?.item && data.has(r.page.item))
    .sort((a, b) => data.get(b.page!.item!)!.links - data.get(a.page!.item!)!.links)
    .slice(0, TOP);

  const players = ranked.map((r) => {
    const q = r.page!.item!;
    const d = data.get(q)!;
    return {
      id: q,
      name: { en: plain(r.name), fr: plain(d.fr ?? r.name), ar: plain(d.ar ?? r.name) },
      pos: r.pos,
      nation: r.nation,
      club: r.club,
      num: r.num,
      photo: existsSync(`${OUT}/img/${q}.webp`), // his 3D portrait, once made
    };
  });

  // ---- names: clubs, nations ----
  const outClubs = clubs.map((c) => {
    const d = data.get(pageInfo.get(c.title)?.item ?? "");
    const ar = d?.ar?.replace(/^نادي\s+/, "") || c.en; // "نادي" (club) in front of most
    return { id: c.id, league: c.league, short: c.short, colors: c.colors, name: { en: plain(c.en), fr: plain(d?.fr ?? c.en), ar: plain(ar) } };
  });
  const names = await nationNames();
  const outNations = nations.map((n) => {
    const b = names.get(n.flag);
    const name = { en: b?.en?.value ?? n.id, fr: b?.fr?.value ?? b?.en?.value ?? n.id, ar: b?.ar?.value ?? b?.en?.value ?? n.id };
    return { id: n.id, flag: n.flag, conf: n.conf, name: { ...name, ...NAME_FIXES[n.id] } };
  });
  for (const n of outNations) if (n.name.en === n.id) console.warn(`  !! no name for nation ${n.id}`);

  const catalog = {
    version: new Date().toISOString().slice(0, 10),
    leagues: LEAGUES.map(({ id, flag, name }) => ({ id, flag, name })),
    clubs: outClubs,
    nations: outNations,
    players,
  };
  writeFileSync(`${OUT}/catalog.json`, JSON.stringify(catalog));
  console.log(`${players.length} players (${players.filter((p) => p.photo).length} with a portrait), ${outClubs.length} clubs`);

  // ---- the flags, for the app ----
  if (FLAGS_DIR) {
    mkdirSync(FLAGS_DIR, { recursive: true });
    for (const n of nations) {
      const file = join(FLAGS_DIR, `${n.flag}.webp`);
      if (!existsSync(file)) writeFileSync(file, Buffer.from(await (await get(`https://flagcdn.com/w160/${n.flag}.webp`)).arrayBuffer()));
    }
    console.log(`${nations.length} flags in ${FLAGS_DIR}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

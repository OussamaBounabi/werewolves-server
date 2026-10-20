/**
 * The info sheet's details (trust mode): born, retired, nationality, positions, clubs by season, trophies and the big
 * individual awards — for the legends and for the easy level's footballers. From each one's English Wikipedia
 * article (the infobox and the "Honours" section, titles won only), with the French and Arabic names from Wikidata;
 * then the corrections of data/guess/info-fixes.json (checked by hand: what Wikipedia's lists get wrong).
 *
 *   npx tsx scripts/legends-data.ts
 *
 * Writes the legends' into data/guess/legends.json (names, levels and photo credits kept) and the footballers' into
 * data/guess/player-info.json. Re-run after a season (titles won, a legend retiring).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { LEVELS } from "../src/guess.js";
import { getJson, pages, params, plain, templates, wikidata, wikitext } from "./guess-data.js";

type Names = { en: string; fr: string; ar: string };
type Honour = { name: Names; icon: string; years: string[] };
type Details = {
  born?: number; retired: number | null; nation?: string; positions: string[];
  clubs: { name: Names; from: number; to: number | null; loan?: true }[]; trophies: Honour[]; awards: Honour[];
};
/** A hand correction: honours dropped (by English name), renamed, their seasons set (or added when missing); clubs
 * dropped ("Name from": an amateur comeback after retiring); any field. */
type Fix = {
  drop?: string[];
  rename?: Record<string, Names>;
  dropClubs?: string[];
  set?: Record<string, { years: string[]; icon?: string; award?: boolean; fr?: string; ar?: string }>;
  born?: number; retired?: number | null; nation?: string; positions?: string[];
};
const LEGENDS = "data/guess/legends.json";
const PLAYERS = "data/guess/player-info.json";
const FIXES = "data/guess/info-fixes.json";

/** Which picture an honour gets in the info sheet: the first rule that matches its name (or its article). */
const ICONS: [string, RegExp][] = [
  ["best", /fifa world player|the best fifa men/i], // FIFA's own (not a magazine's "world player")
  ["ballon", /^(fifa )?ballon d'or(\/fifa ballon d'or)?$/i], // the real one only (not a country's "golden ball", nor a nomination)
  ["boot", /golden (shoe|boot)|top ?(goal)?scorer|pichichi|capocannoniere|torjäger|torschützen|meilleur buteur|artilheiro/i],
  ["glove", /golden glove|yashin|zamora|goalkeeper of the year|best goalkeeper|fifa goalkeeper/i],
  ["worldcup", /^fifa world cup$/i],
  ["olympic", /olympic/i],
  ["clubworld", /intercontinental cup|club world cup/i],
  ["ucl", /champions league|european cup$|^european champion clubs|libertadores|african cup of champions|asian club championship/i],
  ["continental", /european (football )?championship|euro \d|copa américa|africa cup of nations|african cup of nations|asian cup|gold cup|gulf cup|arab cup|confederations cup|nations league|south american championship/i],
  ["europa", /uefa cup|europa league|cup winners|intertoto|conference league|confederation cup|sudamericana|fairs cup/i],
  ["supercup", /super ?cup|supercopa|supercoppa|supercup|community shield|charity shield|trophée des champions|recopa|supertaça|johan cruyff shield/i],
  ["league", /supporters' shield|botola/i],
  ["olympic", /games/i],
  ["cup", /cup|copa|coppa|pokal|coupe|taça|beker|trophy|tournament|tournoi|torneio|finalissima/i],
  ["league", /league|liga|liha|serie [ab]|bundesliga|ligue|division|eredivisie|championship|campeonato|primeira|premiership|süper lig|pro league|championnat|brasileirão|primera|scudetto|torneo|apertura|clausura/i],
];
/** The individual awards worth showing (the rest — teams of the year, monthly awards, a club's own — left out). */
const AWARDS = /ballon d'or|world player of the year|the best fifa|golden (shoe|boot|ball|glove|boy)|top ?(goal)?scorer|pichichi|capocannoniere|torjäger|player of the year|footballer of the year|player of the season|best player|kopa|yashin|puskás award|most valuable/i;
/** Not a title won: a team of the year, a poll, a hall of fame, a manager's award, a youth title — or a nomination,
 * a placing, a record, a sentence. */
const NOT_WON =
  /\bXI\b|u-?\d\d\b|under[- ]?\d\d|youth|toulon|viareggio|dallas cup|meridian cup|syrenka|montaigu|future cup|copa amsterdam|junior|juvenil|kirin cup|umbro cup|lunar new year|four nations|beach soccer|military|nihl|regionalliga|oberliga|verbandsliga|play-offs|world 11|world series|squad of|fantasy|(midfielder|defender|forward) of the|best (midfielder|defender|forward)|HOO|fans[’']|pre-olympic|team of the|poll|order of merit|fifa 100|scania 100|manager of the year|coach of the year|hall of fame|dream team|all-star|nominat|nominee|shortlist|candidate|podium|place\b|silver|bronze|placed|runner|finalist|ranked|ranking|\b(2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\b|record|^most |^the only|^only |^first |fastest|longest|youngest|oldest|all-time|highest|appearances|goals in|consecutive|per game|in history|of the century|of all time|greatest|legend|prix d'honneur|nouveau palmarès|for services|lifetime|career award|honorary|retroactive|centennial|50 years|20 years|anniversary|special award/i;
/** A season's mention that isn't a win: "1996 (2nd)", "2003 (nominated)". */
const NOT_A_WIN = /\((?:[^)]*(?:2nd|3rd|4th|5th|6th|7th|8th|9th|10th|place|runner|nominat|shortlist|silver|bronze|finalist)[^)]*)\)/i;

/** The infobox's positions → the game's codes: the first rule that matches each one (specific before general). */
const POSITIONS: [string[], RegExp][] = [
  [["GK"], /goal ?keeper/i],
  [["LB"], /left[- ](full[- ])?back|left wing[- ]back/i],
  [["RB"], /right[- ](full[- ])?back|right wing[- ]back/i],
  [["LB", "RB"], /full[- ]back|wing[- ]back/i],
  [["CB"], /cent(re|er)[- ]back|central defender|sweeper|libero|defender/i],
  [["DMF"], /defensive midfielder|holding midfielder/i],
  [["AMF"], /attacking midfielder|playmaker|trequartista/i],
  [["LMF"], /left midfielder/i],
  [["RMF"], /right midfielder/i],
  [["LMF", "RMF"], /wide midfielder/i],
  [["CMF"], /midfielder|box-to-box|regista/i],
  [["LWF"], /left wing(er)?\b/i],
  [["RWF"], /right wing(er)?\b/i],
  [["LWF", "RWF"], /wing(er)?\b|inside forward/i],
  [["SS"], /second striker|support striker|shadow striker|false nine|deep-lying forward/i],
  [["CF"], /striker|cent(re|er)[- ]forward|forward/i],
];
const ORDER = ["GK", "CB", "LB", "RB", "DMF", "CMF", "AMF", "LMF", "RMF", "LWF", "RWF", "SS", "CF"];
/** "[[Midfielder#Attacking midfielder|Attacking midfielder]], [[Forward (association football)|second striker]]" → AMF, SS. */
function positions(v: string) {
  const out = new Set<string>();
  for (const part of shown(clean(v)).split(/,|\/|;|\bor\b|\band\b|\n|<br/i)) {
    const hit = POSITIONS.find(([, re]) => re.test(part));
    if (hit) hit[0].forEach((c) => out.add(c));
  }
  return ORDER.filter((c) => out.has(c));
}

const NATION_ALIASES: Record<string, string> = {
  netherlands: "NED", "ivory coast": "CIV", "republic of ireland": "IRL", "czechoslovakia": "CZE", "soviet union": "RUS",
  "west germany": "GER", saudi: "KSA", "yugoslavia": "SRB", "fr yugoslavia": "SRB", "serbia and montenegro": "SRB", "zaire": "COD",
};

/** "[[Juventus F.C.|Juventus]] (loan)" → its article and the text shown. */
const link = (v: string) => {
  const m = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(v);
  return m ? { title: m[1].trim(), text: (m[2] ?? m[1]).replace(/''+/g, "").trim() } : null;
};
/** Wikitext → plain text: refs, comments and templates dropped, links shown as their text. */
const clean = (v: string) =>
  v
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[\s\S]*?<\/ref>/g, "")
    .replace(/\{\{(?:nowrap|nobr)\|([^{}]*)\}\}/gi, "$1")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/<[^>]+>/g, "");
const shown = (v: string) =>
  v.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1").replace(/\[\[[^\]|]*\|/g, "").replace(/''+/g, "").trim(); // (a link left half-written too)

function career(text: string) {
  const box = templates(text, /infobox football biography/)[0];
  if (!box) return null;
  const p = params(box);
  const born = Number(/\b(1[89]\d\d|20\d\d)\b/.exec(p.birth_date ?? "")?.[1]) || undefined;
  const clubs: { title: string; text: string; from: number; to: number | null; loan?: true }[] = [];
  for (let i = 1; i <= 50; i++) {
    const c = p[`clubs${i}`], y = p[`years${i}`];
    if (!c || !y) continue;
    const l = link(clean(c));
    const m = /(\d{4})\s*(?:–|-|&ndash;)?\s*(\d{4})?/.exec(clean(y));
    if (!l || !m) continue;
    const open = !m[2] && /[–-]\s*$/.test(clean(y).trim());
    clubs.push({ ...l, from: Number(m[1]), to: m[2] ? Number(m[2]) : open ? null : Number(m[1]), ...(/loan/i.test(c) ? { loan: true as const } : {}) });
  }
  const active = clubs.some((c) => c.to === null); // "2023–": still playing (a loan listed after it ends; a coach's club doesn't count)
  const retired = active ? null : Math.max(...clubs.map((c) => c.to ?? 0)) || null;
  // every senior national team he played for (a region's or a school's too: the first real nation is kept)
  const nations: string[] = [];
  for (let i = 1; i <= 15; i++) {
    const t = link(clean(p[`nationalteam${i}`] ?? ""));
    if (t && !/under|u-?\d\d|olympic|youth| b\b|amateur/i.test(t.title + " " + t.text)) {
      nations.push(t.title.replace(/ (men's )?national (association )?(football|soccer) team.*$/i, "").trim());
    }
  }
  return { born, retired, nations, clubs, positions: positions(p.position ?? "") };
}

/** The "Honours" section, as a player (not as a manager): the trophies and big individual awards won, each with the
 * seasons won (a placing or a nomination isn't a win). */
function honours(text: string) {
  const at = /^(={2,3})\s*Honou?rs(?: and achievements)?\s*\1\s*$/m.exec(text);
  if (!at) return [];
  const top = at[1].length;
  const rest = text.slice(at.index).split("\n").slice(1);
  const out: { title: string; text: string; years: string[]; award: boolean }[] = [];
  let group = "", skip = false;
  for (const raw of rest) {
    const h = /^(={2,5})\s*(.+?)\s*\1\s*$/.exec(raw.trim());
    if (h && h[1].length <= top) break;
    if (h) {
      const name = shown(clean(h[2]));
      if (h[1].length === top + 1) skip = /manager|coach|orders|records|decorations|performances/i.test(name);
      group = name;
      continue;
    }
    const bold = /^'''(.+?)'''/.exec(raw.trim()) ?? /^;\s*(.+)$/.exec(raw.trim()); // a group: bold, or ";Club"
    if (bold) {
      group = shown(clean(bold[1]));
      continue;
    }
    if (skip || !raw.startsWith("*") || /orders|decorations|records|manager|coach/i.test(group)) continue;
    const line = clean(raw.replace(/^\*+\s*/, ""));
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const l = link(head) ?? { title: shown(head), text: shown(head) };
    const name = shown(head).replace(/\s*\(.*?\)\s*$/, "").trim();
    if (!name || name.split(/\s+/).length > 8 || NOT_WON.test(name) || NOT_WON.test(l.title)) continue;
    // the seasons won: up to a "runner-up" part, each mention without a placing after it
    const won = shown(line.slice(colon + 1).split(/;|runner|third place|finalist|nominat/i)[0]);
    const years = won
      .split(",")
      .filter((part) => !NOT_A_WIN.test(part))
      .flatMap((part) => part.match(/\b(1[89]|20)\d\d(?:[–-]\d{2,4})?\b/g) ?? [])
      .filter((y, i, all) => all.indexOf(y) === i);
    const award = /individual/i.test(group) || AWARDS.test(name) || /assist provider|most valuable/i.test(head); // (wherever it's listed)
    if (award && !AWARDS.test(name + " " + l.title)) continue;
    out.push({ title: l.title, text: name, years, award });
  }
  return out;
}

/** An award: one of the awards' pictures, or the star. A trophy: its picture, or the medal (then left out). */
const AWARD_ICONS = new Set(["ballon", "best", "boot", "glove"]);
const icon = (name: string, title: string, award: boolean) =>
  ICONS.find(([k, re]) => (!award || AWARD_ICONS.has(k)) && (re.test(name) || re.test(title)))?.[0] ?? (award ? "star" : "medal");

/** Everyone's details, by Wikidata id. */
async function build(people: { id: string; name: Names }[]): Promise<Map<string, Details>> {
  const catalog = JSON.parse(readFileSync("data/guess/catalog.json", "utf8"));
  const nationByName = new Map<string, string>(catalog.nations.map((n: any) => [n.name.en.toLowerCase(), n.id]));
  for (const [k, v] of Object.entries(NATION_ALIASES)) nationByName.set(k, v);

  // each one's English article
  const titles = new Map<string, string>();
  for (let i = 0; i < people.length; i += 50) {
    const ids = people.slice(i, i + 50).map((l) => l.id).join("|");
    const j = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks&sitefilter=enwiki&ids=${ids}`);
    for (const [q, e] of Object.entries<any>(j.entities)) if (e.sitelinks?.enwiki) titles.set(q, e.sitelinks.enwiki.title);
  }

  const born = await wikidata(people.map((l) => l.id)); // the birth year (infoboxes write it many ways)
  // Wikidata's positions played, added to the infobox's (which mostly names one)
  const played = new Map<string, string[]>();
  for (let i = 0; i < people.length; i += 250) {
    const pos = await getJson("https://query.wikidata.org/sparql", {
      method: "POST",
      headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        query: `SELECT ?item ?label WHERE { VALUES ?item { ${people.slice(i, i + 250).map((l) => "wd:" + l.id).join(" ")} }
          ?item wdt:P413 ?p . ?p rdfs:label ?label FILTER(lang(?label)="en") }`,
      }).toString(),
    });
    for (const b of pos.results.bindings) {
      const q = b.item.value.split("/").pop();
      played.set(q, [...(played.get(q) ?? []), b.label.value]);
    }
  }
  const raw = new Map<string, { c: ReturnType<typeof career>; h: ReturnType<typeof honours> }>();
  for (const l of people) {
    const text = await wikitext(titles.get(l.id) ?? l.name.en);
    raw.set(l.id, { c: career(text), h: honours(text) });
  }

  // the clubs' and honours' names in French and Arabic
  const linked = [...new Set([...raw.values()].flatMap(({ c, h }) => [...(c?.clubs ?? []).map((x) => x.title), ...h.map((x) => x.title)]))];
  const info = await pages(linked.filter((t) => t && !/[|[\]{}#<>]/.test(t))); // a "|" would split the batch
  const labels = await wikidata([...new Set([...info.values()].map((p) => p.item).filter((q): q is string => !!q))]);
  const names = (title: string, en: string): Names => {
    const d = labels.get(info.get(title)?.item ?? "");
    const ar = d?.ar?.replace(/^نادي\s+/, "");
    return { en, fr: plain(d?.fr ?? en), ar: plain(ar ?? d?.en ?? en) };
  };

  const out = new Map<string, Details>();
  for (const l of people) {
    const { c, h } = raw.get(l.id)!;
    if (!c) {
      console.warn(`!! no infobox: ${l.name.en}`);
      continue;
    }
    const clubs = c.clubs.map((x) => ({ name: names(x.title, plain(x.text)), from: x.from, to: x.to, ...(x.loan ? { loan: true as const } : {}) }));
    // the same trophy from several groups (two clubs' league titles stay apart only if their names differ)
    const merged = new Map<string, Honour & { award: boolean }>();
    for (const x of h) {
      const key = `${x.award}|${x.text}`;
      const m = merged.get(key);
      if (m) m.years.push(...x.years.filter((y) => !m.years.includes(y)));
      else merged.set(key, { name: names(x.title, x.text), icon: icon(x.text, x.title, x.award), years: [...x.years], award: x.award });
    }
    // a club's own player of the year: not a big award; a trophy without a season: not counted
    const own = (n: string) => /fans'|supporters'|players' player/i.test(n) || clubs.some((k) => n.startsWith(k.name.en + " "));
    const all = [...merged.values()].filter((x) => x.years.length && !(x.award && own(x.name.en)) && !(!x.award && x.icon === "medal"));
    const d: Details = {
      born: born.get(l.id)?.born ?? c.born,
      retired: c.retired, // null: still playing
      nation: c.nations.map((n) => nationByName.get(n.toLowerCase())).find(Boolean),
      positions: ORDER.filter((x) => c.positions.includes(x) || positions((played.get(l.id) ?? []).join(", ")).includes(x)),
      clubs,
      trophies: all.filter((x) => !x.award).map(({ award, ...x }) => x),
      awards: all.filter((x) => x.award).map(({ award, ...x }) => x),
    };
    if (!d.nation) console.warn(`!! nation ${JSON.stringify(c.nations)}: ${l.name.en}`);
    if (!d.positions.length) console.warn(`!! no position: ${l.name.en}`);
    if (!d.clubs.length) console.warn(`!! no clubs: ${l.name.en}`);
    out.set(l.id, d);
  }
  return out;
}

/** The hand corrections (info-fixes.json, by id): what Wikipedia's honours get wrong or leave out. */
function fix(id: string, d: Details, fixes: Record<string, Fix>) {
  const f = fixes[id];
  if (!f) return d;
  const drop = new Set((f.drop ?? []).map((n) => n.toLowerCase()));
  const named = new Set([...d.trophies, ...d.awards].map((t) => t.name.en.toLowerCase()));
  for (const n of [...drop, ...Object.keys(f.rename ?? {}).map((k) => k.toLowerCase())]) {
    if (!named.has(n)) console.warn(`!! fix for ${id}: no "${n}" to drop or rename`);
  }
  for (const c of f.dropClubs ?? []) if (!d.clubs.some((k) => `${k.name.en} ${k.from}` === c)) console.warn(`!! fix for ${id}: no club "${c}"`);
  d.trophies = d.trophies.filter((t) => !drop.has(t.name.en.toLowerCase()));
  d.awards = d.awards.filter((t) => !drop.has(t.name.en.toLowerCase()));
  for (const [en, to] of Object.entries(f.rename ?? {})) {
    for (const t of [...d.trophies, ...d.awards]) if (t.name.en === en) t.name = to;
  }
  d.clubs = d.clubs.filter((c) => !(f.dropClubs ?? []).includes(`${c.name.en} ${c.from}`));
  for (const [en, s] of Object.entries(f.set ?? {})) {
    const list = s.award ?? d.awards.some((t) => t.name.en === en) ? d.awards : d.trophies;
    const t = [...d.trophies, ...d.awards].find((x) => x.name.en === en);
    if (t) Object.assign(t, { years: s.years, ...(s.icon ? { icon: s.icon } : {}) });
    else list.push({ name: { en, fr: s.fr ?? en, ar: s.ar ?? en }, icon: s.icon ?? (s.award ? "star" : "cup"), years: s.years });
  }
  for (const k of ["born", "retired", "nation", "positions"] as const) if (k in f) (d as any)[k] = f[k];
  return d;
}

async function main() {
  const fixes: Record<string, Fix> = existsSync(FIXES) ? JSON.parse(readFileSync(FIXES, "utf8")) : {};
  delete (fixes as any).about;

  const file = JSON.parse(readFileSync(LEGENDS, "utf8"));
  const legends: any[] = file.legends;
  const legendInfo = await build(legends);
  for (const l of legends) {
    const d = legendInfo.get(l.id);
    if (d) Object.assign(l, fix(l.id, d, fixes));
  }
  writeFileSync(LEGENDS, JSON.stringify(file, null, 1) + "\n");
  console.log(`${legends.filter((l) => l.clubs?.length).length}/${legends.length} legends with their career`);

  // the easy level's footballers (the 18 biggest clubs')
  const catalog = JSON.parse(readFileSync("data/guess/catalog.json", "utf8"));
  const easy = catalog.players.filter((p: any) => LEVELS.easy(p.club));
  const playerInfo = await build(easy);
  const players: Record<string, Details> = {};
  for (const p of easy) {
    const d = playerInfo.get(p.id);
    if (d) players[p.id] = fix(p.id, { ...d, nation: p.nation }, fixes); // (the game's nation: the squad lists')
  }
  writeFileSync(PLAYERS, JSON.stringify({ version: new Date().toISOString().slice(0, 10), players }, null, 1) + "\n");
  console.log(`${Object.keys(players).length}/${easy.length} easy footballers with their career`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

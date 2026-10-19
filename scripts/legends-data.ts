/**
 * The legends' details for their info sheet: born, retired, nationality, clubs by season, trophies and the big
 * individual awards — from each one's English Wikipedia article (the infobox and the "Honours" section), with the
 * French and Arabic names from Wikidata.
 *
 *   npx tsx scripts/legends-data.ts
 *
 * Adds them to data/guess/legends.json (names, levels and photo credits kept). Re-run when a legend retires.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { getJson, pages, params, plain, templates, wikidata, wikitext } from "./guess-data.js";

type Names = { en: string; fr: string; ar: string };
const FILE = "data/guess/legends.json";

/** Which picture an honour gets in the info sheet: the first rule that matches its name (and its article). */
const ICONS: [string, RegExp][] = [
  ["best", /world player of the year|the best fifa|fifa best/i],
  ["ballon", /ballon d'or|golden ball/i],
  ["boot", /golden (shoe|boot)|top ?scorer|pichichi|capocannoniere|torjäger|torschützen|meilleur buteur|artilheiro/i],
  ["glove", /golden glove|yashin|zamora|goalkeeper of the year|best goalkeeper/i],
  ["worldcup", /^fifa world cup$/i],
  ["olympic", /olympic/i],
  ["clubworld", /intercontinental cup|club world cup/i],
  ["ucl", /champions league|european cup$|^european champion clubs|libertadores|african cup of champions|asian club championship/i],
  ["continental", /european championship|euro \d|copa américa|africa cup of nations|african cup of nations|asian cup|gold cup|gulf cup|arab cup|confederations cup|nations league|south american championship/i],
  ["europa", /uefa cup|europa league|cup winners|intertoto|conference league|confederation cup|sudamericana|fairs cup/i],
  ["supercup", /super ?cup|supercopa|supercoppa|supercup|community shield|charity shield|trophée des champions|recopa|supertaça|johan cruyff shield/i],
  ["league", /supporters' shield|botola/i],
  ["olympic", /games/i],
  ["cup", /cup|copa|coppa|pokal|coupe|taça|beker|trophy|tournament|tournoi|torneio|finalissima/i],
  ["league", /league|liga|serie [ab]|bundesliga|ligue|division|eredivisie|championship|campeonato|primeira|premiership|süper lig|pro league|championnat|brasileirão|primera|scudetto|torneo|apertura|clausura/i],
];
/** The individual awards worth showing (the rest — teams of the year, monthly awards, a club's own — left out). */
const AWARDS = /ballon d'or|world player of the year|the best fifa|golden (shoe|boot|ball|glove|boy)|top ?scorer|pichichi|capocannoniere|torjäger|player of the year|footballer of the year|best player|kopa|yashin|puskás award|most valuable/i;
/** Not trophies: all-star teams, polls, halls of fame, a manager's awards. */
const NOT_TROPHIES = /\bXI\b|u-?\d\d\b|under-?\d\d|youth|pre-olympic|team of the|poll|order of merit|fifa 100|scania 100|manager of the year|hall of fame|dream team|all-star/i;
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
const shown = (v: string) => v.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1").replace(/''+/g, "").trim();

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
  const active = clubs.at(-1)?.to === null; // "2023–": still playing (a coach's current club doesn't count)
  const retired = active ? null : Math.max(...clubs.map((c) => c.to ?? 0)) || null;
  // every senior national team he played for (a region's or a school's too: the first real nation is kept)
  const nations: string[] = [];
  for (let i = 1; i <= 15; i++) {
    const t = link(clean(p[`nationalteam${i}`] ?? ""));
    if (t && !/under|u-?\d\d|olympic|youth| b|amateur/i.test(t.title + " " + t.text)) {
      nations.push(t.title.replace(/ (men's )?national (association )?(football|soccer) team.*$/i, "").trim());
    }
  }
  return { born, retired, nations, clubs, positions: positions(p.position ?? "") };
}

/** The "Honours" section, as a player (not as a manager): its trophies and the big individual awards. */
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
    const bold = /^'''(.+?)'''/.exec(raw.trim());
    if (bold) {
      group = shown(clean(bold[1]));
      continue;
    }
    if (skip || !raw.startsWith("*") || /orders|decorations|records/i.test(group)) continue;
    const line = clean(raw.replace(/^\*+\s*/, ""));
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    if (/runner|third|fourth|second place|finalist|silver|bronze/i.test(head)) continue;
    const l = link(head) ?? { title: shown(head), text: shown(head) };
    const yearsText = shown(line.slice(colon + 1).split(/;|runner|third place|finalist/i)[0]);
    const years = yearsText.match(/\b(1[89]|20)\d\d(?:[–-]\d{2,4})?\b/g) ?? [];
    const award = /individual/i.test(group) || /top ?(goal)?scorer|assist provider|best player|player of the|golden (ball|boot|shoe|glove)/i.test(head);
    const name = shown(head).replace(/\s*\(.*?\)\s*$/, "").trim();
    if (!name || NOT_TROPHIES.test(name) || (award && !AWARDS.test(name + " " + l.title))) continue;
    out.push({ title: l.title, text: name, years, award });
  }
  return out;
}

/** An award: one of the awards' pictures, or the star. A trophy: its picture, or the medal (then left out). */
const AWARD_ICONS = new Set(["ballon", "best", "boot", "glove"]);
const icon = (name: string, title: string, award: boolean) =>
  ICONS.find(([k, re]) => (!award || AWARD_ICONS.has(k)) && (re.test(name) || re.test(title)))?.[0] ?? (award ? "star" : "medal");

async function main() {
  const file = JSON.parse(readFileSync(FILE, "utf8"));
  const legends: any[] = file.legends;
  const catalog = JSON.parse(readFileSync("data/guess/catalog.json", "utf8"));
  const nationByName = new Map<string, string>(catalog.nations.map((n: any) => [n.name.en.toLowerCase(), n.id]));
  for (const [k, v] of Object.entries(NATION_ALIASES)) nationByName.set(k, v);

  // each legend's English article
  const titles = new Map<string, string>();
  for (let i = 0; i < legends.length; i += 50) {
    const ids = legends.slice(i, i + 50).map((l) => l.id).join("|");
    const j = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks&sitefilter=enwiki&ids=${ids}`);
    for (const [q, e] of Object.entries<any>(j.entities)) if (e.sitelinks?.enwiki) titles.set(q, e.sitelinks.enwiki.title);
  }

  const born = await wikidata(legends.map((l) => l.id)); // the birth year (infoboxes write it many ways)
  // Wikidata's positions played, added to the infobox's (which mostly names one)
  const played = new Map<string, string[]>();
  const pos = await getJson("https://query.wikidata.org/sparql", {
    method: "POST",
    headers: { Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      query: `SELECT ?item ?label WHERE { VALUES ?item { ${legends.map((l) => "wd:" + l.id).join(" ")} }
        ?item wdt:P413 ?p . ?p rdfs:label ?label FILTER(lang(?label)="en") }`,
    }).toString(),
  });
  for (const b of pos.results.bindings) {
    const q = b.item.value.split("/").pop();
    played.set(q, [...(played.get(q) ?? []), b.label.value]);
  }
  const raw = new Map<string, { c: ReturnType<typeof career>; h: ReturnType<typeof honours> }>();
  for (const l of legends) {
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

  for (const l of legends) {
    const { c, h } = raw.get(l.id)!;
    if (!c) {
      console.warn(`!! no infobox: ${l.name.en}`);
      continue;
    }
    l.born = born.get(l.id)?.born ?? c.born;
    l.retired = c.retired; // null: still playing
    l.nation = c.nations.map((n) => nationByName.get(n.toLowerCase())).find(Boolean);
    if (!l.nation) console.warn(`!! nation ${JSON.stringify(c.nations)}: ${l.name.en}`);
    l.positions = ORDER.filter((x) => c.positions.includes(x) || positions((played.get(l.id) ?? []).join(", ")).includes(x));
    if (!l.positions.length) console.warn(`!! no position: ${l.name.en} (${JSON.stringify(c)})`);
    l.clubs = c.clubs.map((x) => ({ name: names(x.title, plain(x.text)), from: x.from, to: x.to, ...(x.loan ? { loan: true } : {}) }));
    // the same trophy from several groups (two clubs' league titles stay apart only if their names differ)
    const merged = new Map<string, any>();
    for (const x of h) {
      const key = `${x.award}|${x.text}`;
      const m = merged.get(key);
      if (m) m.years.push(...x.years.filter((y) => !m.years.includes(y)));
      else merged.set(key, { name: names(x.title, x.text), icon: icon(x.text, x.title, x.award), years: [...x.years], award: x.award });
    }
    // a club's own player of the year: not a big award
    const own = (n: string) => /fans'|supporters'|players' player/i.test(n) || l.clubs.some((k: any) => n.startsWith(k.name.en + " "));
    const all = [...merged.values()].filter((x) => !(x.award && own(x.name.en)) && !(!x.award && x.icon === "medal"));
    l.trophies = all.filter((x) => !x.award).map(({ award, ...x }) => x);
    l.awards = all.filter((x) => x.award).map(({ award, ...x }) => x);
    if (!l.clubs.length) console.warn(`!! no clubs: ${l.name.en}`);
  }
  writeFileSync(FILE, JSON.stringify(file, null, 1) + "\n");
  const n = legends.filter((l) => l.clubs?.length).length;
  console.log(`${n}/${legends.length} legends with their career; ${legends.filter((l) => l.trophies?.length).length} with trophies`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

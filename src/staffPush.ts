import { currentPlans, db, maybe, pbDate } from "./accounts.js";
import { pushTo } from "./push.js";

/**
 * Phone notifications for the staff, in the admin app: new reports and support messages (the owner and the
 * moderators), new cheating signs and new crashes (the owner). The admin app gives its phone's token when it opens;
 * once a minute the server looks for what's new since its last look, kept in admin_config so a restart doesn't ring
 * again (the very first look takes what is there already as seen).
 */
export type StaffKind = "reports" | "support" | "cheats" | "crashes";
type Phones = Record<string, { email: string; tokens: string[] }>; // staff uid → his e-mail and his phones
type Notified = { reportsAt: string; supportAt: string; flags: string[]; flagsAt: number };
type Flag = { kind: string; players: { uid: string; name: string }[]; why: string };

const CHEATS_EVERY_MS = 30 * 60_000; // the cheating signs are read from 30 days of games: not every minute

/** The phones that hear [kind]: the owner's (ADMIN_EMAILS) everything, a moderator's (still one) reports and support. */
export function hearing(phones: Phones, kind: StaffKind, owners: Set<string>, moderators: Set<string>): string[] {
  const forModerators = kind === "reports" || kind === "support";
  return Object.entries(phones).flatMap(([uid, p]) =>
    owners.has(p.email.toLowerCase()) || (forModerators && moderators.has(uid)) ? p.tokens : []);
}

async function load<T>(id: string): Promise<T | null> {
  return ((await maybe((await db()).collection("admin_config").getOne(id)))?.data as T) ?? null;
}

async function save(id: string, data: unknown) {
  const batch = (await db()).createBatch();
  batch.collection("admin_config").upsert({ id, data });
  await batch.send();
}

/** The admin app on this phone, signed in as [uid]: the staff's notifications come here (his last 5 phones). */
export async function addStaffPhone(uid: string, email: string, token: string) {
  const phones = (await load<Phones>("staffphones")) ?? {};
  const old = phones[uid]?.tokens ?? [];
  phones[uid] = { email, tokens: [token, ...old.filter((t) => t !== token)].slice(0, 5) };
  await save("staffphones", phones);
}

/** Rings the staff who hear [kind]. [tag]: one notification per thing on the phone (a player's chat, the reports…). */
export async function notifyStaff(kind: StaffKind, tag: string, title: string, body: string) {
  const phones = (await load<Phones>("staffphones")) ?? {};
  const owners = new Set((process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
  const moderators = new Set((currentPlans().staff ?? []).map((m) => m.uid));
  const dead = await pushTo(hearing(phones, kind, owners, moderators), { sender: `admin:${tag}`, title, body: body.slice(0, 300) });
  if (!dead.length) return;
  for (const p of Object.values(phones)) p.tokens = p.tokens.filter((t) => !dead.includes(t)); // (the app removed…)
  await save("staffphones", phones);
}

const nameOf = (u: Record<string, unknown> | undefined) => String(u?.name || u?.username || "?");

/** A cheating sign, the same from one look to the next: its kind and players (and a too-good game's name). */
const flagKey = (f: Flag) => `${f.kind}|${f.players.map((p) => p.uid).sort().join(",")}|${f.kind === "wins" ? f.why.split(":")[0] : ""}`;

/**
 * Once a minute (startAdminSchedules): the reports and the players' support messages since the last look, then (every
 * 30 minutes) the cheating signs not seen before. [flags]: admin.ts's cheatFlags.
 */
export async function notifyNews(flags: () => Promise<{ flags: Flag[] }>) {
  const client = await db();
  const seen = await load<Notified>("notified");
  if (!seen) {
    const keys = (await flags()).flags.map(flagKey);
    return save("notified", { reportsAt: pbDate(Date.now()), supportAt: pbDate(Date.now()), flags: keys, flagsAt: Date.now() });
  }
  const since = (at: string) => client.filter("created > {:at}", { at });
  const reports = await client.collection("reports").getFullList({ filter: since(seen.reportsAt), sort: "created", expand: "reporter,target", batch: 200 });
  if (reports.length === 1) {
    const r = reports[0];
    const reason = String(r.reason ?? "").trim();
    await notifyStaff("reports", "reports", `${nameOf(r.expand?.reporter)} reported ${nameOf(r.expand?.target)}`, reason || "A new report");
  } else if (reports.length > 1) {
    const targets = [...new Set(reports.map((r) => nameOf(r.expand?.target)))];
    await notifyStaff("reports", "reports", `${reports.length} new reports`, `About ${targets.join(", ")}`);
  }
  const messages = await client.collection("support_messages").getFullList({
    filter: `${since(seen.supportAt)} && fromSupport != true`, sort: "created", expand: "user", batch: 200,
  });
  const byPlayer = new Map<string, typeof messages>();
  for (const m of messages) byPlayer.set(m.user, [...(byPlayer.get(m.user) ?? []), m]);
  for (const [uid, list] of byPlayer) {
    const last = list[list.length - 1];
    const text = String(last.text ?? "").trim() || (last.media ? "📷 A picture or a video" : "A new message");
    const more = list.length > 1 ? ` (+${list.length - 1})` : "";
    await notifyStaff("support", `support:${uid}`, `Support: ${nameOf(last.expand?.user)}${more}`, text);
  }
  const next: Notified = {
    ...seen,
    reportsAt: reports.length ? reports[reports.length - 1].created : seen.reportsAt,
    supportAt: messages.length ? messages[messages.length - 1].created : seen.supportAt,
  };
  if (Date.now() - seen.flagsAt >= CHEATS_EVERY_MS) {
    const found = (await flags()).flags;
    const fresh = found.filter((f) => !seen.flags.includes(flagKey(f)));
    if (fresh.length) {
      const title = fresh.length === 1 ? "A new cheating sign" : `${fresh.length} new cheating signs`;
      await notifyStaff("cheats", "cheats", title, `${fresh[0].players.map((p) => p.name).join(", ")}: ${fresh[0].why}`);
    }
    next.flags = [...new Set([...found.map(flagKey), ...seen.flags])].slice(0, 1000);
    next.flagsAt = Date.now();
  }
  if (reports.length || messages.length || next.flagsAt !== seen.flagsAt) await save("notified", next);
}

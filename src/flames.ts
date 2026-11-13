import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";

import { db, dzDay, forPlayer, maybe, pbDate, pushToUsers, settings, signedIn } from "./accounts.js";

/**
 * Flames (the Chat tab, 2026-11-13): a photo or a 15-second video sent to friends and groups, seen twice (opened, then
 * one replay), then gone; unopened, gone after 24 h. Streaks: days in a row (Algiers' day) two friends both sent each
 * other a flame; lost when a day passes without, restorable the next day for diamonds (a VIP: once a month free).
 */
export class FlameError extends Error {}

const DAY_MS = 86_400_000;
export const FLAME_UNOPENED_MS = DAY_MS; // nobody opened it: gone
export const FLAME_MAX_MS = 2 * DAY_MS; // at most, whatever happened
export const REPORT_KEEP_MS = 7 * DAY_MS;

const today = (now = Date.now()) => dzDay(now);
const yesterday = (now = Date.now()) => dzDay(now - DAY_MS);
const time = (pb: string) => Date.parse(pb.replace(" ", "T"));

const pairOf = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

/** [from] sent [to] a flame today: their streak goes on (a day both did adds one; after a day without, it starts over). */
export async function flameSent(client: PocketBase, from: string, to: string, now = Date.now()) {
  const [user1, user2] = pairOf(from, to);
  await forPlayer(`streak:${user1}:${user2}`, async () => {
    const streaks = client.collection("streaks");
    const row = await maybe(streaks.getFirstListItem(client.filter("user1 = {:a} && user2 = {:b}", { a: user1, b: user2 })));
    const day = today(now);
    const s = { count: row?.count ?? 0, day1: row?.day1 ?? "", day2: row?.day2 ?? "", lastDay: row?.lastDay ?? "" };
    if (from === user1) s.day1 = day;
    else s.day2 = day;
    if (s.day1 === day && s.day2 === day && s.lastDay !== day) {
      s.count = s.lastDay === yesterday(now) ? s.count + 1 : 1;
      s.lastDay = day;
    }
    if (row) await streaks.update(row.id, s);
    else await streaks.create({ user1, user2, ...s });
  });
}

/** The flame I uploaded ([media]) to these friends and groups; [text]: what older apps (and notifications) show. */
export async function sendFlame(idToken: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const media = await maybe(client.collection("flame_media").getOne(String(body.media ?? "")));
  if (!media || media.from !== uid) throw new FlameError("invalid");
  // What older apps and notifications show: 🔥 a photo, 🎬 a video, then the sender's word for it ("Flame").
  const word = typeof body.text === "string" ? body.text.trim().slice(0, 60) : "";
  const video = media.kind === "video", seconds = video ? Math.min(15, Math.max(1, media.seconds ?? 1)) : 0;
  const text = `${video ? "🎬" : "🔥"}${word ? ` ${word}` : ""}`;
  const friends = Array.isArray(body.to) ? [...new Set(body.to.filter((x): x is string => typeof x === "string"))] : [];
  const groups = Array.isArray(body.groups) ? [...new Set(body.groups.filter((x): x is string => typeof x === "string"))] : [];
  if (friends.length + groups.length === 0 || friends.length + groups.length > 100) throw new FlameError("invalid");
  const sent: string[] = [];
  for (const to of friends) {
    const pair = client.filter("user = {:a} && friend = {:b}", { a: uid, b: to });
    if (!(await maybe(client.collection("friends").getFirstListItem(pair)))) continue; // (no longer friends)
    await client.collection("messages").create({ from: uid, to, type: "flame", text, flame: media.id, views: 0, seconds });
    await flameSent(client, uid, to);
    sent.push(to);
  }
  const me = await client.collection("users").getOne(uid, { fields: "name" });
  if (sent.length) await pushToUsers(sent, { type: "message", sender: uid, title: String(me.name ?? ""), body: text });
  for (const group of groups) {
    const members = await client.collection("group_members").getFullList({ filter: client.filter("group = {:g}", { g: group }) });
    if (!members.some((m) => m.user === uid && !m.invited)) continue;
    await client.collection("group_messages").create({ group, from: uid, type: "flame", text, flame: media.id, views: {}, seconds });
    const g = await client.collection("groups").getOne(group);
    const to = members.filter((m) => m.user !== uid && !m.invited && !m.muted).map((m) => m.user);
    await pushToUsers(to, { type: "group", sender: `group:${group}`, title: `${g.emoji ? `${g.emoji} ` : ""}${g.name}`, body: `${me.name}: ${text}` });
  }
  return { ok: true };
}

/** Whether every copy of [media] was seen twice (a group's: by each of its members). */
async function allSeen(client: PocketBase, media: string) {
  const rows = await client.collection("messages").getFullList({ filter: client.filter("flame = {:m}", { m: media }) });
  if (rows.some((r) => (r.views ?? 0) < 2)) return false;
  for (const line of await client.collection("group_messages").getFullList({ filter: client.filter("flame = {:m}", { m: media }) })) {
    const members = await client.collection("group_members").getFullList({ filter: client.filter("group = {:g} && invited = false", { g: line.group }) });
    const views: Record<string, number> = line.views ?? {};
    if (members.some((m) => m.user !== line.from && (views[m.user] ?? 0) < 2)) return false;
  }
  return true;
}

/** I open (1) or replay (2) a flame sent to me ([message]) or to a group of mine ([line]): its views, after this one. */
export async function viewFlame(idToken: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const id = String(body.message ?? body.line ?? "");
  const isLine = typeof body.line === "string";
  const row = await maybe(client.collection(isLine ? "group_messages" : "messages").getOne(id));
  if (!row || row.type !== "flame" || !row.flame) throw new FlameError("gone");
  return forPlayer(`flame:${row.flame}`, async () => {
    let views: number;
    if (isLine) {
      const mine = await client.collection("group_members").getFullList({ filter: client.filter("group = {:g} && user = {:u} && invited = false", { g: row.group, u: uid }) });
      if (mine.length === 0 || row.from === uid) throw new FlameError("invalid");
      const now = await client.collection("group_messages").getOne(id);
      const all: Record<string, number> = { ...(now.views ?? {}) };
      if ((all[uid] ?? 0) >= 2) throw new FlameError("gone");
      views = all[uid] = (all[uid] ?? 0) + 1;
      await client.collection("group_messages").update(id, { views: all });
    } else {
      if (row.to !== uid) throw new FlameError("invalid");
      const now = await client.collection("messages").getOne(id);
      if ((now.views ?? 0) >= 2) throw new FlameError("gone");
      views = (now.views ?? 0) + 1;
      await client.collection("messages").update(id, { views });
    }
    if (views === 2 && (await allSeen(client, row.flame))) await client.collection("flame_media").delete(row.flame);
    return { views };
  });
}

/** A flame sent to me, reported: a copy for support (7 days). */
export async function reportFlame(idToken: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const id = String(body.message ?? body.line ?? "");
  const isLine = typeof body.line === "string";
  const row = await maybe(client.collection(isLine ? "group_messages" : "messages").getOne(id));
  if (!row || row.type !== "flame" || !row.flame || (!isLine && row.to !== uid)) throw new FlameError("invalid");
  const media = await client.collection("flame_media").getOne(row.flame);
  const token = await client.files.getToken();
  const file = await fetch(client.files.getURL(media, media.media, { token }));
  const copy = new File([await file.arrayBuffer()], media.media, { type: file.headers.get("content-type") ?? undefined });
  await client.collection("flame_reports").create({ reporter: uid, from: media.from, media: copy, kind: media.kind, overlay: media.overlay });
  return { ok: true };
}

/** My lost streak with [friend] back (lost yesterday at midnight: today only): for diamonds, or a VIP's monthly free one. */
export async function restoreStreak(idToken: string, friend: string) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const [user1, user2] = pairOf(uid, friend);
  return forPlayer(uid, async () => {
    const row = await maybe(client.collection("streaks").getFirstListItem(client.filter("user1 = {:a} && user2 = {:b}", { a: user1, b: user2 })));
    const now = Date.now();
    if (!row || row.count < 1 || row.lastDay !== dzDay(now - 2 * DAY_MS)) throw new FlameError("invalid");
    const me = await client.collection("users").getOne(uid, { fields: "vip,diamonds,streakFree" });
    const month = today(now).slice(0, 7), price = settings().streakRestore;
    const free = me.vip === true && me.streakFree !== month;
    if (!free && (me.diamonds ?? 0) < price) throw new FlameError("funds");
    await client.collection("users").update(uid, free ? { streakFree: month } : { "diamonds-": price });
    await client.collection("streaks").update(row.id, { lastDay: yesterday(now) });
    return { count: row.count, free };
  });
}

/** Flames nobody opened in a day, or sent two days ago: gone (their messages say so); reported copies after 7 days. */
export async function dropOldFlames(now = Date.now()) {
  const client = await db();
  const media = client.collection("flame_media");
  const old = await media.getFullList({ filter: client.filter("created < {:cut}", { cut: pbDate(now - FLAME_UNOPENED_MS) }), fields: "id,created" });
  for (const m of old) {
    const opened = async () => {
      const rows = await client.collection("messages").getFullList({ filter: client.filter("flame = {:m} && views > 0", { m: m.id }), fields: "id" });
      if (rows.length) return true;
      const lines = await client.collection("group_messages").getFullList({ filter: client.filter("flame = {:m}", { m: m.id }), fields: "views" });
      return lines.some((l: RecordModel) => Object.keys(l.views ?? {}).length > 0);
    };
    if (time(m.created) < now - FLAME_MAX_MS || !(await opened())) await media.delete(m.id);
  }
  const reports = client.collection("flame_reports");
  for (const { id } of await reports.getFullList({ filter: client.filter("created < {:cut}", { cut: pbDate(now - REPORT_KEEP_MS) }), fields: "id" })) {
    await reports.delete(id);
  }
}

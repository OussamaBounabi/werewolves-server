import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";

import { db, forPlayer, maybe, pushToUsers, signedIn } from "./accounts.js";

/**
 * Groups of friends (the Chat tab, 2026-11-13). Whoever makes one is its admin; any member adds his own friends (each
 * gets an invitation to accept: group_members.invited); the admins remove members, rename it, switch whether its
 * messages stay, and name other admins. When the last admin leaves, the member there the longest becomes admin; the
 * last member out ends the group. 32 members at most (the invited count). Each change leaves a line in its chat.
 */
export const GROUP_MAX = 32;
export const GROUP_REACTIONS = ["❤️", "😆", "😮", "😢", "😠", "👍"];

export class GroupError extends Error {}

/** One group's changes at a time. */
const forGroup = <T>(group: string, fn: () => Promise<T>) => forPlayer(`group:${group}`, fn);

type Member = RecordModel & { group: string; user: string; admin: boolean; invited: boolean };

const membersOf = async (client: PocketBase, group: string) =>
  (await client.collection("group_members").getFullList({
    filter: client.filter("group = {:group}", { group }),
    sort: "created",
  })) as Member[];

/** His joined membership of [group] (an admin's if [admin]): else refused. */
async function mine(client: PocketBase, uid: string, group: string, admin = false) {
  const all = await membersOf(client, group);
  const me = all.find((m) => m.user === uid && !m.invited);
  if (!me || (admin && !me.admin)) throw new GroupError("not allowed");
  return { me, all };
}

const nameOf = async (client: PocketBase, uid: string) =>
  String((await client.collection("users").getOne(uid, { fields: "name,username" })).name ?? "");

/** A line of the group's own (what happened, by whom, to whom). */
const line = (client: PocketBase, group: string, data: Record<string, unknown>) =>
  client.collection("group_messages").create({ group, type: "system", text: "-", data });

/** [friends], each a friend of [uid]'s who hasn't blocked him nor been blocked by him. */
async function friendsOnly(client: PocketBase, uid: string, friends: string[]) {
  for (const f of friends) {
    const pair = client.filter("user = {:a} && friend = {:b}", { a: uid, b: f });
    if (!(await maybe(client.collection("friends").getFirstListItem(pair)))) throw new GroupError("not a friend");
    const blocked = client.filter("(user = {:a} && blocked = {:b}) || (user = {:b} && blocked = {:a})", { a: uid, b: f });
    if (await maybe(client.collection("blocks").getFirstListItem(blocked))) throw new GroupError("not a friend");
  }
}

const cleanName = (name: unknown) => {
  const n = typeof name === "string" ? name.trim() : "";
  if (n.length < 1 || n.length > 40) throw new GroupError("invalid");
  return n;
};
const cleanEmoji = (emoji: unknown) => (typeof emoji === "string" ? emoji.slice(0, 16) : "");
const cleanColor = (color: unknown) => (Number.isInteger(color) && (color as number) >= 0 && (color as number) <= 7 ? (color as number) : 0);
const ids = (list: unknown) =>
  Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === "string" && x.length > 0))] : [];

/** A new group: me (its admin) and the friends I picked (invited). */
export async function createGroup(idToken: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const name = cleanName(body.name), others = ids(body.members).filter((x) => x !== uid);
  if (others.length < 1 || others.length > GROUP_MAX - 1) throw new GroupError("invalid");
  await friendsOnly(client, uid, others);
  const group = await client.collection("groups").create({ name, emoji: cleanEmoji(body.emoji), color: cleanColor(body.color) });
  await client.collection("group_members").create({ group: group.id, user: uid, admin: true });
  for (const user of others) await client.collection("group_members").create({ group: group.id, user, invited: true, by: uid });
  await line(client, group.id, { kind: "created", by: await nameOf(client, uid) });
  return { id: group.id };
}

/** My friends into a group I'm in: invited. */
export async function addToGroup(idToken: string, group: string, users: unknown) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  return forGroup(group, async () => {
    const { all } = await mine(client, uid, group);
    const added = ids(users).filter((u) => !all.some((m) => m.user === u));
    if (added.length === 0 || all.length + added.length > GROUP_MAX) throw new GroupError("full");
    await friendsOnly(client, uid, added);
    for (const user of added) await client.collection("group_members").create({ group, user, invited: true, by: uid });
    const names = await Promise.all(added.map((u) => nameOf(client, u)));
    await line(client, group, { kind: "added", by: await nameOf(client, uid), who: names.join(", ") });
    return { ok: true };
  });
}

/** An admin puts a member (or an invitation) out. */
export async function removeFromGroup(idToken: string, group: string, user: string) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  return forGroup(group, async () => {
    const { all } = await mine(client, uid, group, true);
    const target = all.find((m) => m.user === user);
    if (!target || user === uid) throw new GroupError("invalid");
    await client.collection("group_members").delete(target.id);
    if (!target.invited) await line(client, group, { kind: "removed", by: await nameOf(client, uid), who: await nameOf(client, user) });
    return { ok: true };
  });
}

/** I leave: the last admin out hands over to the member there the longest; the last member out ends the group. */
export async function leaveGroup(idToken: string, group: string) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  return forGroup(group, async () => {
    const { me, all } = await mine(client, uid, group);
    await client.collection("group_members").delete(me.id);
    const left = all.filter((m) => m.id !== me.id && !m.invited);
    if (left.length === 0) {
      await client.collection("groups").delete(group); // (its members, invitations and lines with it)
      return { ok: true };
    }
    await line(client, group, { kind: "left", who: await nameOf(client, uid) });
    if (me.admin && !left.some((m) => m.admin)) {
      const next = left[0]; // (sorted by when they came)
      await client.collection("group_members").update(next.id, { admin: true });
      await line(client, group, { kind: "admin", who: await nameOf(client, next.user) });
    }
    return { ok: true };
  });
}

/** An admin names another admin, or takes it back (never from himself). */
export async function setGroupAdmin(idToken: string, group: string, user: string, on: boolean) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  return forGroup(group, async () => {
    const { all } = await mine(client, uid, group, true);
    const target = all.find((m) => m.user === user && !m.invited);
    if (!target || user === uid) throw new GroupError("invalid");
    await client.collection("group_members").update(target.id, { admin: on });
    if (on) await line(client, group, { kind: "admin", who: await nameOf(client, user) });
    return { ok: true };
  });
}

/** An admin renames it (its emoji and colour too). */
export async function editGroup(idToken: string, group: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  await mine(client, uid, group, true);
  const name = cleanName(body.name);
  await client.collection("groups").update(group, { name, emoji: cleanEmoji(body.emoji), color: cleanColor(body.color) });
  await line(client, group, { kind: "renamed", by: await nameOf(client, uid), who: name });
  return { ok: true };
}

/** An admin switches whether its messages stay or vanish 24 h after they're sent. */
export async function keepGroup(idToken: string, group: string, keep: boolean) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  await mine(client, uid, group, true);
  await client.collection("groups").update(group, { keep });
  await line(client, group, { kind: keep ? "keep" : "vanish", by: await nameOf(client, uid) });
  return { ok: true };
}

/** A member's reaction on a line (one of six; the same again takes it back). */
export async function reactGroupLine(idToken: string, id: string, emoji: string) {
  if (!GROUP_REACTIONS.includes(emoji)) throw new GroupError("invalid");
  const { uid } = await signedIn(idToken);
  const client = await db();
  const m = await maybe(client.collection("group_messages").getOne(id));
  if (!m || (m.type !== "text" && m.type !== "voice")) throw new GroupError("invalid");
  return forGroup(m.group, async () => {
    await mine(client, uid, m.group);
    const now = await client.collection("group_messages").getOne(id);
    const reactions: Record<string, string> = { ...(now.reactions ?? {}) };
    if (reactions[uid] === emoji) delete reactions[uid];
    else reactions[uid] = emoji;
    await client.collection("group_messages").update(id, { reactions });
    return { ok: true };
  });
}

/** A member keeps a line when the rest vanishes, or no longer. */
export async function saveGroupLine(idToken: string, id: string, on: boolean) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const m = await maybe(client.collection("group_messages").getOne(id));
  if (!m || m.type === "system" || m.type === "deleted") throw new GroupError("invalid");
  await mine(client, uid, m.group);
  await client.collection("group_messages").update(id, { saved: on });
  return { ok: true };
}

const pushed = new Set<string>();

/** A line I just wrote, to the other members' phones (not those who muted the group). Once, within a minute. */
export async function pushGroupLine(idToken: string, id: string) {
  const { uid } = await signedIn(idToken);
  if (pushed.has(id)) return { ok: true };
  const client = await db();
  const m = await maybe(client.collection("group_messages").getOne(id));
  if (!m || m.from !== uid || Date.now() - Date.parse(String(m.created).replace(" ", "T")) > 60_000) return { ok: true };
  pushed.add(id);
  if (pushed.size > 10_000) pushed.clear();
  const [g, all] = await Promise.all([client.collection("groups").getOne(m.group), membersOf(client, m.group)]);
  const to = all.filter((x) => x.user !== uid && !x.invited && !x.muted).map((x) => x.user);
  await pushToUsers(to, {
    type: "group",
    sender: `group:${m.group}`,
    title: `${g.emoji ? `${g.emoji} ` : ""}${g.name}`,
    body: `${await nameOf(client, uid)}: ${String(m.text ?? "").slice(0, 280)}`,
  });
  return { ok: true };
}

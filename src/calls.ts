import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";

import { db, forPlayer, maybe, pbDate, pushToUsers, signedIn, type Account } from "./accounts.js";
import { may, memberOf, type Role } from "./clans.js";
import { Throws } from "./throws.js";
import { callToken, closeCall, setCallTalk, tellCall } from "./voice.js";

/**
 * Calls (the Chat tab, 2026-11-13), on the voice server (a LiveKit room `call-<id>`). The calls row and its people
 * (call_people) are what the apps follow live.
 * - Two friends: voice or video; a push rings the phone of the one called even when PlayRoom is closed (PushService:
 *   full screen, like a phone call); 45 seconds without an answer: missed. Each call leaves a line in their chat; a
 *   missed one rings as a notification. One hangs up: it's over, unless others were added to it.
 * - Anyone in a call adds friends (8 people at most in it): it rings for them.
 * - A group's call rings its members (but those who muted the group); it lasts while someone is in it.
 * - A clan's call, started by an elder or above: every member may join and listen; 8 talk (the stage, the first in);
 *   a listener raises his hand; the leader and co-leaders bring people up or down.
 */
export class CallError extends Error {}

export const RING_MS = 45_000;
export const CALL_MAX = 8; // in a call (a clan's: on its stage)
const STALE_MS = 6 * 3_600_000; // a call still "active" after this: an app that died

const ringing = new Map<string, NodeJS.Timeout>(); // the calls ringing now (two friends): their timeout
const throws = new Throws(); // (one every 3 seconds, as in rooms)

const nameOf = async (client: PocketBase, uid: string) =>
  String((await client.collection("users").getOne(uid, { fields: "name,username" })).name || "");

const minutesOf = (call: RecordModel, now: number) =>
  Math.max(1, Math.round((now - Date.parse(String(call.started).replace(" ", "T"))) / 60_000));

/** The line a call leaves in the chat: its icon, and how long it lasted (nothing: nobody answered). */
function line(call: RecordModel, now: number) {
  const icon = call.video ? "📹" : "📞";
  return call.started ? `${icon} ${minutesOf(call, now)} min` : icon;
}

const peopleOf = (client: PocketBase, call: string) =>
  client.collection("call_people").getFullList({ filter: client.filter("call = {:call}", { call }) });

/** Whether [uid] is in a call now (or one rings for him from a friend). */
async function busy(client: PocketBase, uid: string) {
  const since = pbDate(Date.now() - STALE_MS);
  const inOne = await client.collection("call_people").getList(1, 1, {
    filter: client.filter("user = {:uid} && state = 'in' && call.state != 'ended' && call.created > {:since}", { uid, since }),
  });
  const rings = await client.collection("calls").getList(1, 1, {
    filter: client.filter("state = 'ringing' && created > {:since} && (caller = {:uid} || callee = {:uid})", { uid, since }),
  });
  return inOne.totalItems + rings.totalItems > 0;
}

const upsertPerson = async (client: PocketBase, call: string, user: string, fields: Record<string, unknown>) => {
  const row = await maybe(client.collection("call_people").getFirstListItem(client.filter("call = {:call} && user = {:user}", { call, user })));
  return row ? client.collection("call_people").update(row.id, fields) : client.collection("call_people").create({ call, user, ...fields });
};

/** I call [to] (a friend): ringing now on his side (his app, or his phone's notification). */
export async function startCall(idToken: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const to = String(body.to ?? ""), video = body.video === true;
  const client = await db();
  const friends = await maybe(client.collection("friends").getFirstListItem(client.filter("user = {:a} && friend = {:b}", { a: uid, b: to })));
  if (!friends) throw new CallError("invalid");
  return forPlayer(`call:${[uid, to].sort().join(":")}`, async () => {
    if (await busy(client, uid)) throw new CallError("busy_me");
    const name = await nameOf(client, uid);
    if (await busy(client, to)) {
      // He's on another call: it never rings; he sees that I called.
      const call = await client.collection("calls").create({ caller: uid, callee: to, video, state: "ended", outcome: "busy", ended: new Date() });
      await finish(client, call, name);
      return { id: call.id, busy: true };
    }
    const call = await client.collection("calls").create({ caller: uid, callee: to, video, state: "ringing" });
    await client.collection("call_people").create({ call: call.id, user: uid, state: "in", talk: true });
    await client.collection("call_people").create({ call: call.id, user: to, state: "ringing", talk: true });
    ringing.set(call.id, setTimeout(() => void endCall("", call.id, "missed").catch(() => {}), RING_MS));
    await pushToUsers([to], { type: "call", sender: uid, call: call.id, title: name, video: video ? "1" : "0" }, undefined, RING_MS);
    return { id: call.id, ...(await callToken(call.id, uid, name)) };
  });
}

/** A group's call (voice or video): it rings its members; one already on: I join it. */
export async function startGroupCall(idToken: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const group = String(body.group ?? ""), video = body.video === true;
  const client = await db();
  const members = await client.collection("group_members").getFullList({ filter: client.filter("group = {:g} && invited = false", { g: group }) });
  if (!members.some((m) => m.user === uid)) throw new CallError("invalid");
  const id = await forPlayer(`call:group:${group}`, async () => {
    const on = await maybe(client.collection("calls").getFirstListItem(client.filter("group = {:g} && state = 'active'", { g: group })));
    if (on) return on.id;
    if (await busy(client, uid)) throw new CallError("busy_me");
    const call = await client.collection("calls").create({ caller: uid, group, video, state: "active", started: new Date() });
    const others = members.filter((m) => m.user !== uid);
    for (const m of others) await client.collection("call_people").create({ call: call.id, user: m.user, state: "ringing", talk: true });
    ringOut(call.id, others.map((m) => m.user));
    const g = await client.collection("groups").getOne(group);
    const title = `${g.emoji ? `${g.emoji} ` : ""}${g.name}`;
    await pushToUsers(others.filter((m) => !m.muted).map((m) => m.user), {
      type: "call", sender: `group:${group}`, call: call.id, title, video: video ? "1" : "0", body: await nameOf(client, uid),
    }, undefined, RING_MS);
    return call.id;
  });
  return joinCall(idToken, id);
}

/** My clan's call (an elder or above starts one; one at a time): every member may join it. */
export async function startClanCall(idToken: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const me = await memberOf(client, uid);
  if (!me) throw new CallError("invalid");
  const id = await forPlayer(`call:clan:${me.clan}`, async () => {
    const on = await maybe(client.collection("calls").getFirstListItem(client.filter("clan = {:c} && state = 'active'", { c: me.clan })));
    if (on) return on.id;
    if (!may(me.role, "call")) throw new CallError("rank");
    if (await busy(client, uid)) throw new CallError("busy_me");
    const call = await client.collection("calls").create({ caller: uid, clan: me.clan, video: body.video === true, state: "active", started: new Date() });
    const clan = await client.collection("clans").getOne(me.clan, { fields: "name,tag" });
    const members = await client.collection("clan_members").getFullList({ filter: client.filter("clan = {:c}", { c: me.clan }), fields: "user" });
    await pushToUsers(members.map((m) => m.user).filter((u) => u !== uid), {
      type: "clan_call", sender: "clan", call: call.id, title: `[${clan.tag}] ${clan.name}`, body: await nameOf(client, uid),
    }, "clanRooms", 30 * 60_000);
    return call.id;
  });
  return joinCall(idToken, id);
}

/** A call's ringing for these people stops after 45 seconds: missed for those who never answered. */
function ringOut(call: string, users: string[]) {
  setTimeout(async () => {
    const client = await db();
    for (const p of await peopleOf(client, call)) {
      if (users.includes(p.user) && p.state === "ringing") await client.collection("call_people").update(p.id, { state: "missed" }).catch(() => {});
    }
  }, RING_MS);
}

/** I answer a call ringing for me (two friends): its voice room's access. */
export async function answerCall(idToken: string, id: string) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  return forPlayer(`call:${id}`, async () => {
    const call = await maybe(client.collection("calls").getOne(id));
    if (!call || call.callee !== uid) throw new CallError("invalid");
    if (call.state !== "ringing") throw new CallError("gone");
    clearTimeout(ringing.get(id));
    ringing.delete(id);
    await client.collection("calls").update(id, { state: "active", started: new Date() });
    await upsertPerson(client, id, uid, { state: "in", talk: true });
    return { id, ...(await callToken(id, uid, await nameOf(client, uid))) };
  });
}

/** I join a call on (one ringing for me, one I left, my group's or my clan's): its voice room's access. */
export async function joinCall(idToken: string, id: string) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  return forPlayer(`call:${id}`, async () => {
    const call = await maybe(client.collection("calls").getOne(id));
    if (!call || call.state !== "active") throw new CallError("gone");
    const people = await peopleOf(client, id);
    const mine = people.find((p) => p.user === uid);
    let clanMember = false;
    if (call.clan) clanMember = (await memberOf(client, uid))?.clan === call.clan;
    if (!mine && !clanMember && call.caller !== uid) throw new CallError("invalid");
    if (mine?.state !== "in" && (await busy(client, uid))) throw new CallError("busy_me");
    const talking = people.filter((p) => p.state === "in" && p.user !== uid && (p.talk || !call.clan)).length;
    if (!call.clan && talking >= CALL_MAX) throw new CallError("full");
    const talk = !call.clan || talking < CALL_MAX;
    await upsertPerson(client, id, uid, { state: "in", talk, hand: false });
    return { id, talk, ...(await callToken(id, uid, await nameOf(client, uid), talk)) };
  });
}

/**
 * I'm out of a call: hung up, declined, or cancelled (two friends, or nobody answered: [idToken] ''): over for both
 * of them, with its line in their chat and the ringing stopped. With more people: I leave it; the last one out ends it.
 */
export async function endCall(idToken: string, id: string, reason?: string) {
  const uid = idToken ? (await signedIn(idToken)).uid : "";
  const client = await db();
  return forPlayer(`call:${id}`, async () => {
    const call = await maybe(client.collection("calls").getOne(id));
    if (!call) throw new CallError("invalid");
    if (call.state === "ended") return { ok: true };
    if (reason === "missed" && uid) throw new CallError("invalid"); // (only the timeout says so)
    const people = await peopleOf(client, id);
    const mine = people.find((p) => p.user === uid);
    if (uid && !mine && call.caller !== uid && call.callee !== uid) throw new CallError("invalid");
    const two = !call.group && !call.clan && people.length <= 2;
    if (!two) {
      // A group's, a clan's, or one with people added: I leave it; the last one out ends it (nobody: [uid] '').
      if (mine) await client.collection("call_people").update(mine.id, { state: mine.state === "ringing" ? "declined" : "left", hand: false });
      const still = people.filter((p) => p.user !== uid && p.state === "in").length;
      const alone = !call.group && !call.clan && still < 2 && !people.some((p) => p.user !== uid && p.state === "ringing");
      if (!uid || still === 0 || alone) await over(client, call);
      return { ok: true };
    }
    clearTimeout(ringing.get(id));
    ringing.delete(id);
    const outcome = call.state === "active" ? "answered" : !uid ? "missed" : uid === call.caller ? "cancelled" : "declined";
    for (const p of people) {
      if (p.state === "in" || p.state === "ringing") await client.collection("call_people").update(p.id, { state: p.state === "in" ? "left" : outcome === "declined" ? "declined" : "missed" });
    }
    const ended = await client.collection("calls").update(id, { state: "ended", outcome, ended: new Date() });
    await closeCall(id);
    await finish(client, ended, await nameOf(client, call.caller));
    return { ok: true };
  });
}

/** A call of more people over: everyone out; a group's leaves a line in its chat. */
async function over(client: PocketBase, call: RecordModel) {
  for (const p of await peopleOf(client, call.id)) {
    if (p.state === "in" || p.state === "ringing") await client.collection("call_people").update(p.id, { state: p.state === "in" ? "left" : "missed" });
  }
  const ended = await client.collection("calls").update(call.id, { state: "ended", outcome: "answered", ended: new Date() });
  await closeCall(call.id);
  if (ended.group) {
    await client.collection("group_messages").create({
      group: ended.group, from: ended.caller, type: "system", text: line(ended, Date.now()),
      data: { kind: "call", minutes: minutesOf(ended, Date.now()), video: ended.video === true },
    });
  }
}

/** A call's line in the chat; its ringing stopped; a call not answered rings as "missed call" on his phone. */
async function finish(client: PocketBase, call: RecordModel, callerName: string) {
  await client.collection("messages").create({ from: call.caller, to: call.callee, type: "call", text: line(call, Date.now()) });
  await pushToUsers([call.callee], { type: "call_end", sender: call.caller, call: call.id }, undefined, RING_MS);
  if (call.outcome !== "answered" && call.outcome !== "declined") {
    await pushToUsers([call.callee], { type: "missed_call", sender: call.caller, title: callerName, video: call.video ? "1" : "0" });
  }
}

/** I add friends of mine to a call I'm in (8 in it at most, counting those it rings for): it rings for them. */
export async function addToCall(idToken: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const id = String(body.id ?? "");
  const users = Array.isArray(body.users) ? [...new Set(body.users.map(String))] : [];
  const client = await db();
  return forPlayer(`call:${id}`, async () => {
    const call = await maybe(client.collection("calls").getOne(id));
    const people = call ? await peopleOf(client, id) : [];
    if (!call || call.clan || !people.some((p) => p.user === uid && p.state === "in") || users.length === 0) throw new CallError("invalid");
    const taken = people.filter((p) => p.state === "in" || p.state === "ringing").map((p) => p.user);
    const adding = users.filter((u) => !taken.includes(u));
    if (taken.length + adding.length > CALL_MAX) throw new CallError("full");
    for (const u of adding) {
      if (!(await maybe(client.collection("friends").getFirstListItem(client.filter("user = {:a} && friend = {:b}", { a: uid, b: u }))))) throw new CallError("invalid");
    }
    if (call.state === "ringing") {
      // (Two friends, not answered yet: adding waits for the answer.)
      throw new CallError("invalid");
    }
    for (const u of adding) await upsertPerson(client, id, u, { state: "ringing", talk: true, hand: false });
    ringOut(id, adding);
    await pushToUsers(adding, { type: "call", sender: uid, call: id, title: await nameOf(client, uid), video: call.video ? "1" : "0" }, undefined, RING_MS);
    return { ok: true };
  });
}

/** A clan call's listener raises his hand ([up]) or lowers it. */
export async function raiseHand(idToken: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const id = String(body.id ?? "");
  const mine = await maybe(client.collection("call_people").getFirstListItem(client.filter("call = {:id} && user = {:uid} && state = 'in'", { id, uid })));
  if (!mine || mine.talk) throw new CallError("invalid");
  await client.collection("call_people").update(mine.id, { hand: body.up === true });
  return { ok: true };
}

/** The leader or a co-leader brings [user] up to talk ([talk]) or down to listen, in their clan's call. */
export async function setStage(idToken: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const id = String(body.id ?? ""), user = String(body.user ?? ""), talk = body.talk === true;
  return forPlayer(`call:${id}`, async () => {
    const call = await maybe(client.collection("calls").getOne(id));
    const me = await memberOf(client, uid);
    if (!call?.clan || me?.clan !== call.clan || !may(me.role as Role, "stage")) throw new CallError("invalid");
    const people = await peopleOf(client, id);
    const row = people.find((p) => p.user === user && p.state === "in");
    if (!row) throw new CallError("invalid");
    if (talk && !row.talk && people.filter((p) => p.state === "in" && p.talk).length >= CALL_MAX) throw new CallError("full");
    await client.collection("call_people").update(row.id, { talk, hand: false });
    await setCallTalk(id, user, talk);
    return { ok: true };
  });
}

/** I throw [item] at someone in my call ([to]; two of us: the other one), paid in coins as in rooms. */
export async function throwInCall(idToken: string, body: Record<string, unknown>) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const call = await maybe(client.collection("calls").getOne(String(body.id ?? "")));
  const people = call ? await peopleOf(client, call.id) : [];
  const inIt = (u: string) => people.some((p) => p.user === u && p.state === "in");
  const to = typeof body.to === "string" ? body.to : people.find((p) => p.user !== uid && p.state === "in")?.user ?? "";
  if (!call || call.state !== "active" || !inIt(uid) || !inIt(to) || to === uid) throw new CallError("invalid");
  const me = await client.collection("users").getOne(uid, { fields: "vip,vipPro" });
  const why = await throws.pay(uid, { uid, vip: me.vip === true, vipPro: me.vipPro === true } as Account, body.item);
  if (why) throw new CallError(why);
  await tellCall(call.id, { type: "throw", from: uid, to, item: body.item });
  return { ok: true };
}

/** Calls an app never closed (it died mid-call), that rang through a restart of this server, or nobody is in: ended. */
export async function endStaleCalls(now = Date.now()) {
  const client = await db();
  const stale = await client.collection("calls").getFullList({
    filter: client.filter("(state = 'ringing' && created < {:ring}) || (state = 'active' && created < {:long})", {
      ring: pbDate(now - RING_MS - 15_000), long: pbDate(now - STALE_MS),
    }),
    fields: "id",
  });
  for (const { id } of stale) await endCall("", id, "missed").catch(() => {});
  const empty = await client.collection("calls").getFullList({
    filter: client.filter("state = 'active' && (group != '' || clan != '') && created < {:cut}", { cut: pbDate(now - 60_000) }),
  });
  for (const call of empty) {
    if (!(await peopleOf(client, call.id)).some((p) => p.state === "in")) await over(client, call).catch(() => {});
  }
}

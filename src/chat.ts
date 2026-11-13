import { db, pbDate } from "./accounts.js";

/** How long a seen chat message stays, unless saved or its pair keeps its chats. */
export const VANISH_MS = 24 * 3_600_000;

const time = (pb: string) => Date.parse(pb.replace(" ", "T"));

/**
 * Disappearing chats (the Chat tab): a message is marked seen (seenAt) once its reader's chat_reads row has passed it;
 * 24 h after that it's deleted (its voice file with it), unless saved, or the pair keeps its chats (chat_modes.keep).
 * A group's lines go 24 h after they're sent, unless saved or the group keeps them.
 * ponytail: reads every unseen message on each run; a seenAt set by the app's markRead if it ever grows large.
 */
export async function vanishChats(now = Date.now()) {
  const client = await db();
  const messages = client.collection("messages");
  const reads = new Map<string, number>(); // "<reader> <writer>": when he last read their chat
  for (const r of await client.collection("chat_reads").getFullList({ fields: "user,friend,at" })) {
    reads.set(`${r.user} ${r.friend}`, time(r.at));
  }
  const unseen = await messages.getFullList({ filter: 'seenAt = "" && type != "invite"', fields: "id,from,to,created" });
  for (const m of unseen) {
    const read = reads.get(`${m.to} ${m.from}`);
    if (read !== undefined && time(m.created) <= read) await messages.update(m.id, { seenAt: pbDate(now) });
  }
  const kept = new Set<string>();
  for (const c of await client.collection("chat_modes").getFullList({ filter: "keep = true", fields: "user1,user2" })) {
    kept.add(`${c.user1} ${c.user2}`).add(`${c.user2} ${c.user1}`);
  }
  const old = client.filter('seenAt != "" && seenAt < {:cut} && saved = false', { cut: pbDate(now - VANISH_MS) });
  for (const m of await messages.getFullList({ filter: old, fields: "id,from,to" })) {
    if (!kept.has(`${m.from} ${m.to}`)) await messages.delete(m.id);
  }
  // A group's: 24 h after they're sent (saved ones aside), unless it keeps them.
  const lines = client.collection("group_messages");
  const sent = client.filter("created < {:cut} && saved = false && group.keep = false", { cut: pbDate(now - VANISH_MS) });
  for (const { id } of await lines.getFullList({ filter: sent, fields: "id" })) await lines.delete(id);
}

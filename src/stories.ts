import { db, pbDate, signedIn } from "./accounts.js";

/**
 * Stories and notes (the Chat tab, 2026-11-13): the app posts photos, videos and sentences itself (the database's
 * rules guard them); a game moment comes from here, out of the game's log, so its result is the real one. Both last 24
 * hours: then they're deleted.
 */
export class StoryError extends Error {}

const DAY_MS = 86_400_000;

/** My games of the last 24 hours (the newest first): what a game moment can show. */
export async function myMoments(idToken: string) {
  const { uid } = await signedIn(idToken);
  const client = await db();
  const rows = await client.collection("game_log").getList(1, 20, {
    filter: client.filter("uids ~ {:uid} && created > {:since}", { uid, since: pbDate(Date.now() - DAY_MS) }),
    sort: "-created",
  });
  return {
    games: rows.items.flatMap((r) => {
      const me = (r.players as { uid: string; won: boolean; role?: string; side?: string }[]).find((p) => p.uid === uid);
      return me ? [{ id: r.id, game: r.game, won: me.won, role: me.role ?? "", minutes: r.minutes, players: r.players.length, at: r.created }] : [];
    }),
  };
}

/** One of my games of the last 24 hours ([log]: its game_log row) as a story of mine. */
export async function shareMoment(idToken: string, log: string) {
  const { uid } = await signedIn(idToken);
  const { games } = await myMoments(idToken);
  const game = games.find((g) => g.id === log);
  if (!game) throw new StoryError("invalid");
  const client = await db();
  const hidden = await client.collection("story_hides").getFullList({ filter: client.filter("user = {:uid}", { uid }), fields: "hidden" });
  const { game: name, won, role, minutes, players } = game;
  const story = await client.collection("stories").create({
    user: uid, kind: "game", data: { game: name, won, role, minutes, players }, hidden: hidden.map((h) => h.hidden),
  });
  return { id: story.id };
}

/** Stories and notes older than a day: gone (a story's views with it). */
export async function dropOldStories(now = Date.now()) {
  const client = await db();
  const cut = pbDate(now - DAY_MS);
  for (const [name, field] of [["stories", "created"], ["notes", "updated"]]) {
    const old = await client.collection(name).getFullList({ filter: client.filter(`${field} < {:cut}`, { cut }), fields: "id" });
    for (const { id } of old) await client.collection(name).delete(id).catch(() => {}); // (gone meanwhile)
  }
}

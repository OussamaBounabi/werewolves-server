// A message from support to every player (the apps show the newest one, once, in the player's language):
//   npx tsx scripts/announce.ts "<Arabic>" "<English>" "<French>"
// A language left empty ("") falls back to English, then Arabic, in the apps.
import { announce } from "../src/accounts.js";

const [ar, en, fr] = process.argv.slice(2);
if (!ar && !en && !fr) {
  console.error('usage: npx tsx scripts/announce.ts "<Arabic>" "<English>" "<French>"');
  process.exit(1);
}
console.log(`announced (${(await announce({ ar, en, fr })).id})`);
process.exit(0);

// Makes an account VIP (a VIP host picks his own role in a werewolf room), or takes it back:
//   npx tsx scripts/set-vip.ts <e-mail | username> [off]
// Needs the PocketBase superuser in .env (POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD).
import { setVip } from "../src/accounts.js";

const who = process.argv[2];
if (!who) {
  console.error("usage: npx tsx scripts/set-vip.ts <e-mail | username> [off]");
  process.exit(1);
}
const vip = process.argv[3] !== "off";
console.log(`@${await setVip(who, vip)} is ${vip ? "now" : "no longer"} VIP`);
process.exit(0);

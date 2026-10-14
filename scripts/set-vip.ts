// Makes an account VIP (a VIP watching a werewolf game may talk to the dead), VIP Pro (a VIP too, who also picks
// his own werewolf role, host or not), or takes it back:
//   npx tsx scripts/set-vip.ts <e-mail | username> [pro | off]
// Needs the PocketBase superuser in .env (POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD).
import { setVip } from "../src/accounts.js";

const who = process.argv[2];
if (!who) {
  console.error("usage: npx tsx scripts/set-vip.ts <e-mail | username> [pro | off]");
  process.exit(1);
}
const level = process.argv[3] === "off" ? "off" : process.argv[3] === "pro" ? "pro" : "vip";
const name = await setVip(who, level);
console.log(level === "off" ? `@${name} is no longer VIP` : `@${name} is now ${level === "pro" ? "VIP Pro" : "VIP"}`);
process.exit(0);

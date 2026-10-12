// Makes an account VIP (a VIP host picks his own role in a werewolf room), or takes it back:
//   npx tsx scripts/set-vip.ts <e-mail | username> [off]
import { setVip } from "../src/firebase.js";

const who = process.argv[2];
if (!who) {
  console.error("usage: npx tsx scripts/set-vip.ts <e-mail | username> [off]");
  process.exit(1);
}
const vip = process.argv[3] !== "off";
console.log(`@${await setVip(who, vip)} is ${vip ? "now" : "no longer"} VIP`);
process.exit(0);

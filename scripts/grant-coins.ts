/**
 * Adds coins and diamonds to a player's account, by username (negative numbers take away):
 *   npx tsx scripts/grant-coins.ts <username> <coins> <diamonds>
 * Needs the service account (service-account.json next to package.json).
 */
import { grantCurrency } from "../src/firebase.js";

const [username, coins, diamonds] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
if (!username || !Number.isInteger(coins) || !Number.isInteger(diamonds)) {
  console.error("usage: npx tsx scripts/grant-coins.ts <username> <coins> <diamonds>");
  process.exit(1);
}
const now = await grantCurrency(username, coins, diamonds);
console.log(`${now.name} (@${username}) now has ${now.coins} coins and ${now.diamonds} diamonds`);
process.exit(0);

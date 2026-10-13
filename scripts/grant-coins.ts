/**
 * Adds coins and diamonds to a player's account, by username (negative numbers take away, down to 0 at most):
 *   npx tsx scripts/grant-coins.ts <username> <coins> <diamonds>
 * or to every player (add --dry to only count them):
 *   npx tsx scripts/grant-coins.ts --all <coins> <diamonds> [--dry]
 * Needs the PocketBase superuser in .env (POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD).
 */
import { grantCurrency, grantCurrencyToAll } from "../src/accounts.js";

const [username, coins, diamonds] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
if (!username || !Number.isInteger(coins) || !Number.isInteger(diamonds)) {
  console.error("usage: npx tsx scripts/grant-coins.ts <username | --all> <coins> <diamonds> [--dry]");
  process.exit(1);
}
if (username === "--all") {
  const dry = process.argv[5] === "--dry";
  const count = await grantCurrencyToAll(coins, diamonds, dry);
  console.log(dry ? `${count} players would get ${coins} coins and ${diamonds} diamonds` : `${count} players got ${coins} coins and ${diamonds} diamonds`);
} else {
  const now = await grantCurrency(username, coins, diamonds);
  console.log(`${now.name} (@${username}) now has ${now.coins} coins and ${now.diamonds} diamonds`);
}
process.exit(0);

/**
 * Gives an account every avatar and frame for sale (the owner's, to try them all):
 *   npx tsx scripts/grant-avatars.ts <email>
 * Needs the PocketBase superuser in .env (POCKETBASE_URL, POCKETBASE_SUPERUSER_EMAIL, POCKETBASE_SUPERUSER_PASSWORD).
 */
import { grantAllAvatars } from "../src/accounts.js";

const email = process.argv[2];
if (!email) {
  console.error("usage: npx tsx scripts/grant-avatars.ts <email>");
  process.exit(1);
}
const { count } = await grantAllAvatars(email);
console.log(`${count} avatars and frames given`);
process.exit(0);

/**
 * Gives an account every avatar and frame for sale (the owner's, to try them all):
 *   npx tsx scripts/grant-avatars.ts <email>
 * Needs the service account (service-account.json next to package.json).
 */
import { grantAllAvatars } from "../src/firebase.js";

const email = process.argv[2];
if (!email) {
  console.error("usage: npx tsx scripts/grant-avatars.ts <email>");
  process.exit(1);
}
const { count } = await grantAllAvatars(email);
console.log(`${count} avatars and frames given`);
process.exit(0);

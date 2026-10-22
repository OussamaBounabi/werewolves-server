/**
 * Phone notifications (Firebase Cloud Messaging): a private message or an invitation reaches the friend's phone, the
 * app open or not (the app draws it: its logo, the sender, the text). Needs the Firebase service account:
 * service-account.json next to package.json, or FIREBASE_SERVICE_ACCOUNT (its JSON). Without one nothing is pushed.
 */
import { existsSync, readFileSync } from "node:fs";
import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging, type Messaging } from "firebase-admin/messaging";

let messaging: Messaging | null | undefined;

function fcm() {
  if (messaging !== undefined) return messaging;
  const json = process.env.FIREBASE_SERVICE_ACCOUNT
    ?? (existsSync("service-account.json") ? readFileSync("service-account.json", "utf8") : "");
  messaging = json ? getMessaging(initializeApp({ credential: cert(JSON.parse(json)) }, "push")) : null;
  if (!messaging) console.warn("push: no Firebase service account, no notifications");
  return messaging;
}

const GONE = ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"];

/**
 * Sends [data] to these phones (a data message: the app shows it). Answers the tokens that are dead (app removed…).
 * (FCM refuses some keys in data, "from" among them.)
 */
export async function pushTo(tokens: string[], data: Record<string, string>): Promise<string[]> {
  const m = fcm();
  if (!m || tokens.length === 0) return [];
  const sent = await m.sendEachForMulticast({ tokens, data, android: { priority: "high", ttl: 3_600_000 } });
  return sent.responses.flatMap((r, i) => (!r.success && GONE.includes(r.error?.code ?? "") ? [tokens[i]] : []));
}

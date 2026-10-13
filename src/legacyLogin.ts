import { accountByEmail, moveFromFirebase } from "./accounts.js";

/**
 * E-mail players moving from Firebase, at their first login on the new app. Firebase never gives out
 * passwords, so when PocketBase refuses his login the app sends his e-mail and password here once (POST
 * /api/auth/legacy-login, over HTTPS): Firebase Auth checks them, and his account (copied by
 * scripts/migrate-from-firebase.ts under his Firebase uid) gets that password; the app then logs in to
 * PocketBase as usual. Once an account has a password of its own (brought from Firebase, or reset or
 * changed in PocketBase since the copy), it's never touched here again: PocketBase's hook
 * (pocketbase/pb_hooks/legacy_auth.pb.js) checks that inside the write.
 * Needs FIREBASE_WEB_API_KEY (.env): the Firebase project's Web API key. Once everyone has moved, delete
 * this file and its route, giveFirebasePassword and moveFromFirebase in accounts.ts, the hook (and
 * PocketBase's --hooksDir), and FIREBASE_WEB_API_KEY.
 */
export class LegacyLoginError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 409 | 422 | 429 | 502 | 503) {
    super(message);
  }
}

/** Firebase's verdict on an e-mail and password: his uid, or null if they're wrong. */
export type FirebaseCheck = (email: string, password: string) => Promise<string | null>;

export const firebaseCheck: FirebaseCheck = async (email, password) => {
  const key = process.env.FIREBASE_WEB_API_KEY;
  if (!key) throw new LegacyLoginError("not configured", 503);
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: false }),
    },
  ).catch((): Response | undefined => undefined);
  if (!res) throw new LegacyLoginError("firebase unreachable", 502);
  const body: { localId?: string; error?: { message?: string } } = await res.json().catch(() => ({}));
  if (res.ok && body.localId) return String(body.localId);
  if (String(body?.error?.message ?? "").startsWith("TOO_MANY_ATTEMPTS")) throw new LegacyLoginError("too many attempts", 429);
  if (res.status === 400) return null; // wrong password, unknown e-mail, disabled account…
  throw new LegacyLoginError("firebase unavailable", 502);
};

const MAX_TRIES = 5; // per e-mail…
const TRIES_WINDOW_MS = 15 * 60_000; // …in 15 minutes
const tries = new Map<string, { count: number; since: number }>();

function countTry(email: string): void {
  const now = Date.now();
  if (tries.size > 10_000) for (const [e, t] of tries) if (now - t.since > TRIES_WINDOW_MS) tries.delete(e);
  const t = tries.get(email);
  if (!t || now - t.since > TRIES_WINDOW_MS) {
    tries.set(email, { count: 1, since: now });
    return;
  }
  if (++t.count > MAX_TRIES) throw new LegacyLoginError("too many attempts", 429);
}

/** Moves one e-mail player's password from Firebase to PocketBase. Throws a LegacyLoginError otherwise. */
export async function legacyLogin(emailIn: unknown, passwordIn: unknown, check: FirebaseCheck = firebaseCheck) {
  const email = String(emailIn ?? "").trim().toLowerCase();
  const password = String(passwordIn ?? "");
  if (!email.includes("@") || !password || password.length > 4096) throw new LegacyLoginError("missing e-mail or password", 400);
  countTry(email);
  const account = await accountByEmail(email);
  if (account && !account.waiting) throw new LegacyLoginError("already moved", 409); // Firebase isn't asked
  const uid = await check(email, password);
  if (!uid) throw new LegacyLoginError("wrong e-mail or password", 401);
  if (account && account.id !== uid) throw new LegacyLoginError("another account has this e-mail", 409);
  const result = await moveFromFirebase(uid, email, password);
  if (result === "already moved") throw new LegacyLoginError("already moved", 409);
  // PocketBase refuses the password itself (longer than 71 characters): he resets it by e-mail.
  if (result === "bad password") throw new LegacyLoginError("password not accepted", 422);
  if (result === "no hook") {
    console.error("legacy login refused: PocketBase runs without pocketbase/pb_hooks (--hooksDir), see README");
    throw new LegacyLoginError("not configured", 503);
  }
  tries.delete(email);
}

/**
 * VIP perks the rooms share: who may put whom out of a waiting room, a VIP Pro host's name and style for his room in
 * the lists, and emojis for VIPs only (once the owner turns it on in the store's plan).
 */
import { currentPlans, saveRoomLook, useProKick, type Account } from "../accounts.js";
import { storeNow } from "../plans.js";

type Face = { uid: string; vip?: string }; // vip: "" | "vip" | "pro"

/**
 * Why [kicker] may not put [target] out of the waiting room (null: he may). The host may; so may a VIP Pro who isn't
 * the host, 3 times a month (this spends one); a VIP Pro is only put out by a VIP Pro.
 */
export async function kickRefusal(kicker: Face, host: boolean, target: Face): Promise<string | null> {
  if (target.vip === "pro" && kicker.vip !== "pro") return "kick_pro";
  if (host) return null;
  if (kicker.vip !== "pro") return "not_host";
  return (await useProKick(kicker.uid)) ? null : "kick_none_left";
}

export const ROOM_STYLES = ["gold", "blue", "purple", "pink", "green", "red"];

/** A VIP Pro host's room name and style, checked ("": the usual card in the lists). */
export function roomLook(msg: unknown) {
  const m = (msg ?? {}) as { name?: unknown; style?: unknown };
  return {
    name: typeof m.name === "string" ? m.name.replace(/\s+/g, " ").trim().slice(0, 24) : "",
    style: ROOM_STYLES.includes(m.style as string) ? (m.style as string) : "",
  };
}

type Look = ReturnType<typeof roomLook>;
const NO_LOOK: Look = { name: "", style: "" };

/**
 * The VIP Pro hosts' looks: kept on their accounts, so every room one hosts wears his until he changes it. A room wears
 * its host's (none when the host isn't VIP Pro), so it follows the host when the host changes.
 */
export class RoomLooks {
  private bySession = new Map<string, { uid: string; look: Look }>();

  /** Someone joined: a VIP Pro's saved look, ready for when he hosts. */
  join(id: string, account: Account | null | undefined) {
    if (account?.vipPro) this.bySession.set(id, { uid: account.uid, look: roomLook(account.roomLook) });
  }

  /** A VIP Pro changed his: the room wears it at once, his account keeps it. False: not a VIP Pro. */
  set(id: string, msg: unknown) {
    const pro = this.bySession.get(id);
    if (!pro) return false;
    pro.look = roomLook(msg);
    saveRoomLook(pro.uid, pro.look).catch((e) => console.warn("room look not saved", e));
    return true;
  }

  /** The room's: its host's. */
  of(hostId: string) {
    return this.bySession.get(hostId)?.look ?? NO_LOOK;
  }
}

/** Whether a player ([vip]: a VIP or a VIP Pro) may send emojis: everyone may, until the owner keeps them for VIPs. */
export const emojisOpen = (vip: boolean) => vip || !storeNow(currentPlans().store).emojisVipOnly;

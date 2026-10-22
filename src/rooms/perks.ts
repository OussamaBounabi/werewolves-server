/**
 * VIP perks the rooms share: who may put whom out of a waiting room (and a VIP Pro's choice to stay), a VIP Pro host's
 * name and style for his room in the lists, and emojis for VIPs only (once the owner turns it on in the store's plan).
 */
import type { Client, Room } from "colyseus";
import {
  currentPlans, proKicksLeft, proStaysLeft, saveRoomLook, useProKick, useProStay, type Account,
} from "../accounts.js";
import { storeNow } from "../plans.js";

type Face = { uid: string; vip?: string }; // vip: "" | "vip" | "pro"

/** Seconds a VIP Pro has to choose between leaving and staying when someone tries to put him out. */
export const STAY_SECONDS = 15;

/**
 * Kicks out of a waiting room. The host may kick; so may a VIP Pro who isn't the host, PRO_KICKS times a month (spent
 * only when the player goes). A VIP Pro with a stay left this month is asked first ("kick_asked" { by, seconds,
 * stays }, answered by "kick_answer" { stay }): he stays (one stay spent, and nobody may put him out of this room
 * again) or leaves (no answer in time: he leaves too), as having left, not kicked.
 */
export class Kicks {
  private stayed = new Set<string>(); // the VIP Pros who chose to stay here (by account)
  private asking = new Map<string, (stay: boolean) => void>(); // connection → his answer

  constructor(
    private room: Room,
    private month = { kicksLeft: proKicksLeft, staysLeft: proStaysLeft, useKick: useProKick, useStay: useProStay }, // (tests)
  ) {
    room.onMessage("kick_answer", (client, msg: { stay?: boolean }) => this.asking.get(client.sessionId)?.(msg?.stay === true));
  }

  /**
   * Whether [kicker] ([host] or not) puts [target] out: { code } a refusal for the kicker's app, "kicked", or "left" (a
   * VIP Pro who chose to go). [connection]: the target's.
   */
  async decide(kicker: Face, kickerName: string, host: boolean, target: Face, connection?: Client) {
    if (!host && (kicker.vip !== "pro" || (await this.month.kicksLeft(kicker.uid)) === 0)) {
      return { code: kicker.vip === "pro" ? "kick_none_left" : "not_host" };
    }
    let how: "kicked" | "left" = "kicked";
    if (target.vip === "pro") {
      if (target.uid && this.stayed.has(target.uid)) return { code: "kick_pro_stayed" };
      if (connection && this.asking.has(connection.sessionId)) return { code: "kick_pro_asking" };
      const stays = connection ? await this.month.staysLeft(target.uid) : 0;
      if (stays > 0 && connection) {
        connection.send("kick_asked", { by: kickerName, seconds: STAY_SECONDS, stays });
        const stay = await new Promise<boolean>((resolve) => {
          const timer = this.room.clock.setTimeout(() => resolve(false), STAY_SECONDS * 1000);
          this.asking.set(connection.sessionId, (answer) => (timer.clear(), resolve(answer)));
        });
        this.asking.delete(connection.sessionId);
        if (stay && (await this.month.useStay(target.uid))) {
          this.stayed.add(target.uid);
          return { code: "kick_pro_stayed" };
        }
        if (!stay) how = "left";
      }
    }
    if (!host) await this.month.useKick(kicker.uid);
    return how;
  }
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

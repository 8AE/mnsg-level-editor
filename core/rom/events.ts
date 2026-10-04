import type { ActorData, EventData } from "../../shared/types";

/** Native call paths verified in Ghidra; this is deliberately a partial catalog. */
export function actorEvent(actor: ActorData): EventData | undefined {
  let name: string, kind: string;
  switch (actor.actorId) {
    case 0x226: {
      // 08000000_70C820 -> 0800032C_70CB4C selects temporary/save flag setters.
      const mode = actor.parameters[1] >>> 24, flag = actor.parameters[0] >>> 16;
      if (mode !== 0 && mode !== 1) return undefined;
      name = `Pressure switch · ${mode === 0 ? "temporary" : "save"} flag 0x${flag.toString(16).toUpperCase()}`;
      kind = "pressure-switch"; break;
    }
    case 0x23c:
    case 0x242:
    case 0x23f: {
      // File43 entries 0800000C/08001D6C/08004750 reach contact/travel 08002254.
      const subtype = actor.parameters[0] >>> 24;
      if (actor.actorId === 0x23c && subtype > 1) return undefined;
      if (actor.actorId === 0x242 && (subtype > 11 || (actor.parameters[0] & 255) === 1)) return undefined;
      if (actor.actorId === 0x23f && subtype > 4) return undefined;
      name = `Travel door · destination room 0x${(actor.parameters[2] >>> 16).toString(16).toUpperCase()}`;
      kind = "room-transition"; break;
    }
    case 0x34a:
      // 08004ED4_6C4624 -> 08004F74_6C46C4 -> 80023E94(0).
      name = "Flag-driven rising platform · room temporary flag 0"; kind = "mechanism"; break;
    case 0x34b:
      // 080060A0_6F9580 chooses wait-save-A4 or local-contact exit continuation.
      name = "Story-gated exit · save flag 0xA4 / local contact"; kind = "story-gate"; break;
    case 0x23d: {
      // 08003038_6F6518 -> 08003410_6F68F0: payload first byte controls subtype.
      const subtype = actor.parameters[0] >>> 24;
      if (![1, 3, 4].includes(subtype)) return undefined;
      name = `Breakable barrier · subtype ${subtype}${subtype === 3 ? " / save flag 0x1C2" : subtype === 4 ? " / save flag 0x1C3" : ""}`;
      kind = "hit-trigger"; break;
    }
    case 0x3d6:
      // 08002514_723B34 -> 080025A8_723BC8 -> 0800266C_723C8C.
      name = "Silver Doll container · hit/contact, save flag 0xEE / temporary flag 2"; kind = "hit-trigger"; break;
    default: return undefined;
  }
  if (!actor.definitionSource) return undefined;
  return { id: `event:${actor.id}`, actorRef: actor.id, index: actor.index, name, kind,
    position: { ...actor.position }, values: [...actor.parameters], source: { ...actor.definitionSource }, editable: false };
}

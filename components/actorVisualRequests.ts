import type { ActorOverride, ActorVisualPayload, AppApi } from "../shared/types";

/** Each effect owns one response; canceled requests never replace newer visuals. */
export function requestActorVisuals(
  load: AppApi["loadActorVisuals"], roomId: number, overrides: Record<string, ActorOverride>,
  accept: (payload: ActorVisualPayload) => void, fail: (error: unknown) => void, finish: () => void,
): () => void {
  let active = true;
  void Promise.resolve().then(() => load(roomId, overrides)).then(payload => { if (active) accept(payload); }).catch(error => { if (active) fail(error); }).finally(() => { if (active) finish(); });
  return () => { active = false; };
}

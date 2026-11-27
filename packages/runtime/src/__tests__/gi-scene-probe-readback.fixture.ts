import type { SceneGiSubmission } from './gi-scene-support-readback.fixture';

export interface SceneProbeReadback {
  readonly meta: Uint8Array;
  readonly list: Uint8Array;
  /** Observation-local identities, not RHI resource IDs. */
  readonly metaIdentity: number;
  readonly listIdentity: number;
  readonly count: number;
  readonly capacity: number;
}

/** Required diagnostics fail before resource lookup; they cannot borrow an older producer. */
export function sceneProbeReadbackLayout(
  previous: SceneGiSubmission | undefined,
  current: SceneGiSubmission,
  count: number,
  capacity: number,
) {
  if (
    previous?.gather !== 'irradiance-field' ||
    current.gather !== 'irradiance-field' ||
    previous.state !== 'ready' ||
    current.state !== 'ready' ||
    !Number.isSafeInteger(current.generation) ||
    current.generation === undefined ||
    current.generation < 0 ||
    current.generation !== previous.generation ||
    !Number.isSafeInteger(previous.submittedFrames) ||
    !Number.isSafeInteger(current.submittedFrames) ||
    !(previous.submittedFrames !== undefined && previous.submittedFrames > 0) ||
    current.submittedFrames !== previous.submittedFrames + 1 ||
    !Number.isSafeInteger(count) ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1 ||
    count < capacity
  )
    throw new Error('Probe observation requires the same current generation and one new producer');
  const metaBytes = count * 16;
  const listBytes = capacity * 4;
  if (metaBytes + listBytes > (1024 * 1024) / 32)
    throw new Error('Probe observation exceeds the 32-frame 1 MiB diagnostic raw cap');
  return { metaBytes, listBytes };
}

/** Resource replacement, truncation, and stale aliases cannot join one diagnostic series. */
export function requireSceneProbeReadback(
  previous: SceneProbeReadback | undefined,
  current: SceneProbeReadback,
): void {
  if (
    current.meta.byteLength !== current.count * 16 ||
    current.list.byteLength !== current.capacity * 4 ||
    !Number.isSafeInteger(current.metaIdentity) ||
    !Number.isSafeInteger(current.listIdentity) ||
    current.metaIdentity <= 0 ||
    current.listIdentity <= 0 ||
    current.metaIdentity === current.listIdentity ||
    (previous !== undefined &&
      (previous.metaIdentity !== current.metaIdentity ||
        previous.listIdentity !== current.listIdentity ||
        previous.count !== current.count ||
        previous.capacity !== current.capacity))
  )
    throw new Error('Probe observation resource identity or extent changed');
}

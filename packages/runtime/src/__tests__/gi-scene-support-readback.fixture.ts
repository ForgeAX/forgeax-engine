export interface SceneGiSubmission {
  readonly gather?: string;
  readonly state?: string;
  readonly generation?: number;
  readonly submittedFrames?: number;
}

/** Private observation owns no cached signal when this receipt ran no GI producer. */
export async function sceneSupportForReceipt(
  previous: SceneGiSubmission | undefined,
  current: SceneGiSubmission,
  pixels: number,
  read: () => Promise<Float32Array>,
): Promise<Float32Array> {
  const count = current.submittedFrames;
  const generation = current.generation;
  const sameGeneration = previous?.gather === current.gather && previous?.generation === generation;
  const currentProducer =
    (current.gather === 'irradiance-field' || current.gather === 'screen-probe') &&
    current.state === 'ready' &&
    typeof generation === 'number' &&
    Number.isSafeInteger(generation) &&
    typeof count === 'number' &&
    Number.isSafeInteger(count) &&
    count > 0;
  if (currentProducer && (!sameGeneration || count > (previous?.submittedFrames ?? Infinity))) {
    const signal = await read();
    if (signal.length !== pixels * 4) throw new Error('Current scene GI signal extent mismatch');
    return signal;
  }
  // Absence of a producer is unavailable evidence, never a resolved black hit.
  const unavailable = new Float32Array(pixels * 4);
  for (let p = 0; p < pixels; p++) unavailable[p * 4 + 3] = -1;
  return unavailable;
}

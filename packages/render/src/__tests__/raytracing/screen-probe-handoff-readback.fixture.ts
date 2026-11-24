/** Decode the first 32-byte ray in two whole-buffer snapshots and the diagnostic vec4. */
export function decodeHandoffReadback(bytes: ArrayBuffer, rayBufferBytes: number) {
  const values = new Float32Array(bytes),
    words = new Uint32Array(bytes);
  const offset = rayBufferBytes / 4;
  const screenStatus = words[3],
    worldStatus = words[offset + 3];
  if (screenStatus === undefined || worldStatus === undefined)
    throw new Error('Screen Probe handoff readback omitted a ray status');
  const hitDistance = values[offset + 7];
  if (hitDistance === undefined) throw new Error('Screen Probe handoff omitted a hit distance');
  return {
    values,
    offset,
    screenStatus,
    worldStatus,
    hitDistance,
    cardTag: values[(rayBufferBytes * 2) / 4 + 3] ?? NaN,
  };
}

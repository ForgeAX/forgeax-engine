/** CPU fixture for the shared two-UNORM16 scene velocity texture. */
export function sceneVelocityWord(x: number, y: number): number {
  const lane = (v: number) =>
    Math.max(
      0,
      Math.min(
        0xffff,
        Math.round(32767 + Math.sign(v) * Math.sqrt(4 * Math.abs(v)) * 0.2495 * 65535),
      ),
    );
  return Math.max(1, (lane(x) | (lane(-y) << 16)) >>> 0);
}

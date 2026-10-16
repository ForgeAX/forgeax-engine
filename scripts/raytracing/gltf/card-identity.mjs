/** Instrument the canonical cooked Card shader without changing material evaluation.
 * RGB stores three exact primitive-index bytes; alpha stores section + 1.
 * This replaces emission/metallic and must never feed a lighting consumer. */
export function instrumentCardIdentity(wgsl, section) {
  if (!Number.isInteger(section) || section < 0 || section >= 2048)
    throw Error('Card identity section exceeds exact f16 encoding');
  let code = wgsl;
  const replaceOnce = (pattern, replacement) => {
    if ([...code.matchAll(pattern)].length !== 1) throw Error('expected one Card capture site');
    code = code.replace(pattern, replacement);
  };
  replaceOnce(
    /(@location\(9\) tangentWS: vec4<f32>,)/g,
    '$1\n    @location(10) @interpolate(flat) probeIdentity: vec2<u32>,',
  );
  replaceOnce(/(return CardVertex\([^\n]*)(\);)/g, `$1, vec2u(tri.ids.z, ${section + 1}u)$2`);
  replaceOnce(
    /([A-Za-z0-9_]+)\.emissionMetallic(?=, vec4<f32>)/g,
    'vec4f(f32(v_1.probeIdentity.x & 255u), f32((v_1.probeIdentity.x >> 8u) & 255u), f32((v_1.probeIdentity.x >> 16u) & 255u), f32(v_1.probeIdentity.y))',
  );
  return code;
}

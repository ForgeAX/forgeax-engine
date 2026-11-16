import { createMeshBuilder } from '@forgeax/engine/geometry';

/** Authored hull surface; native mass and collision remain stage-owned. */
export function harborHull(lengthM: number, beamM: number) {
  const position: number[] = [];
  const uv: number[] = [];
  const indices: number[] = [];
  const sections = 32;
  const chines = 12;
  for (let section = 0; section <= sections; section++) {
    const t = section / sections;
    const x = (t - 0.5) * lengthM;
    const stern = Math.min(1, 0.72 + t * 2);
    const bow = Math.sqrt(Math.max(0.0004, 1 - t ** 5));
    const halfBeam = beamM * 0.5 * stern * bow;
    for (let chine = 0; chine <= chines; chine++) {
      const a = (chine / chines) * Math.PI;
      position.push(x, 0.26 - Math.sin(a) * (0.58 - t * t * 0.18), -Math.cos(a) * halfBeam);
      uv.push(t * 3, chine / chines);
      if (section < sections && chine < chines) {
        const p = section * (chines + 1) + chine;
        indices.push(p, p + chines + 1, p + 1, p + 1, p + chines + 1, p + chines + 2);
      }
    }
  }
  for (const section of [0, sections]) {
    const start = section * (chines + 1);
    for (let chine = 1; chine < chines; chine++) {
      if (section === 0) indices.push(start, start + chine + 1, start + chine);
      else indices.push(start, start + chine, start + chine + 1);
    }
  }
  return createMeshBuilder({
    attributes: { position: new Float32Array(position), uv: new Float32Array(uv) },
    indices,
  })
    .build()
    .unwrap();
}

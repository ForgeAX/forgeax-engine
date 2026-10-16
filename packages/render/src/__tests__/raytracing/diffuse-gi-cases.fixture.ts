import { expect } from 'vitest';
import type { DiffuseGiFixture } from './diffuse-gi.commands';
import { giSettings, giSource, runGi } from './diffuse-gi.fixture';

const row = (bytes: Uint8Array, index: number) =>
  new Float32Array(bytes.buffer, bytes.byteOffset + index * 80, 20);
export async function verifyGiEnergy(fixture: DiffuseGiFixture) {
  const white = giSource(fixture, 'white', 0, [0, 0, -0.5], [3, 3, 0.5]);
  const environment = [0.5, 1, 2] as const;
  const constant = await runGi(fixture, {
    sources: [white],
    lights: false,
    settings: { environment },
  });
  for (let i = 0; i < 256; i++)
    for (const bytes of [constant.field, constant.reference]) {
      expect(new Uint32Array(bytes.buffer)[i * 20 + 16]).toBe(1);
      const p = row(bytes, i);
      for (let c = 0; c < 3; c++) {
        expect(p[4 + c]).toBeCloseTo(environment[c] ?? Number.NaN, 4);
        expect(p[12 + c]).toBeCloseTo((p[8 + c] ?? Number.NaN) * (environment[c] ?? Number.NaN), 4);
      }
    }
  const metal = await runGi(fixture, {
    sources: [giSource(fixture, 'metal', 0, [0, 0, -0.5], [3, 3, 0.5])],
    lights: false,
    settings: { environment, iterations: 1 },
  });
  for (let i = 0; i < 256; i++) {
    const p = row(metal.reference, i);
    expect(Array.from(p.slice(8, 11))).toEqual([0, 0, 0]);
    expect(Array.from(p.slice(12, 15))).toEqual([0, 0, 0]);
  }
  const surface = new Float32Array(metal.surface.buffer);
  const status = new Uint32Array(metal.surface.buffer);
  expect(surface[4]).toBeGreaterThan(0.2);
  expect(status[13]).toBe(1);
  return { constant, metal };
}
export async function verifyGiChanges(fixture: DiffuseGiFixture) {
  const lit = await runGi(fixture);
  const off = await runGi(fixture, { lights: false });
  for (let i = 0; i < 256; i++)
    for (const bytes of [off.field, off.reference])
      expect(Array.from(row(bytes, i).slice(12, 15))).toEqual([0, 0, 0]);
  const cut = await runGi(fixture, {
    settings: {
      resolution: 8,
      view: { ...giSettings.view, origin: [-1, 1, 8], width: 2, height: 2 },
    },
  });
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      for (const name of ['field', 'reference'] as const) {
        const a = row(lit[name], (y + 4) * 16 + x + 4),
          b = row(cut[name], y * 8 + x);
        for (let c = 4; c < 15; c++) expect(b[c]).toBeCloseTo(a[c] ?? Number.NaN, 5);
      }
  return { lit, off, cut };
}
export async function verifyGiOcclusion(fixture: DiffuseGiFixture) {
  const receiver = giSource(fixture, 'white', 0, [0, 0, -0.5], [3, 3, 0.5]),
    red = giSource(fixture, 'red', 1, [-4, 0, 3], [0.5, 2, 2]);
  const wall = giSource(fixture, 'black', 2, [-2.75, 0, 3], [0.25, 5, 4]);
  const closed = await runGi(fixture, { sources: [receiver, red, wall] });
  let complete = 0;
  for (let i = 0; i < 256; i++) {
    const state = new Uint32Array(closed.field.buffer)[i * 20 + 16];
    if (state === 1) complete++;
    // White specular grazing in the admitted Standard black is a nonzero transport proxy.
    expect(row(closed.field, i)[4]).toBeLessThan(0.025);
    expect(row(closed.reference, i)[4]).toBeLessThan(0.025);
  }
  expect(complete).toBeGreaterThan(128);
  const missing = await runGi(fixture, {
    sources: [receiver],
    lights: false,
    settings: { environment: [1, 1, 1] },
    scene: [
      { ...receiver.instance, field: receiver.field },
      {
        instanceId: 99,
        geometryId: 99,
        mask: 255,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        field: { missing: true, bounds: { min: [-3, -3, 1], max: [3, 3, 2] } },
      },
    ],
  });
  for (let i = 0; i < 256; i++)
    for (const bytes of [missing.field, missing.reference])
      expect(new Uint32Array(bytes.buffer)[i * 20 + 16]).toBe(2);
  return { closed, missing };
}

export async function verifyGiPunctual(fixture: DiffuseGiFixture) {
  const { vec3 } = await import('@forgeax/engine-math');
  const source = giSource(fixture, 'white', 0, [0, 0, -0.5], [3, 3, 0.5]);
  const point = {
    kind: 'point' as const,
    position: vec3.create(3, 0, 3),
    color: vec3.create(Math.PI, Math.PI, Math.PI),
    intensity: Math.PI,
    invRangeSquared: 0,
  };
  const spot = {
    ...point,
    kind: 'spot' as const,
    direction: vec3.create(-1, 0, -1),
    cosInner: 0.95,
    cosOuter: 0.9,
    castShadow: false,
    lightViewProj: undefined,
    mapSize: 2048,
    nearPlane: 0.1,
    farPlane: 50,
    shadowAtlasTile: -1,
  };
  const a = await runGi(fixture, { sources: [source], lights: [point] });
  const b = await runGi(fixture, { sources: [source], lights: [spot] });
  const blocked = await runGi(fixture, {
    sources: [source, giSource(fixture, 'black', 1, [1.5, 0, 1.5], [0.4, 0.5, 0.15])],
    lights: [point],
  });
  const center = 8 * 16 + 8;
  expect(row(a.reference, center)[0]).toBeGreaterThan(0.025);
  expect(row(b.reference, center)[0]).toBeCloseTo(row(a.reference, center)[0] ?? Number.NaN, 5);
  expect(row(blocked.reference, center)[0]).toBe(0);
}

/** Unusable probe support must trigger a local final gather, not leave a dark border. */
export async function verifyGiFallback(fixture: DiffuseGiFixture) {
  const result = await runGi(fixture, { settings: { probeOrigin: [20, 20, 20] } });
  const field = new Float32Array(result.field.buffer),
    reference = new Float32Array(result.reference.buffer);
  const status = new Uint32Array(result.field.buffer),
    referenceStatus = new Uint32Array(result.reference.buffer);
  expect(
    Array.from({ length: 256 }, (_, i) => status[i * 20 + 16]).filter((s) => s === 1).length,
  ).toBeGreaterThan(128);
  for (let i = 0; i < 256; i++) {
    expect(status[i * 20 + 16]).toBe(referenceStatus[i * 20 + 16]);
    expect(status[i * 20 + 17]).toBe(0);
    for (let c = 4; c < 15; c++)
      expect(field[i * 20 + c]).toBeCloseTo(reference[i * 20 + c] ?? Number.NaN, 5);
  }
}

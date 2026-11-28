import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { bakeMaps, bakeSources } from '../bake';
import { tsBakeBackend } from '../compute/bake-ts';
import type { BakeJobParams } from '../compute/job';
import { runComputeJob } from '../compute/job';
import { model } from '../model';
import { sel } from '../selectors';
import { surfaceOf, texelFrames } from './bake-gates';

/**
 * A flat base cap over a comb of thin fins with gaps. A cap texel over a gap has no facing
 * detail surface within reach, so its nearest point is a fin wall: the old bake kept that wall
 * normal (tilted up to 90 degrees off the cap). The normal decision writes the flat base normal
 * instead and counts the sample as `flat`.
 */
const RES = 64;
const FINS = 6;
const TILT_OK = 5;

function plate() {
  const base = model();
  base.box({ size: [1, 0.06, 1] });
  base.markSharp(sel.edges.dihedral('>', 40));
  base.uv.auto({ resolution: RES, padding: 2 });
  return base;
}

function comb() {
  const detail = model();
  const w = 1 / FINS;
  for (let i = 0; i < FINS; i++) {
    detail.box({
      size: [w * 0.5, 0.04, 0.98],
      position: [-0.5 + w * (i + 0.5), 0, 0],
    } as never);
  }
  return detail;
}

const CAGE = { offset: 0.017, maxRay: 0.034 };
const NORMALS = { mode: 'autoSmooth', angle: 40 } as const;

/** Degrees between the decoded normal-map z axis of each texel and the cap normal (0,0,1). */
function tiltsOf(texture: TextureAsset, frames: ReturnType<typeof texelFrames>): number[] {
  const data = texture.data as Uint8Array;
  return frames.map((f) => {
    const z = (data[(f.y * RES + f.x) * 4 + 2] as number) / 127.5 - 1;
    return (Math.acos(Math.min(1, Math.max(-1, z))) * 180) / Math.PI;
  });
}

describe('bake: flat cap over a slotted detail keeps no detail wall', () => {
  const base = plate();
  const detail = comb();
  const frames = texelFrames(surfaceOf(base), RES);

  it('writes the flat base normal over gap texels and counts them as flat', () => {
    const r = bakeMaps({
      base,
      detail,
      maps: ['normal'],
      resolution: RES,
      filter: 'none',
      cage: CAGE,
      direction: 'averaged',
      normals: NORMALS,
    });
    if (!r.ok) throw r.error;
    const group = r.value.provenance.groups[0];
    expect(group).toBeDefined();
    const b = group?.branches;
    expect(b).toBeDefined();
    expect((b?.cage ?? 0) + (b?.base ?? 0) + (b?.extended ?? 0) + (b?.flat ?? 0)).toBe(
      group?.samples,
    );
    expect(b?.flat ?? 0).toBeGreaterThan(0);
    // The gap texels are the flat ones; every texel of the map stays within the tolerance.
    const tilts = tiltsOf(r.value.textures.normal as TextureAsset, frames);
    expect(Math.max(...tilts)).toBeLessThan(TILT_OK);
    expect(tilts.filter((t) => t > TILT_OK).length).toBe(0);
    // Flat share above the stated share reports the group as a warning.
    expect(
      r.value.issues.some((i) => i.code === 'ray-miss' && i.detail?.check === 'flat-fallback'),
    ).toBe(true);
  });

  it('must fail on the old path: without the normal decision, wall hits reach the map', () => {
    const sources = bakeSources({
      base,
      detail,
      maps: ['normal'],
      resolution: RES,
      filter: 'none',
      cage: CAGE,
      direction: 'averaged',
      normals: NORMALS,
      key: 'capflat',
    });
    if (!sources.ok) throw sources.error;
    const params = (sources.value['texture/capflat-normal']?.source as { params: BakeJobParams })
      .params;
    const raw = runComputeJob(
      {
        kind: 'bake',
        inputs: [base.snapshot(), detail.snapshot()],
        params: { ...params, rawCage: true },
      },
      tsBakeBackend,
    );
    if (!raw.ok) throw raw.error;
    const values = new Float32Array((raw.value.outputs[0] as Uint8Array).slice().buffer);
    const tilts = frames.map((f) => {
      const z = (values[(f.y * RES + f.x) * 4 + 2] as number) * 2 - 1;
      return (Math.acos(Math.min(1, Math.max(-1, z))) * 180) / Math.PI;
    });
    // The old path keeps wall normals on cap texels: this is the kept-wall count that must be zero
    // on the fixed path and positive here.
    expect(tilts.filter((t) => t > TILT_OK).length).toBeGreaterThan(0);
  });
});

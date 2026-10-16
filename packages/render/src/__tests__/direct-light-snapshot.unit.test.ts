import { readFile } from 'node:fs/promises';
import type { Vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { packDirectLightSlot } from '../light-buffer-layout';
import type { SpotLightSnapshot } from '../render-system-extract';

const snapshot: SpotLightSnapshot = {
  kind: 'spot',
  position: new Float32Array([0, 2, 0]) as Vec3,
  direction: new Float32Array([0, 1, 0]) as Vec3,
  color: new Float32Array([2, 1, 0.5]) as Vec3,
  intensity: 2,
  invRangeSquared: 0.01,
  cosInner: 0.98,
  cosOuter: 0.7,
  castShadow: false,
  lightViewProj: undefined,
  mapSize: 2048,
  nearPlane: 0.1,
  farPlane: 50,
  shadowAtlasTile: -1,
};

describe('one direct-light snapshot proof', () => {
  it('passes the same snapshot identity to URP and HDRP buffer owners', () => {
    const consumed: SpotLightSnapshot[] = [];
    const consume = (value: SpotLightSnapshot) => {
      consumed.push(value);
      return {
        urp: packDirectLightSlot(value),
        hdrp: packDirectLightSlot(value),
      };
    };

    const packed = consume(snapshot);

    expect(consumed).toEqual([snapshot]);
    expect(packed.urp[8]).toBe(0);
    expect(packed.urp[9]).toBe(1);
    expect(packed.hdrp[8]).toBe(0);
    expect(packed.hdrp[9]).toBe(1);
  });

  it('keeps extract and shader owners single-source', async () => {
    const extract = await readFile(
      new URL('../extract/world-environment.ts', import.meta.url),
      'utf8',
    );
    const lighting = await readFile(
      new URL('../record/frame-lighting.ts', import.meta.url),
      'utf8',
    );
    const shader = await readFile(
      new URL('../../../shader/src/standard-cluster.wgsl', import.meta.url),
      'utf8',
    );

    expect(extract.match(/const spotLightQuery =/g)).toHaveLength(1);
    expect(extract).toContain('direction: dirN');
    expect(lighting).toMatch(/packDirectLightSlot\(/);
    expect(lighting).toContain('prepareStandardLighting');
    expect(lighting).toContain('source');
    expect(shader).not.toContain('normalize(light.direction.xyz)');
  });
});

const snapshots = [
  {
    kind: 'point',
    sortKey: 20,
    position: [0, 1, 0],
    color: [1, 1, 1],
    invRangeSquared: 0.01,
    shadowAtlasLayer: -1,
  },
  {
    kind: 'spot',
    sortKey: 10,
    position: [0, 2, 0],
    color: [1, 1, 1],
    direction: [0, -1, 0],
    invRangeSquared: 0.01,
    cosInner: 0.9,
    cosOuter: 0.7,
    shadowAtlasTile: -1,
  },
  {
    kind: 'rect-area',
    sortKey: 30,
    position: [0, 3, 0],
    color: [1, 1, 1],
    invRangeSquared: 0.01,
    halfWidth: 1,
    halfHeight: 1,
    axisX: [1, 0, 0],
    axisY: [0, 1, 0],
  },
] as const;

describe('direct light snapshot consumers', () => {
  it('keeps one deterministic order for non-cluster and clustered paths', () => {
    const ordered = [...snapshots].sort((left, right) => left.sortKey - right.sortKey);
    expect(ordered.map((value) => value.kind)).toEqual(['spot', 'point', 'rect-area']);

    const packed = ordered.map((value) => packDirectLightSlot(value as never));
    expect(packed).toHaveLength(3);
    expect(packed.every((slot) => slot.byteLength === 96)).toBe(true);
  });

  it('requires both direct and cluster consumers to name the same packer', async () => {
    const frameLighting = await readFile(
      new URL('../record/frame-lighting.ts', import.meta.url),
      'utf8',
    );
    const clusterBinner = await readFile(new URL('../cluster-binner.ts', import.meta.url), 'utf8');

    expect(frameLighting).toContain('packDirectLightSlot');
    expect(clusterBinner).toContain('deriveCullingRadius');
  });
});

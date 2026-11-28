import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toPng } from '../../brep-kit/image.ts';
import { renderScene } from '../render.ts';
import { SCENE_ASSETS, SCENE_PLACEMENTS } from '../scene.ts';
import { buildManifest, writeOutputs } from '../run.ts';
import { sceneTrianglesAt } from '../../../src/scene-manifest.ts';

describe('scene-manifest example', () => {
  const manifest = buildManifest();

  it('places 38 instances over 3 assets, one of them mirrored', () => {
    expect(SCENE_PLACEMENTS).toHaveLength(38);
    expect(manifest.totals.instances).toBe(38);
    expect(manifest.totals.uniqueAssets).toBe(3);
    expect(manifest.instances.filter((i) => i.mirrored)).toHaveLength(1);
  });

  it('counts LOD0 triangles per placement and the unique geometry once', () => {
    const lod0 = new Map(manifest.assets.map((a) => [a.id, a.triangles]));
    const expected = manifest.instances.reduce((n, i) => n + (lod0.get(i.asset) ?? 0), 0);
    expect(manifest.totals.trianglesLod0).toBe(expected);
    expect(manifest.totals.trianglesUnique).toBe([...lod0.values()].reduce((n, v) => n + v, 0));
    expect(manifest.totals.trianglesLowest).toBeLessThanOrEqual(manifest.totals.trianglesLod0);
  });

  it('matches the draw-call totals of both instancing settings', () => {
    expect(manifest.totals.drawCallsPerInstance).toBeGreaterThanOrEqual(manifest.totals.drawCallsInstanced);
  });

  it('serialises without loss', () => {
    expect(JSON.parse(JSON.stringify(manifest))).toStrictEqual(manifest);
  });

  it('draws fewer triangles from far away than near', () => {
    const near = sceneTrianglesAt(manifest, [0, -5, 0]);
    const far = sceneTrianglesAt(manifest, [0, -500, 0]);
    expect(far).toBeLessThanOrEqual(near);
  });

  it('renders iso and top pictures that contain scene pixels', () => {
    const pictures = renderScene(manifest, SCENE_ASSETS);
    for (const picture of Object.values(pictures)) {
      expect(picture.image.width).toBeGreaterThan(0);
      const covered = picture.mask.reduce((n, v) => n + (v ? 1 : 0), 0);
      expect(covered).toBeGreaterThan(0);
      expect(toPng(picture.image).length).toBeGreaterThan(1000);
    }
  });

  it('writes scene.json and two pictures through the output helper', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scene-manifest-'));
    writeOutputs(dir, manifest);
    expect(existsSync(join(dir, 'scene.json'))).toBe(true);
    expect(statSync(join(dir, 'scene-iso.png')).size).toBeGreaterThan(1000);
    expect(statSync(join(dir, 'scene-top.png')).size).toBeGreaterThan(1000);
    expect(JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8'))).toStrictEqual(manifest);
  });
});

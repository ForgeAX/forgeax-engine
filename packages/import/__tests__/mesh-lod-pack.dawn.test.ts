import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMeshBinary } from '@forgeax/engine-geometry';
import {
  buildScriptablePack,
  createStandardAssetOutputProducerRegistry,
} from '../src/index.js';
import {
  generatePackMeshLods,
  type MeshLodGenerationReport,
} from '../src/mesh-lod-generator.js';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import type { MeshAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { createCaseRenderer, frame } from '../../modeling/examples/case/render.ts';
import { WHEEL_RIM_LODS } from './fixtures/wheel-rim-lod.pack.ts';

/**
 * Case C-015 (design X4): a modeling Pack requests LODs with `generatePackMeshLods`;
 * the real Pack loader and Import Mesh producer publish the root and every level as
 * ordinary mesh-binary assets, and the real Renderer draws each decoded level from
 * one camera. With FORGEAX_CASE_OUT set it writes the Modeling Studio case directory.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const PACK = fileURLToPath(
  new URL('./fixtures/wheel-rim-lod.pack.ts', import.meta.url),
);
const PACKAGE = definePackageId('01900000-0000-7000-8000-0000000c0015');
const ROOT_KEY = 'mesh/wheel-rim';
const KEYS = [ROOT_KEY, ...WHEEL_RIM_LODS.levels.map((_, i) => `${ROOT_KEY}/lod${i + 1}`)];
const DIRECTION = [0.42, 0.82, 0.66];
const SLOT_COLORS = {
  Default: [0.56, 0.58, 0.6],
  barrel: [0.6, 0.62, 0.64],
  painted: [0.24, 0.25, 0.27],
  machined: [0.88, 0.89, 0.9],
  bore: [0.42, 0.43, 0.45],
} as const;

const guid = (key: string) => AssetGuid.format(AssetGuid.derive(PACKAGE, key)).toLowerCase();
const triangles = (mesh: MeshAsset) => (mesh.indices?.length ?? 0) / 3;
const bounds = (mesh: MeshAsset) => {
  if (mesh.aabb === undefined) throw new Error('the rim mesh carries bounds');
  return { min: Array.from(mesh.aabb.slice(0, 3)), max: Array.from(mesh.aabb.slice(3, 6)) };
};

/** Pixels that differ from the LOD0 image and their mean channel difference. */
function compare(a: PNG, b: PNG) {
  const heat = new PNG({ width: a.width, height: a.height });
  let changed = 0;
  let total = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d =
      (Math.abs((a.data[i] as number) - (b.data[i] as number)) +
        Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)) +
        Math.abs((a.data[i + 2] as number) - (b.data[i + 2] as number))) /
      3;
    total += d;
    if (d > 12) changed++;
    const grey = Math.round(((a.data[i] as number) + (a.data[i + 1] as number)) / 6);
    heat.data[i] = d > 12 ? 255 : grey;
    heat.data[i + 1] = d > 12 ? 40 : grey;
    heat.data[i + 2] = d > 12 ? 120 : grey;
    heat.data[i + 3] = 255;
  }
  return { changed, meanDifference: total / (a.width * a.height), heat };
}

/** Side by side, left to right. */
function sheet(images: readonly PNG[]): PNG {
  const first = images[0] as PNG;
  const out = new PNG({ width: first.width * images.length, height: first.height });
  for (const [k, png] of images.entries())
    for (let y = 0; y < png.height; y++)
      out.data.set(
        png.data.subarray(y * png.width * 4, (y + 1) * png.width * 4),
        (y * out.width + k * first.width) * 4,
      );
  return out;
}

describe('C-015 Pack mesh LOD chain on the real renderer (Dawn)', () => {
  it('cooks the C-101 rim with three generated levels and renders each', {
    timeout: 600000,
  }, async () => {
    const loaded = await loadScriptablePack(PACK, { buildTimeoutMs: 300000 });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    const started = performance.now();
    const built = await buildScriptablePack({
      definition: loaded.value,
      sourcePath: PACK,
      outputs: createStandardAssetOutputProducerRegistry(),
    });
    const cookMs = performance.now() - started;
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const assets = built.value.product.assets;
    expect(assets.map((asset) => asset.guid.toLowerCase()).sort()).toEqual(KEYS.map(guid).sort());
    const meshes = KEYS.map((key) => {
      const asset = assets.find((entry) => entry.guid.toLowerCase() === guid(key));
      const body = asset?.artifacts.body;
      if (asset === undefined || body === undefined)
        throw new Error(`${key} has no mesh-binary body`);
      expect(body.assetCodec).toMatchObject({ name: 'mesh-binary' });
      const mesh = decodeMeshBinary(
        body.bytes,
        asset.refs.map((ref) => ref.guid),
      );
      if (mesh === undefined) throw new Error(`${key} does not decode`);
      return { key, guid: guid(key), refs: asset.refs.map((ref) => ref.guid.toLowerCase()), mesh };
    });
    const [root] = meshes as [(typeof meshes)[number]];
    expect(root.refs).toEqual(expect.arrayContaining(KEYS.slice(1).map(guid)));
    expect(
      root.mesh.lods?.map((level) => [
        AssetGuid.format(level.mesh as never).toLowerCase(),
        level.screenCoverage,
      ]),
    ).toEqual(
      WHEEL_RIM_LODS.levels.map((level, i) => [guid(KEYS[i + 1] as string), level.screenCoverage]),
    );
    const counts = meshes.map(({ mesh }) => triangles(mesh));
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThan(counts[i - 1] as number);
    for (const { mesh } of meshes.slice(1)) {
      expect(mesh.lods).toBeUndefined();
      expect(mesh.materialSlots.map((slot) => slot.slotName)).toEqual(
        root.mesh.materialSlots.map((slot) => slot.slotName),
      );
    }

    // The same request over the decoded root reproduces the published levels and reports the errors.
    const { lods: _published, ...lod0 } = root.mesh;
    const again = await generatePackMeshLods(
      PACKAGE,
      { [ROOT_KEY]: lod0 },
      { [ROOT_KEY]: WHEEL_RIM_LODS },
    );
    if (!again.ok) throw new Error(again.error.detail.reason);
    const reports = again.value.reports[ROOT_KEY] as readonly MeshLodGenerationReport[];
    expect(reports.map((report) => report.triangleCount)).toEqual(counts.slice(1));
    for (const [i, report] of reports.entries())
      expect(report.error).toBeLessThanOrEqual(
        WHEEL_RIM_LODS.levels[i]?.maxError ?? WHEEL_RIM_LODS.maxError,
      );

    const view = frame(bounds(lod0), Math.PI / 5, DIRECTION);
    const extent = bounds(lod0);
    const close = frame(
      {
        min: [0, extent.min[1] as number, 0],
        max: [extent.max[0] as number, extent.max[1] as number, extent.max[2] as number],
      },
      Math.PI / 5,
      DIRECTION,
    );
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['barrel', 'machined', 'bore'],
      view,
    });
    try {
      const levels = [lod0, ...meshes.slice(1).map(({ mesh }) => mesh)];
      const full: PNG[] = [];
      for (const mesh of levels) {
        const png = await r.render(mesh);
        expect(r.covered(png)).toBeGreaterThan(WIDTH * HEIGHT * 0.1);
        full.push(png);
      }
      r.aim(close);
      const closeUps: PNG[] = [];
      for (const mesh of levels) closeUps.push(await r.render(mesh));
      r.aim(view);
      expect(r.state()).toBe('alive');
      const diffs = full.slice(1).map((png) => compare(full[0] as PNG, png));
      // Each level stays a recognisable rim: most of its silhouette and shading match LOD0.
      for (const diff of diffs) expect(diff.changed).toBeLessThan(r.covered(full[0] as PNG) * 0.5);
      if (OUT === undefined) return;

      mkdirSync(join(OUT, 'source'), { recursive: true });
      mkdirSync(join(OUT, 'data'), { recursive: true });
      for (const [i, png] of full.entries())
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      writeFileSync(join(OUT, 'view-V-lod-closeup.png'), PNG.sync.write(sheet(closeUps)));
      writeFileSync(
        join(OUT, 'view-V-lod-diff.png'),
        PNG.sync.write(sheet(diffs.map((diff) => diff.heat))),
      );
      for (const [file, from] of [
        ['wheel-rim-lod.pack.ts', PACK],
        ['mesh-lod-pack.dawn.test.ts', fileURLToPath(import.meta.url)],
        [
          'wheel-rim.ts',
          fileURLToPath(
            new URL('../../modeling/examples/wheel-rim/wheel-rim.ts', import.meta.url),
          ),
        ],
      ] as const)
        copyFileSync(from, join(OUT, 'source', file));
      const levelFacts = meshes.map(({ key, guid: id, mesh }, i) => ({
        lod: i,
        sourceKey: key,
        guid: id,
        triangles: triangles(mesh),
        vertices: ((mesh.attributes.position as Float32Array | undefined)?.length ?? 0) / 3,
        triangleRatio: triangles(mesh) / (counts[0] as number),
        ...(i === 0
          ? {}
          : {
              requestedRatio: WHEEL_RIM_LODS.levels[i - 1]?.triangleRatio,
              screenCoverage: WHEEL_RIM_LODS.levels[i - 1]?.screenCoverage,
              errorBudget: WHEEL_RIM_LODS.levels[i - 1]?.maxError ?? WHEEL_RIM_LODS.maxError,
              error: reports[i - 1]?.error,
              targetReached: reports[i - 1]?.targetReached,
              changedPixels: diffs[i - 1]?.changed,
              meanPixelDifference: diffs[i - 1]?.meanDifference,
            }),
        image: `step-${String(i + 1).padStart(2, '0')}.png`,
      }));
      writeFileSync(
        join(OUT, 'data', 'lods.json'),
        `${JSON.stringify(
          {
            case: 'C-015',
            pack: 'packages/import/__tests__/fixtures/wheel-rim-lod.pack.ts',
            request: WHEEL_RIM_LODS,
            cookMs,
            renderSize: [WIDTH, HEIGHT],
            coveredPixelsLod0: r.covered(full[0] as PNG),
            rootRefs: root.refs,
            levels: levelFacts,
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        join(OUT, 'history.json'),
        `${JSON.stringify(
          {
            case: 'C-015',
            source: {
              repo: 'ForgeAX/forgeax-engine',
              commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
              file: 'packages/import/__tests__/fixtures/wheel-rim-lod.pack.ts',
            },
            steps: levelFacts.map((level) => ({
              n: level.lod + 1,
              op: level.lod === 0 ? 'finish' : 'generatePackMeshLods',
              args:
                level.lod === 0
                  ? { key: 'wheel-rim', normals: { mode: 'weighted' } }
                  : {
                      level: level.lod,
                      triangleRatio: level.requestedRatio,
                      screenCoverage: level.screenCoverage,
                      maxError: level.errorBudget,
                    },
              result: {
                sourceKey: level.sourceKey,
                guid: level.guid,
                triangles: level.triangles,
                vertices: level.vertices,
                ...(level.lod === 0
                  ? {}
                  : {
                      error: level.error,
                      targetReached: level.targetReached,
                      changedPixels: level.changedPixels,
                    }),
              },
              diagnostics: [],
              image: level.image,
            })),
            final: {
              triangles: counts,
              materialSlots: root.mesh.materialSlots.length,
              lods: root.mesh.lods?.length,
              data: 'data/lods.json',
            },
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await r.dispose();
    }
  });
});

// C-410 compose: per texture set, read the set bake (bake groups, S1a)
// with its slot maps (layer 2: base color, ORMH, emissive from the palette's kernel
// slots, U89) and apply the wear layer (layer 3: edge chipping, scratches, grime, rust from the
// baked curvature + AO masks and object-space noise). Writes raw RGBA, PNG and KTX2.
// usage: node compose.mts <caseDir> <bakeDir> <mapsDir> [resolution=2048] [ktx=1]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeKtx2 } from '@forgeax/engine-modeling/tools';
import { PNG } from 'pngjs';
import { composeVariant, prepareSet, WEAR } from '../maps.ts';

const [caseDir, bakeDir, mapsDir, resArg, ktxArg] = process.argv.slice(2);
const N = Number(resArg ?? 2048);
const KTX = ktxArg !== '0';
const build = JSON.parse(readFileSync(join(caseDir!, 'build.json'), 'utf8'));
type Unit = { unit: string; group: string; set: string; sub: string };
const units = build.units as Unit[];

function loadMesh(name: string) {
  const meta = JSON.parse(readFileSync(join(caseDir!, 'meshes', `${name}.meta.json`), 'utf8'));
  const bin = readFileSync(join(caseDir!, 'meshes', `${name}.bin`));
  const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  const v = meta.verts as number;
  const position = new Float32Array(buf, 0, v * 3), normal = new Float32Array(buf, v * 12, v * 3), uv = new Float32Array(buf, v * 24, v * 2);
  const indices = new Uint32Array(buf, v * 48, meta.indexCount);
  return { position, normal, uv, indices };
}

function savePng(path: string, data: Uint8Array, w = N, h = N) {
  const png = new PNG({ width: w, height: h });
  png.data = Buffer.from(data);
  writeFileSync(path, PNG.sync.write(png));
}

const report: Record<string, unknown> = { resolution: N, sets: {} };
for (const set of [...new Set(units.map((u) => u.set))]) {
  const t0 = performance.now();
  const info = JSON.parse(readFileSync(join(bakeDir!, set, 'bake.json'), 'utf8'));
  const maps = Object.fromEntries(['normal', 'curvature', 'materialId', 'baseColor', 'ormh', 'emissive'].map((k) => [k, new Uint8Array(readFileSync(join(bakeDir!, set, `${k}.rgba`)))])) as Record<string, Uint8Array>;
  const prepared = prepareSet(N, loadMesh(`lowset-${set}`), maps as never, info.provenance.materials);
  const { covered, slotNames, wear: wctx } = prepared;
  const unitInfo = { ms: info.ms, samples: info.samples, mode: info.mode, metrics: info.report?.metrics, groups: info.provenance?.groups, bleed: info.provenance?.bleed };
  // 4. albedo / ORM / emissive: fair (layer 2 only, for the metrics) and art (with layer 3 wear).
  for (const variant of ['fair', 'art'] as const) {
    const { albedo, orm, emissive } = composeVariant(prepared, variant);
    const out = join(mapsDir!, variant, set);
    mkdirSync(out, { recursive: true });
    for (const [k, v] of Object.entries({ normal: maps.normal!, albedo, orm, emissive })) writeFileSync(join(out, `${k}.rgba`), v);
    writeFileSync(join(out, 'set.json'), JSON.stringify({ resolution: N, set, variant }));
    if (variant === 'art') {
      for (const [k, v] of Object.entries({ ...maps, albedo, orm, emissive })) savePng(join(out, `${k}.png`), v);
      if (KTX) {
        // The kernel's delivery path: one mip owner (mipChain), normals BC5 (RRRG), the rest BC7-class UASTC.
        const ktx: Record<string, Record<string, number>> = {};
        for (const [k, v, layout, srgb] of [['normal', maps.normal!, 'normal', false], ['albedo', albedo, 'color', true], ['orm', orm, 'ormh', false], ['emissive', emissive, 'color', false]] as const) {
          const e0 = performance.now();
          const level = { kind: 'texture', format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm', colorSpace: srgb ? 'srgb' : 'linear', shape: { viewDimension: '2d', extent: { width: N, height: N } }, mips: { kind: 'none' }, data: v } as const;
          const r = await encodeKtx2(level as never, { layout, sourceKey: `${info.report?.cacheKey ?? set}:${k}` });
          if (!r.ok) throw new Error(`ktx2 ${k}: ${JSON.stringify(r.error)}`);
          writeFileSync(join(out, `${k}.ktx2`), r.value.texture.data);
          ktx[k] = { bytes: r.value.report.bytes, levels: r.value.report.levels, ms: Math.round(performance.now() - e0) };
        }
        (report.sets as Record<string, unknown>)[set] = { ...((report.sets as Record<string, unknown>)[set] as object), ktx };
      }
    } else {
      savePng(join(out, 'albedo.png'), albedo);
      savePng(join(out, 'orm.png'), orm);
    }
  }
  (report.sets as Record<string, unknown>)[set] = { ...((report.sets as Record<string, unknown>)[set] as object), bake: unitInfo, coveredTexels: covered, coverage: covered / (N * N), slots: slotNames, wear: { ...wctx, bareFraction: WEAR.bare / Math.max(1, WEAR.painted), rustFraction: WEAR.rust / Math.max(1, WEAR.painted), grimeFraction: WEAR.grime / Math.max(1, WEAR.painted) }, ms: Math.round(performance.now() - t0) };
  console.log(set, 'wear', JSON.stringify(WEAR), 'covered', covered, (covered / (N * N)).toFixed(3), 'ms', Math.round(performance.now() - t0));
}
writeFileSync(join(mapsDir!, 'compose.json'), JSON.stringify(report, null, 1));

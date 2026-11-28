// Outputs of one exact source: each output profile is one `deliverAsset` call on the same blaster. The kernel meshes,
// assigns the recorded merge, plans seams, unwraps, packs with mip-safe padding, bakes the normal map from a finer
// detail, and checks the byte and count budget. This script only writes the files: outputs.json, OBJs, UV and checker
// pictures, and lit comparison pictures read from `delivered.model`. Writes into <GALLERY_OUT>/<output>/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePng } from '@forgeax/engine-image/png';
import type { MeshAsset } from '@forgeax/engine-types';
import {
  type AssetOutputProfile,
  type AssetOutputProfileId,
  assetStats,
  checkAssetBudget,
} from '../../src/asset-budget.ts';
import { measureUv } from '../../src/compute/uv-ts.ts';
import { type DeliveredAsset, type DeliverOptions, deliverAsset } from '../../src/deliver.ts';
import { type Image, toPng } from '../brep-kit/image.ts';
import { writeObj } from './obj.ts';
import {
  buildBlaster,
  type MaterialSlot,
} from '../../src/__tests__/fixtures/hero-blaster.ts';
import {
  type LitFrame,
  type LitMap,
  type LitMesh,
  type LitPicture,
  litFrame,
  meanAbsDiff,
  rasterLitPicture,
  VIEWS3,
} from './raster3d.ts';
import { say } from './say.ts';
import { checkerViews, uvPictures } from './uv.ts';

const out = process.env.GALLERY_OUT as string;
const SOURCE_PART = 'blaster';
const FINE_UV_GRID = 4096;
const BAKE_RESOLUTION = 1024;
const LIT_SIZE = 720;
/** Linear albedo per source material slot for the lit pictures. */
const SLOT_ALBEDO: Readonly<Record<MaterialSlot, readonly [number, number, number]>> = {
  BodyMetal: [0.66, 0.68, 0.72],
  DarkHardware: [0.24, 0.25, 0.28],
  Glass: [0.3, 0.62, 0.78],
  Accent: [0.9, 0.46, 0.14],
};

type Merge = Readonly<Partial<Record<MaterialSlot, string>>>;

interface Output {
  readonly id: string;
  readonly profile: AssetOutputProfileId;
  readonly sizes: readonly number[];
  /** Source material slot -> output slot, applied before unwrap (a recorded per-output merge). */
  readonly merge: Merge;
  readonly bake: boolean;
}

const OUTPUTS: readonly Output[] = [
  { id: 'desktop-hero', profile: 'desktop-hero', sizes: [0.35], merge: {}, bake: false },
  {
    id: 'mobile-hero',
    profile: 'mobile-hero',
    sizes: [0.9],
    merge: { BodyMetal: 'Atlas', DarkHardware: 'Atlas', Glass: 'Atlas', Accent: 'Atlas' },
    bake: true,
  },
  {
    id: 'mobile-prop',
    profile: 'mobile-prop',
    sizes: [1.0, 1.1, 1.2, 1.3],
    merge: { DarkHardware: 'BodyMetal' },
    bake: true,
  },
];

const source = buildBlaster();
const partMaterial = new Map<string, MaterialSlot>(source.parts.map((p) => [p.name, p.material]));

type Delivered = DeliveredAsset;

/** The delivery options of one output; the bake detail and the atlas stay with the kernel. */
function optionsOf(output: Output, exact: DeliverOptions['exact'], detailSize?: number): DeliverOptions {
  return {
    exact,
    sizes: output.sizes,
    ...(Object.keys(output.merge).length === 0 ? {} : { merge: output.merge }),
    ...(output.bake ? { bake: { resolution: BAKE_RESOLUTION, maps: ['normal'] as const } } : {}),
    ...(detailSize === undefined ? {} : { detailSize }),
  };
}

function f32(a: unknown, name: string): Float32Array {
  if (a instanceof Float32Array) return a;
  if (a instanceof ArrayBuffer) return new Float32Array(a);
  throw new Error(`attribute ${name} is not float32`);
}

/** Lit geometry of an exported mesh: smooth normals, tangents and uv as exported. */
function litOf(mesh: MeshAsset): LitMesh {
  const attrs = mesh.attributes;
  if (mesh.indices === undefined) throw new Error('exported mesh is not indexed');
  return {
    position: f32(attrs.position, 'position'),
    normal: f32(attrs.normal, 'normal'),
    tangent: f32(attrs.tangent, 'tangent'),
    uv: f32(attrs.uv, 'uv'),
    indices: mesh.indices,
  };
}

interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The same triangles with one geometry normal per face, no tangents or uv: the flat-normal comparison. */
function flatOf(mesh: MeshAsset): LitMesh {
  const pos = f32(mesh.attributes.position, 'position');
  const idx = mesh.indices as Uint16Array | Uint32Array;
  const position = new Float32Array(idx.length * 3);
  const normal = new Float32Array(idx.length * 3);
  const at = (v: number): Vec3 => ({
    x: pos[v * 3] as number,
    y: pos[v * 3 + 1] as number,
    z: pos[v * 3 + 2] as number,
  });
  for (let t = 0; t < idx.length; t += 3) {
    const a = at(idx[t] as number);
    const b = at(idx[t + 1] as number);
    const c = at(idx[t + 2] as number);
    const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    const n = {
      x: e1.y * e2.z - e1.z * e2.y,
      y: e1.z * e2.x - e1.x * e2.z,
      z: e1.x * e2.y - e1.y * e2.x,
    };
    const len = Math.hypot(n.x, n.y, n.z) || 1;
    [a, b, c].forEach((p, corner) => {
      position.set([p.x, p.y, p.z], (t + corner) * 3);
      normal.set([n.x / len, n.y / len, n.z / len], (t + corner) * 3);
    });
  }
  return {
    position,
    normal,
    indices: Uint32Array.from({ length: idx.length }, (_, i) => i),
  };
}

/** Albedo per exported triangle from its source part's material slot (before any merge). */
function slotAlbedo(delivered: Delivered): Float32Array {
  const mesh = delivered.model.editMesh;
  const key = (x: number, y: number, z: number) =>
    `${Math.fround(x)},${Math.fround(y)},${Math.fround(z)}`;
  const parts = [...partMaterial.keys()];
  const tagIds = parts.map((p) => mesh.tagNames.indexOf(p));
  const partsAt = new Map<string, Set<number>>();
  for (const f of mesh.faces()) {
    const part = tagIds.findIndex((t) => t >= 0 && mesh.hasTag(f, t));
    if (part < 0) continue;
    for (const v of mesh.faceVertices(f)) {
      const [x, y, z] = mesh.position(v);
      const k = key(x, y, z);
      let set = partsAt.get(k);
      if (set === undefined) {
        set = new Set();
        partsAt.set(k, set);
      }
      set.add(part);
    }
  }
  const pos = f32(delivered.mesh.attributes.position, 'position');
  const idx = delivered.mesh.indices as Uint16Array | Uint32Array;
  const out = new Float32Array(idx.length);
  for (let t = 0; t < idx.length / 3; t++) {
    let common: number[] | undefined;
    for (let c = 0; c < 3; c++) {
      const v = idx[t * 3 + c] as number;
      const at = partsAt.get(key(pos[v * 3] as number, pos[v * 3 + 1] as number, pos[v * 3 + 2] as number));
      const list = at === undefined ? [] : [...at];
      common = common === undefined ? list : common.filter((p) => list.includes(p));
    }
    const part = parts[(common ?? [])[0] ?? -1];
    const slot = part === undefined ? 'BodyMetal' : (partMaterial.get(part) as MaterialSlot);
    out.set(SLOT_ALBEDO[slot], t * 3);
  }
  return out;
}

/** Bounds of the session faces of `parts`, grown by `grow` of their diagonal. */
function partFrame(delivered: Delivered, parts: readonly string[], grow: number): LitFrame {
  const mesh = delivered.model.editMesh;
  const ids = parts.map((p) => mesh.tagNames.indexOf(p)).filter((t) => t >= 0);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const f of mesh.faces()) {
    if (!ids.some((t) => mesh.hasTag(f, t))) continue;
    for (const v of mesh.faceVertices(f)) {
      const p = mesh.position(v);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k] as number, p[k] as number);
        max[k] = Math.max(max[k] as number, p[k] as number);
      }
    }
  }
  const d = Math.hypot(...[0, 1, 2].map((k) => (max[k] as number) - (min[k] as number))) * grow;
  return {
    min: [(min[0] as number) - d, (min[1] as number) - d, (min[2] as number) - d],
    max: [(max[0] as number) + d, (max[1] as number) + d, (max[2] as number) + d],
  };
}

/** The lit views: the whole blaster from the iso camera and two close-ups with the same camera direction and light. */
function litViews(desktop: Delivered) {
  return [
    { name: 'iso', frame: litFrame(f32(desktop.mesh.attributes.position, 'position')) },
    { name: 'muzzle-fins', frame: partFrame(desktop, ['fin-sleeve'], 0.08) },
    { name: 'grip', frame: partFrame(desktop, ['grip', 'trigger', 'trigger-guard'], 0.04) },
  ];
}

/** Fine, flat and normal-mapped lit pictures per view, and the flat and mapped differences against the fine one. */
function litPictures(
  output: Output,
  built: Delivered,
  desktop: Delivered,
  map: LitMap,
  dir: string,
  pictures: string[],
) {
  const camera = VIEWS3.find((v) => v.name === 'iso') as (typeof VIEWS3)[number];
  const fineAlbedo = slotAlbedo(desktop);
  const lowAlbedo = slotAlbedo(built);
  const diff = [];
  for (const view of litViews(desktop)) {
    const shots: [string, LitMesh, LitMap | undefined, Float32Array][] = [
      ['desktop-hero', litOf(desktop.mesh), undefined, fineAlbedo],
      [`${output.id}-flat`, flatOf(built.mesh), undefined, lowAlbedo],
      [`${output.id}-normalmap`, litOf(built.mesh), map, lowAlbedo],
    ];
    const shot: LitPicture[] = [];
    for (const [label, mesh, m, albedo] of shots) {
      const picture = rasterLitPicture(mesh, camera, LIT_SIZE, view.frame, {
        albedo,
        ...(m === undefined ? {} : { map: m }),
      });
      const name = `lit-${label}-${view.name}.png`;
      writePng(join(dir, name), picture.image);
      pictures.push(`${output.id}/${name}`);
      shot.push(picture);
    }
    const [fine, flat, mapped] = shot as [LitPicture, LitPicture, LitPicture];
    diff.push({
      view: view.name,
      flat: meanAbsDiff(fine, flat),
      normalMapped: meanAbsDiff(fine, mapped),
    });
  }
  return diff;
}

function writePng(file: string, image: Image): void {
  writeFileSync(file, toPng(image));
}

interface CageGroup {
  readonly id: string;
  readonly offset: number;
  readonly maxRay: number;
  readonly samples: number;
  readonly rayHits: number;
  readonly nearest: number;
  readonly clipped: number;
  readonly branches: { readonly cage: number; readonly base: number; readonly extended: number; readonly flat: number };
}

/** Per bake group cage and the totals the bake check judges: clipped share, ray misses, largest cage. */
function cageSummary(groups: readonly CageGroup[]) {
  const samples = groups.reduce((a, g) => a + g.samples, 0);
  const clipped = groups.reduce((a, g) => a + g.clipped, 0);
  return {
    groups: groups.map((g) => ({
      id: g.id,
      offset: g.offset,
      maxRay: g.maxRay,
      samples: g.samples,
      nearest: g.nearest,
      clipped: g.clipped,
      branches: g.branches,
      flatShare: g.samples === 0 ? 0 : g.branches.flat / g.samples,
    })),
    samples,
    clipped,
    clippedShare: samples === 0 ? 0 : clipped / samples,
    rayMisses: groups.reduce((a, g) => a + g.nearest, 0),
    maxOffset: Math.max(...groups.map((g) => g.offset)),
    maxMaxRay: Math.max(...groups.map((g) => g.maxRay)),
  };
}

/** The normal map of a delivered bake: pixels written to disk, the bake's own findings and the cage totals. */
function bakeJsonOf(delivered: Delivered, dir: string, pictures: string[], output: Output) {
  const report = delivered.report.bake;
  if (report === undefined) return null;
  if (report.refusal !== undefined) {
    return { refused: true, code: report.refusal.code, expected: report.refusal.expected, hint: report.refusal.hint };
  }
  const normal = delivered.textures.normal;
  if (normal === undefined) throw new Error('bake returned no normal texture');
  const level0 = normal.data.subarray(0, BAKE_RESOLUTION * BAKE_RESOLUTION * 4);
  let nonFlat = 0;
  for (let i = 0; i < level0.length; i += 4) {
    if (
      Math.abs((level0[i] as number) - 128) > 2 ||
      Math.abs((level0[i + 1] as number) - 128) > 2 ||
      Math.abs((level0[i + 2] as number) - 255) > 2
    )
      nonFlat++;
  }
  writeFileSync(join(dir, 'normal-map.png'), encodePng(BAKE_RESOLUTION, BAKE_RESOLUTION, level0));
  pictures.push(`${output.id}/normal-map.png`);
  const groups = report.groups;
  const covered = groups.reduce((a, g) => a + g.samples, 0);
  return {
    refused: false,
    pass: report.pass,
    map: 'normal',
    resolution: BAKE_RESOLUTION,
    detail: { size: report.detailSize },
    issues: report.issues.map((i: { code: string; severity: string; detail: unknown }) => ({ code: i.code, severity: i.severity, detail: i.detail })),
    provenance: {
      covered,
      rayHits: groups.reduce((a, g) => a + g.rayHits, 0),
      nearest: groups.reduce((a, g) => a + g.nearest, 0),
    },
    cage: cageSummary(groups),
    nonFlatTexels: nonFlat,
    bytes: report.bytes,
    file: 'normal-map.png',
  };
}

/** Deliver one output (the kernel does the mesh work), then write its files and the JSON entry. */
// Exact stage from the source tree: the example never loads the bundle.
const exact: DeliverOptions['exact'] = await import('../../src/brep/index.ts');

const MEASURE_ONLY: AssetOutputProfile = {
  maxTriangles: Number.POSITIVE_INFINITY,
  maxVertices: Number.POSITIVE_INFINITY,
  maxMaterials: Number.POSITIVE_INFINITY,
  uniqueUv: false,
  minUvCoverage: 0,
  maxUvOverlap: Number.POSITIVE_INFINITY,
  maxUvOutOfRange: Number.POSITIVE_INFINITY,
  maxTexelSpread: Number.POSITIVE_INFINITY,
  maxDegenerate: Number.POSITIVE_INFINITY,
};

async function emit(output: Output, exact: DeliverOptions['exact'], desktop: Delivered | undefined) {
  const dir = join(out, output.id);
  mkdirSync(dir, { recursive: true });
  const delivered = deliverAsset(source, output.profile, optionsOf(output, exact, undefined));
  if (!delivered.ok) throw new Error(`${output.id}: ${delivered.error.code} ${JSON.stringify(delivered.error.detail)}`);
  const built = delivered.value;
  const verdict = checkAssetBudget(built.report.stats, output.profile);
  // Before-merge comparison: the same kernel call at the delivered size with the merge removed. Measurement only:
  // the unbounded profile lets the unmerged asset be measured, and its verdict is still taken on the real profile below.
  const before = deliverAsset(source, MEASURE_ONLY, { exact, sizes: [built.report.size], merge: {} });
  if (!before.ok) throw new Error(`${output.id} before: ${before.error.code}`);
  say(output.id, `size ${built.report.size}`, `attempts ${built.report.attempts.length}`, `ok ${verdict.ok}`);

  const obj = writeObj(built.model.editMesh, join(dir, `${output.id}.obj`), true);
  const island = measureUv(built.model.editMesh, 'uv0');
  if (!island.ok) throw new Error(`measureUv: ${island.error.code}`);
  uvPictures(built.model.editMesh, island.value.faceIsland, output.id);
  checkerViews(built.model.editMesh, output.id);
  const pictures = [
    `${output.id}/checker3d-iso.png`,
    `${output.id}/checker3d-front.png`,
    `${output.id}/checker3d-top.png`,
    `${output.id}/uv-layout.png`,
    `${output.id}/uv-checker.png`,
  ];

  let litDiff: ReturnType<typeof litPictures> | null = null;
  const bakeJson = bakeJsonOf(built, dir, pictures, output);
  if (output.bake && desktop !== undefined && built.textures.normal !== undefined) {
    const map: LitMap = {
      width: BAKE_RESOLUTION,
      height: BAKE_RESOLUTION,
      rgba: built.textures.normal.data.subarray(0, BAKE_RESOLUTION * BAKE_RESOLUTION * 4),
    };
    litDiff = litPictures(output, built, desktop, map, dir, pictures);
  }

  const s = built.report.stats;
  const b = before.value.report.stats;
  const beforeVerdict = checkAssetBudget(b, output.profile);
  const fine = assetStats([{ id: SOURCE_PART, mesh: built.mesh }], { uvGridSize: FINE_UV_GRID });
  if (!fine.ok) throw new Error('assetStats failed');
  const json = {
    id: output.id,
    profile: output.profile,
    quadSize: built.report.size,
    sizesTried: built.report.attempts.map((t) => ({
      size: t.size,
      after: { materials: t.materials, triangles: t.triangles, vertices: t.vertices, ok: t.issues.length === 0, issues: t.issues },
    })),
    refusedParts: built.report.steps
      .find((x) => x.step === 'quad')
      ?.detail.parts as unknown[] | undefined,
    merge: output.merge,
    materialSlotsBefore: before.value.mesh.materialSlots.map((x) => x.slotName),
    materialSlotsAfter: built.mesh.materialSlots.map((x) => x.slotName),
    slotTrianglesBefore: before.value.mesh.submeshes.map((x) => ({
      slot: before.value.mesh.materialSlots[x.materialSlot]?.slotName,
      triangles: x.indexCount / 3,
    })),
    slotTrianglesAfter: built.mesh.submeshes.map((x) => ({
      slot: built.mesh.materialSlots[x.materialSlot]?.slotName,
      triangles: x.indexCount / 3,
    })),
    verdictBefore: {
      ok: beforeVerdict.ok,
      issues: beforeVerdict.issues.map((i) => ({ code: i.code, detail: i.detail })),
    },
    triangles: s.triangles,
    vertices: s.vertices,
    verticesBefore: b.vertices,
    materials: s.materials,
    uvCoverage: s.uvCoverage,
    uvOverlap: s.uvOverlap,
    uvOverlapAtFineGrid: fine.value.uvOverlap,
    exactUvOverlapPairs: built.report.uv.exactOverlapPairs,
    uvOutOfRange: s.uvOutOfRange,
    texelSpread: s.texelSpread,
    degenerateTriangles: s.degenerateTriangles,
    rawBytes: s.rawBytes,
    quantizedBytes: s.quantizedBytes,
    pack: {
      islands: built.report.uv.islands,
      resolution: BAKE_RESOLUTION,
      paddingTexels: built.report.uv.paddingTexels,
    },
    ok: verdict.ok,
    issues: verdict.issues.map((i) => ({ code: i.code, detail: i.detail })),
    bake: bakeJson,
    litDifference: litDiff,
    files: {
      obj: `${output.id}/${output.id}.obj`,
      objFaces: { quads: obj.quads, tris: obj.tris, vertices: obj.vertices },
      pictures,
    },
  };
  return { delivered: built, json };
}

const outputs = [];
let desktop: Delivered | undefined;
for (const output of OUTPUTS) {
  const entry = await emit(output, exact, desktop);
  if (output.id === 'desktop-hero') desktop = entry.delivered;
  outputs.push(entry.json);
}

const doc = {
  generator: 'examples/hero-asset/outputs.ts',
  source: {
    units: 'cm',
    parts: source.parts.length,
    materials: [...new Set(source.parts.map((p) => p.material))],
    operations: source.parts.map((p) => ({
      part: p.name,
      operation: p.operation,
      material: p.material,
      fallback: p.fallback ?? null,
    })),
    refusals: source.steps
      .filter((s) => !s.ok)
      .map((s) => ({ id: s.id, part: s.part, code: s.failure?.code ?? null })),
  },
  outputs,
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'outputs.json'), JSON.stringify(doc, null, 1));
say(
  'outputs.json written',
  doc.outputs.map((o) => ({ id: o.id, size: o.quadSize, ok: o.ok, tri: o.triangles })),
);

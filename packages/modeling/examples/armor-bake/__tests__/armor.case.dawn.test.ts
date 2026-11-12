import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bakeSurface,
  decodeSnapshot,
  EditMesh,
  encodeSnapshot,
  MATERIAL_ID_PALETTE,
  type Model,
  measureUv,
  model,
  type StandardMaterialOptions,
  sel,
  type TextureSink,
  textureFrom,
} from '@forgeax/engine-modeling';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import { deriveVertexLayoutProjection, unpackInterleavedVertexAttributes } from '@forgeax/engine-geometry';
import type { MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  checkerMesh,
  checkerTexture,
  createCaseRenderer,
  frame,
  frameModel,
  frameSnapshot,
  highlighted,
  historyStep,
  labelMesh,
  layoutView,
  stateMesh,
  touched,
  uvLayoutMesh,
} from '../../case/render';
import { ARMOR_DEFAULTS, armorBake, BASE_NORMALS, buildArmor } from '../armor';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the bake step, the
 * side-by-side comparison and the UV layout at a small size; with FORGEAX_CASE_OUT set
 * it writes the case output directory: one image per recorded step plus the
 * bake step (the low-poly base wearing its baked maps), the V-* views, history.json,
 * bake.json (bake and uv.auto metrics, tangent frame check), validate.json, the baked
 * maps as PNG data and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const PARAMETERS = OUT === undefined ? { ...ARMOR_DEFAULTS, resolution: 128 } : ARMOR_DEFAULTS;
const SOURCE = fileURLToPath(new URL('../armor.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** From above the plate, front and to the side: the grille, seams and bolts face the camera. */
const DIRECTION = [0.45, 0.8, 0.55];
/** The high-poly detail sits beside the base along -z in the comparison views. */
const OFFSET = 1.05;

/** Viewer colors of the detail slots; the baked albedo repaints the material-id map with them. */
const SLOT_COLORS = {
  Default: [0.6, 0.62, 0.66],
  paint: [0.62, 0.14, 0.1],
  groove: [0.09, 0.08, 0.08],
  vent: [0.12, 0.12, 0.13],
  bolt: [0.72, 0.73, 0.76],
  plain: [0.62, 0.14, 0.1],
  atlas: [0.1, 0.1, 0.11],
  'atlas-border': [0.55, 0.55, 0.58],
  highlight: [0.95, 0.2, 0.55],
} as const;
const DETAIL_SLOTS = ['paint', 'groove', 'vent', 'bolt'] as const;

const srgbByte = (c: number) =>
  Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);

/** Albedo from the material-id map: each texel takes its detail slot's viewer color. */
function albedoOf(id: TextureAsset, slots: readonly string[]): TextureAsset {
  const size = id.shape.extent.width;
  const data = id.data as Uint8Array;
  const keys = slots.map((_, i) => (MATERIAL_ID_PALETTE[i] as readonly number[]).map(srgbByte));
  const out = textureFrom(
    size,
    size,
    (x, y) => {
      const o = (y * size + x) * 4;
      let best = 0;
      let distance = Infinity;
      for (const [i, key] of keys.entries()) {
        const d = [0, 1, 2].reduce((n, c) => n + ((data[o + c] as number) - (key[c] as number)) ** 2, 0);
        if (d < distance) {
          distance = d;
          best = i;
        }
      }
      const color = SLOT_COLORS[(slots[best] ?? 'paint') as keyof typeof SLOT_COLORS] ?? SLOT_COLORS.paint;
      return [color[0], color[1], color[2], 1];
    },
    { colorSpace: 'srgb', mips: false },
  );
  if (!out.ok) throw out.error;
  return out.value;
}

/** The unit UV square as one quad whose uv equals its position, in `slot` (map views). */
function mapQuad(slot: string): MeshAsset {
  const flat = new EditMesh();
  const loop = [flat.addVertex(0, 0, 0), flat.addVertex(1, 0, 0), flat.addVertex(1, 1, 0), flat.addVertex(0, 1, 0)];
  const f = flat.addFace(loop, flat.nameIndex(flat.materialNames, slot)).unwrap();
  for (const h of flat.faceHalves(f)) {
    const p = flat.position(flat.hVert[h] as number);
    // Texel rows follow v down the image; show the map as the image reads.
    flat.setCorner('uv0', h, [p[0], 1 - p[1]]);
  }
  const view = model();
  view.append(encodeSnapshot(flat));
  const out = view.toMesh({ normals: { mode: 'flat' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/** The base in `slot` beside the detail (offset along -z), exported with the bake's normal mode. */
function comparison(base: Model, detail: Model, slot: string): MeshAsset {
  const view = model();
  view.append(base.snapshot());
  view.assign(sel.all(), slot);
  view.append(detail.snapshot(), { translate: [0, 0, -OFFSET] });
  const out = view.toMesh({ normals: BASE_NORMALS });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

function single(m: Model, slot: string): MeshAsset {
  const view = model();
  view.append(m.snapshot());
  view.assign(sel.all(), slot);
  const out = view.toMesh({ normals: BASE_NORMALS });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

function exportOf(m: Model): MeshAsset {
  const out = m.toMesh({ normals: BASE_NORMALS });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

function png(texture: TextureAsset): PNG {
  const { width, height } = texture.shape.extent;
  const image = new PNG({ width, height });
  image.data.set((texture.data as Uint8Array).subarray(0, width * height * 4));
  return image;
}

const isUv = (step: RecordedStep) => step.entry.op.startsWith('uv.');

describe('C-110 case evidence on the real renderer (Dawn)', () => {
  it('renders every step, the baked comparison and the V-uv views', { timeout: 5400000 }, async () => {
    const recording = recordingSessions();
    const t0 = performance.now();
    const armor = buildArmor(PARAMETERS, recording.session);
    const buildMs = performance.now() - t0;
    const { base, detail, bake } = armor;
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    const textures = bake.textures as Required<typeof bake.textures>;
    const slots = bake.provenance.materials.map((m) => m.slot);
    expect(slots).toEqual([...DETAIL_SLOTS]);
    const albedo = albedoOf(textures.materialId, slots);
    const textureMaterial = (texture: TextureSink, key: string, map: TextureAsset): StandardMaterialOptions => ({
      baseColor: [1, 1, 1, 1],
      metallic: 0,
      roughness: 0.8,
      baseColorTexture: { texture: texture(key, map) },
    } as StandardMaterialOptions);
    const pairModel = model();
    pairModel.append(base.snapshot());
    pairModel.append(detail.snapshot(), { translate: [0, 0, -OFFSET] });
    const pair = frameModel(pairModel, [0.75, 0.75, 0.25]);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['bolt'],
      view: pair,
      checker: checkerTexture(),
      materials: {
        baked: (texture) =>
          ({
            baseColor: [1, 1, 1, 1],
            metallic: 0,
            roughness: 0.5,
            baseColorTexture: { texture: texture('armor-albedo', albedo) },
            normalTexture: { texture: texture('armor-normal', textures.normal) },
            occlusionTexture: { texture: texture('armor-ao', textures.ao) },
          }) as StandardMaterialOptions,
        // The detail and the plain base use the same cooked Standard program as the baked base.
        ...Object.fromEntries(
          ([...DETAIL_SLOTS, 'plain'] as const).map((slot) => {
            const color = SLOT_COLORS[slot];
            const options = {
              baseColor: [color[0], color[1], color[2], 1],
              metallic: slot === 'bolt' ? 0.6 : 0,
              roughness: 0.5,
            } as StandardMaterialOptions;
            return [slot, () => options];
          }),
        ),
        'map-normal': (texture) => textureMaterial(texture, 'map-normal', textures.normal),
        'map-ao': (texture) => textureMaterial(texture, 'map-ao', textures.ao),
        'map-id': (texture) => textureMaterial(texture, 'map-id', textures.materialId),
      },
    });
    try {
      const bakedPair = await r.render(comparison(base, detail, 'baked'));
      expect(r.covered(bakedPair)).toBeGreaterThan(WIDTH * HEIGHT * 0.1);
      const layout = uvLayoutMesh(base.snapshot());
      const flat = layoutView(WIDTH / HEIGHT);
      r.aim(flat);
      const atlas = await r.render(layout.mesh, layout.legend);
      expect(r.covered(atlas)).toBeGreaterThan(WIDTH * HEIGHT * 0.2);
      const normalMap = await r.render(mapQuad('map-normal'));
      expect(r.covered(normalMap)).toBeGreaterThan(WIDTH * HEIGHT * 0.2);
      r.aim(pair);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const baseView = frameModel(base, DIRECTION);
      const at = async (view: ReturnType<typeof frame>, mesh: MeshAsset, legend?: readonly string[]) => {
        r.aim(view);
        const image = await r.render(mesh, legend);
        r.aim(pair);
        return image;
      };
      const images: PNG[] = [];
      for (const step of steps) {
        r.aim(frameSnapshot(step.snapshot, DIRECTION));
        images.push(await r.render(isUv(step) ? checkerMesh(step.snapshot) : stateMesh(step.snapshot, touched(step))));
      }
      // The bake step: the low-poly base wearing its baked maps.
      images.push(await at(baseView, single(base, 'baked')));
      const labels = labelMesh(detail);
      const closeup = frame({ min: [0, -0.1, -0.35], max: [0.35, 0.1, 0.1] }, CASE_FOV, DIRECTION);
      const views: Record<string, PNG> = {
        'V-shaded': bakedPair,
        'V-shaded-plain': await r.render(comparison(base, detail, 'plain')),
        'V-shaded-baked': await at(closeup, single(base, 'baked')),
        'V-shaded-detail': await at(closeup, exportOf(detail)),
        'V-uv': await at(baseView, checkerMesh(base.snapshot())),
        'V-uv-layout': atlas,
        'V-uv-normal': normalMap,
        'V-uv-ao': await at(flat, mapQuad('map-ao')),
        'V-uv-id': await at(flat, mapQuad('map-id')),
        'V-tags': await at(frameModel(detail, DIRECTION), labels.mesh, labels.legend),
        'V-sel-detail': await at(
          frameModel(detail, DIRECTION),
          highlighted(detail, sel.createdBy('vent-slot').or(sel.tag('bolt')).or(sel.createdBy('seam-cross')).or(sel.createdBy('seam-front')).or(sel.createdBy('seam-back'))),
        ),
        'V-sel-charts': await at(baseView, highlighted(base, sel.facing('+y', 60))),
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      mkdirSync(join(OUT, 'data'), { recursive: true });
      for (const [i, image] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(image));
      }
      for (const [view, image] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(image));
      }
      for (const [map, texture] of Object.entries(textures)) {
        writeFileSync(join(OUT, 'data', `bake-${map}.png`), PNG.sync.write(png(texture as TextureAsset)));
      }
      writeFileSync(join(OUT, 'data', 'bake-albedo.png'), PNG.sync.write(png(albedo)));
      for (const file of ['armor.ts', 'armor.pack.ts', '__tests__/armor.case.dawn.test.ts', '../case/render.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      const validate = createModelingTools({ projectRoot: ROOT }).find((t) => t.descriptor.id === 'model.validate');
      const report = (await validate?.execute({ source: 'examples/armor-bake/armor.pack.ts', uniqueUv: true } as never, {} as never)) as {
        ok: boolean;
        value?: unknown;
      };
      expect(report.ok).toBe(true);
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(report.value, null, 2)}\n`);

      // The tangent frame gate on the case itself: the bake's base frame equals the rendered export.
      const decoded = decodeSnapshot(base.snapshot());
      if (!decoded.ok) throw decoded.error;
      const surface = bakeSurface(decoded.value, BASE_NORMALS);
      if (!surface.ok) throw surface.error;
      const exported = base.toMesh({ normals: BASE_NORMALS });
      if (!exported.ok) throw exported.error;
      const attributes = unpackInterleavedVertexAttributes(
        exported.value.mesh.vertices,
        deriveVertexLayoutProjection(exported.value.mesh.attributes),
      ) as unknown as Record<string, Float32Array>;
      const frameMatches =
        attributes.tangent?.length === surface.value.tangent.length &&
        surface.value.tangent.every((t, i) => t === (attributes.tangent as Float32Array)[i]);
      expect(frameMatches).toBe(true);
      const auto = steps.find((s) => s.entry.op === 'uv.auto') as RecordedStep & { line: number };
      const autoInfo = auto.entry.diagnostics?.filter((d) => d.severity === 'info').at(-1)?.detail as Record<string, unknown>;
      const uv = measureUv(base.editMesh);
      if (!uv.ok) throw uv.error;
      const { faceIsland: _faceIsland, islands, ...uvTotals } = uv.value;
      const sourceLines = readFileSync(SOURCE, 'utf8').split('\n');
      const bakeLine = sourceLines.findIndex((l) => l.includes('bakeMaps(')) + 1;
      const bakeData = {
        rule: 'one correspondence pass (ray from distance outside along the base normal, 2 x distance inward, nearest detail point on a miss) feeds the normal, AO and material-id evaluators; tangent space is the exported computeTangentVec4 frame of the base (BASE_NORMALS), decoded by the shaders through applyTBN',
        settings: armorBake(PARAMETERS),
        buildMs: Math.round(buildMs),
        report: bake.report,
        provenance: bake.provenance,
        diagnostics: bake.diagnostics,
        tangentFrameMatchesExport: frameMatches,
        uvAuto: { line: auto.line, args: auto.entry.args, ...autoInfo },
        uv: { ...uvTotals, islands: islands.length },
        maps: Object.fromEntries(Object.keys(textures).map((m) => [m, `data/bake-${m}.png`])),
      };
      writeFileSync(join(OUT, 'bake.json'), `${JSON.stringify(bakeData, null, 2)}\n`);
      const inspection = base.inspect();
      const bakeStep = {
        n: steps.length + 1,
        session: 'base',
        op: 'bake',
        args: armorBake(PARAMETERS),
        sourceLine: bakeLine,
        status: 'ok',
        roles: {},
        result: { verts: inspection.vertices, edges: inspection.edges, faces: inspection.faces },
        diagnostics: bake.diagnostics,
        image: `step-${String(steps.length + 1).padStart(2, '0')}.png`,
        ms: Math.round(Number(bake.report.metrics.work) / 1e6),
      };
      const history = {
        case: 'C-110',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/armor-bake/armor.ts',
        },
        parameters: PARAMETERS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own state from one fixed direction; the comparison views frame the base and the detail beside it; map and layout views look head-on at the unit UV square',
          comparison: pair,
          layout: flat,
        },
        highlight:
          'geometry steps show the faces the step touched in magenta on a box-projected stand-in; uv.* steps show the 32 x 32 checker on the session own uv0; the bake step shows the base with its baked albedo (material ids), normal and AO maps',
        steps: [...steps.map((step, i) => historyStep(step, i + 1)), bakeStep],
        final: {
          base: {
            verts: inspection.vertices,
            faces: inspection.faces,
            triangles: exported.value.report.triangles,
            gpuVertices: exported.value.report.gpuVertices,
          },
          detail: { verts: detail.inspect().vertices, faces: detail.inspect().faces },
          bake: 'bake.json',
          validate: 'validate.json',
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-shaded': 'left: the 136-triangle base with the baked albedo, normal and AO maps; right: the high-poly detail it was baked from',
          'V-shaded-plain': 'the same pair with the base in its plain paint: what the maps add',
          'V-shaded-baked': 'close-up of the baked base on the vent grille, seams and bolts',
          'V-shaded-detail': 'the same close-up of the high-poly detail',
          'V-uv': 'the base with the checker on its uv.auto atlas (6 charts: sharp rims as hard boundaries)',
          'V-uv-layout': 'the uv.auto atlas: one color per chart over the dark unit square',
          'V-uv-normal': 'the baked tangent-space normal map over the UV square',
          'V-uv-ao': 'the baked ambient occlusion map',
          'V-uv-id': 'the baked material-id map (paint red, groove green, vent blue, bolt yellow)',
          'V-tags': labels.legend,
          'V-sel-detail': 'vent slots, seam grooves and bolts of the detail in magenta',
          'V-sel-charts': 'the top chart of the base (faces within 60 degrees of +y)',
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMeshBuilder } from '@forgeax/engine-geometry';
import { bakeMaps, EditMesh, encodeSnapshot, type Model, measureUv, model, type Rig, type StandardMaterialOptions, sel } from '@forgeax/engine-modeling';
import { PackageId } from '@forgeax/engine-pack/guid';
import { skinVertexPosition } from '@forgeax/engine-skinning';
import type { MeshAsset, SkeletonAsset, TextureAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import { CASE_FOV, checkerMesh, checkerTexture, createCaseRenderer, frame, frameModel, frameSnapshot, historyStep, labelMesh, layoutView, stateMesh, touched, uvLayoutMesh, type View } from '../../case/render';
import { ACTUATOR_DEFAULTS, actuatorBake, actuatorFrame, actuatorPath, actuatorRig, buildActuatorDetail, buildActuatorShell, SHELL_NORMALS } from '../actuator';

/**
 * Case evidence on the real Renderer (Dawn): the S6 game-ready route of the mech-gt
 * thigh actuator. In CI it renders the baked shell beside the detail and one skinned pose
 * at a small size; with FORGEAX_CASE_OUT set it writes the case output directory:
 * one image per recorded step (detail and shell sessions), the bake, the rig binding, the
 * boot's automatic weights, the skinned shell along the stroke (posed by the Engine's own
 * `skinVertexPosition` from the exported skinned mesh, wearing the baked maps), the
 * unclamped first design, the V-* views, history.json, bake.json, budget.json, poses.json,
 * the maps as PNG data and the sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const PARAMETERS = OUT === undefined ? { ...ACTUATOR_DEFAULTS, resolution: 128 } : ACTUATOR_DEFAULTS;
const SOURCE = fileURLToPath(new URL('../actuator.ts', import.meta.url));
const DIRECTION = [0.8, 0.35, 0.55];
const POSES = [0, 0.25, 0.5, 0.75, 1] as const;
const HEAT = 10;
const ROD_JOINT = 2;
/** The detail stands beside the shell along +x in the comparison views. */
const OFFSET = 0.075;
const PACKAGE = PackageId.parse('01900000-0000-7000-8000-0000000c0112');
const PORT_CONTACT = [{ parts: ['port', 'ram-barrel'] as [string, string], tolerance: 0.002 }];

const BASE_COLORS = {
  paint: [0.62, 0.36, 0.12],
  steel: [0.42, 0.45, 0.5],
  chrome: [0.8, 0.82, 0.85],
  rubber: [0.08, 0.08, 0.09],
  groove: [0.12, 0.08, 0.05],
} as const;
type BaseSlot = keyof typeof BASE_COLORS;
const SHELL_SLOTS: readonly BaseSlot[] = ['paint', 'steel', 'rubber'];

/** Blue (gland) to red (rod) in HEAT steps. */
const HEAT_COLORS = Object.fromEntries(
  Array.from({ length: HEAT }, (_, b) => {
    const t = b / (HEAT - 1);
    return [`heat${b}`, [0.15 + 0.8 * t, 0.25 + 0.5 * Math.sin(Math.PI * t), 0.95 - 0.8 * t] as const];
  }),
);

const SLOT_COLORS = {
  Default: [0.6, 0.62, 0.66],
  ...BASE_COLORS,
  plain: [0.62, 0.36, 0.12],
  atlas: [0.1, 0.1, 0.11],
  'atlas-border': [0.55, 0.55, 0.58],
  highlight: [0.95, 0.2, 0.55],
  ...HEAT_COLORS,
} as const;

function sourceLine(pattern: string): number {
  const lines = readFileSync(SOURCE, 'utf8').split('\n');
  return lines.findIndex((l) => l.includes(pattern)) + 1;
}

/** Column-major 4x4 multiply. */
function mul(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      out[c * 4 + r] = s;
    }
  return out;
}

function columnMajor(m: ArrayLike<number>): Float32Array {
  return Float32Array.from([m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1] as number[]);
}

interface Skinned {
  readonly mesh: MeshAsset;
  readonly skeleton: SkeletonAsset;
}

function exportSkinned(r: Rig): Skinned {
  if (!PACKAGE.ok) throw new Error('package id');
  const out = r.finish({ key: 'actuator', packageId: PACKAGE.value, form: 'skinned', normals: SHELL_NORMALS, path: actuatorPath(PARAMETERS) });
  if (!out.ok) throw out.error;
  return { mesh: out.value['mesh/actuator'] as MeshAsset, skeleton: out.value['skeleton/actuator'] as SkeletonAsset };
}

/** Skin palette (joint world x inverse bind) of the rig at path parameter u. */
function paletteAt(r: Rig, s: Skinned, u: number): Float32Array {
  const sampled = r.sample(actuatorPath(PARAMETERS), u);
  if (!sampled.ok) throw sampled.error;
  const posed = r.pose(sampled.value);
  if (!posed.ok) throw posed.error;
  const palette = new Float32Array(s.skeleton.jointCount * 16);
  for (const [j, joint] of posed.value.joints.entries()) {
    palette.set(mul(columnMajor(joint.world), s.skeleton.inverseBindMatrices.subarray(j * 16, j * 16 + 16)), j * 16);
  }
  return palette;
}

/**
 * The exported skinned mesh posed by the Engine kernel (`skinVertexPosition`) with smooth
 * normals from the posed triangles. `heat` regroups the boot (slot `rubber`) into heat
 * slots by its mean rod weight per triangle; otherwise every slot gets the `baked-` prefix
 * and wears the baked maps through the exported uv0 and tangents.
 */
function skinnedView(s: Skinned, palette: Float32Array, heat: boolean): MeshAsset {
  const src = s.mesh.attributes.position as Float32Array;
  const index = s.mesh.attributes.skinIndex as Uint16Array;
  const weight = s.mesh.attributes.skinWeight as Float32Array;
  const count = src.length / 3;
  const position = new Float32Array(src.length);
  const xyzw = new Float64Array(4);
  for (let v = 0; v < count; v++) {
    if (!skinVertexPosition(xyzw, src, index, weight, palette, v)) throw new Error(`skinning failed at ${v}`);
    for (let k = 0; k < 3; k++) position[v * 3 + k] = (xyzw[k] as number) / (xyzw[3] as number);
  }
  const indices = s.mesh.indices as Uint16Array | Uint32Array;
  const normal = new Float32Array(src.length);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]] as [number, number, number];
    const e1 = [0, 1, 2].map((k) => (position[b * 3 + k] as number) - (position[a * 3 + k] as number));
    const e2 = [0, 1, 2].map((k) => (position[c * 3 + k] as number) - (position[a * 3 + k] as number));
    const n = [
      (e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number),
      (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number),
      (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number),
    ];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normal[v * 3 + k] = (normal[v * 3 + k] as number) + (n[k] as number);
  }
  // Rest normals keep the shell's hard edges; only the boot (blended vertices) takes posed smooth normals.
  const rest = s.mesh.attributes.normal as Float32Array;
  for (let v = 0; v < count; v++) {
    const blended = (weight[v * 4 + 1] as number) > 0;
    const l = Math.hypot(normal[v * 3] as number, normal[v * 3 + 1] as number, normal[v * 3 + 2] as number) || 1;
    for (let k = 0; k < 3; k++) normal[v * 3 + k] = blended ? (normal[v * 3 + k] as number) / l : (rest[v * 3 + k] as number);
  }
  const rodWeight = (v: number) => {
    let w = 0;
    for (let k = 0; k < 4; k++) if (index[v * 4 + k] === ROD_JOINT) w += weight[v * 4 + k] as number;
    return w;
  };
  const slots = s.mesh.materialSlots.map((slot) => slot.slotName);
  const groups = new Map<string, number[]>();
  for (const sub of s.mesh.submeshes) {
    const name = slots[sub.materialSlot] as string;
    for (let i = sub.indexOffset; i < sub.indexOffset + sub.indexCount; i += 3) {
      const tri = [indices[i], indices[i + 1], indices[i + 2]] as [number, number, number];
      let slot = heat ? name : `baked-${name}`;
      if (heat && name === 'rubber') {
        const mean = (rodWeight(tri[0]) + rodWeight(tri[1]) + rodWeight(tri[2])) / 3;
        slot = `heat${Math.min(HEAT - 1, Math.floor(mean * HEAT))}`;
      }
      const list = groups.get(slot) ?? [];
      list.push(...tri);
      groups.set(slot, list);
    }
  }
  const names = [...groups.keys()].sort();
  const all: number[] = [];
  const submeshes = names.map((name, materialSlot) => {
    const list = groups.get(name) as number[];
    const indexOffset = all.length;
    all.push(...list);
    return { indexOffset, indexCount: list.length, materialSlot };
  });
  const built = createMeshBuilder({
    attributes: { position, normal, uv: s.mesh.attributes.uv as Float32Array, tangent: s.mesh.attributes.tangent as Float32Array },
    indices: count <= 0xffff ? Uint16Array.from(all) : Uint32Array.from(all),
    submeshes,
    materialSlots: names.map((slotName) => ({ slotName })),
  }).build();
  if (!built.ok) throw new Error(built.error.code);
  return built.value;
}

/** The shell with its slots renamed `baked-<slot>`, optionally beside the detail. */
function shellMesh(shell: Model, baked: boolean, detail?: Model): MeshAsset {
  const view = model();
  view.append(shell.snapshot());
  for (const slot of SHELL_SLOTS) if (view.count(sel.material(slot)) > 0) view.assign(sel.material(slot), baked ? `baked-${slot}` : 'plain');
  if (detail !== undefined) view.append(detail.snapshot(), { translate: [OFFSET, 0, 0] });
  const out = view.toMesh({ normals: SHELL_NORMALS });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/** The rest state with one `label:<part>` slot per bound rig part and the boot region. */
function partMesh(shell: Model): MeshAsset {
  const frameOf = actuatorFrame(PARAMETERS);
  const view = model();
  view.append(shell.snapshot());
  view.assign(sel.all(), 'label:barrel');
  view.assign(sel.createdBy('ram-rod-eye'), 'label:rod');
  view.assign(sel.createdBy('boot'), 'label:boot');
  view.assign(sel.createdBy('boot').and(sel.inBox([-1, frameOf.bottom - 1e-4, -1], [1, frameOf.bottom + 0.0031, 1], { by: 'all' })), 'label:clamp-low');
  view.assign(sel.createdBy('boot').and(sel.inBox([-1, frameOf.top - 0.0031, -1], [1, frameOf.top + 1e-4, 1], { by: 'all' })), 'label:clamp-high');
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 35 } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/** The unit UV square as one quad whose uv equals its position, in `slot` (map views). */
function mapQuad(slot: string): MeshAsset {
  const flat = new EditMesh();
  const loop = [flat.addVertex(0, 0, 0), flat.addVertex(1, 0, 0), flat.addVertex(1, 1, 0), flat.addVertex(0, 1, 0)];
  const f = flat.addFace(loop, flat.nameIndex(flat.materialNames, slot)).unwrap();
  for (const h of flat.faceHalves(f)) {
    const p = flat.position(flat.hVert[h] as number);
    flat.setCorner('uv0', h, [p[0], 1 - p[1]]);
  }
  const view = model();
  view.append(encodeSnapshot(flat));
  const out = view.toMesh({ normals: { mode: 'flat' } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

function png(texture: TextureAsset): PNG {
  const { width, height } = texture.shape.extent;
  const image = new PNG({ width, height });
  image.data.set((texture.data as Uint8Array).subarray(0, width * height * 4));
  return image;
}

function triangles(m: Model): number {
  const out = m.toMesh({ normals: SHELL_NORMALS });
  if (!out.ok) throw out.error;
  return out.value.report.triangles;
}

function crossings(r: Rig, u: number): number {
  const pose = r.sample(actuatorPath(PARAMETERS), u);
  if (!pose.ok) throw pose.error;
  const posed = r.posedSnapshot(pose.value);
  if (!posed.ok) throw posed.error;
  const view = model();
  view.append(posed.value);
  const issue = view.validate().issues.find((i) => i.code === 'self-intersection' && i.detail.certainty === 'confirmed');
  return (issue?.detail.total as number | undefined) ?? 0;
}

const isUv = (step: RecordedStep) => step.entry.op.startsWith('uv.');

describe('C-112 case evidence on the real renderer (Dawn)', () => {
  it('renders the detail and shell builds, the bake, the weights and the skinned shell along the stroke', { timeout: 5400000 }, async () => {
    const recording = recordingSessions();
    const t0 = performance.now();
    const detail = buildActuatorDetail(PARAMETERS, recording.session);
    const shell = buildActuatorShell(PARAMETERS, recording.session);
    const buildMs = performance.now() - t0;
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    const t1 = performance.now();
    const baked = bakeMaps({ base: shell, detail, ...actuatorBake(PARAMETERS) });
    if (!baked.ok) throw baked.error;
    const bakeMs = performance.now() - t1;
    const textures = baked.value.textures as Required<Pick<typeof baked.value.textures, 'normal' | 'ao'>>;
    const r = actuatorRig(shell, PARAMETERS);
    const skinned = exportSkinned(r);
    const span = actuatorFrame(PARAMETERS);
    const stroke = PARAMETERS.stroke;
    const boot: View = frame(
      { min: [-0.03, span.bottom - 0.012 - PARAMETERS.rest * stroke, -0.03], max: [0.03, span.rodEye[1] + 0.02 + (1 - PARAMETERS.rest) * stroke, 0.03] },
      CASE_FOV,
      DIRECTION,
    );
    const pairModel = model();
    pairModel.append(shell.snapshot());
    pairModel.append(detail.snapshot(), { translate: [OFFSET, 0, 0] });
    const pair = frameModel(pairModel, [0.35, 0.3, 1]);
    const main = frameModel(shell, DIRECTION);
    const mapMaterial = (texture: (key: string, t: TextureAsset) => { texture: string } | unknown, key: string, map: TextureAsset) =>
      ({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.8, baseColorTexture: { texture: texture(key, map) } }) as StandardMaterialOptions;
    const renderer = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['steel', 'chrome'],
      view: pair,
      checker: checkerTexture(),
      materials: {
        ...Object.fromEntries(
          SHELL_SLOTS.map((slot) => {
            const c = BASE_COLORS[slot];
            return [
              `baked-${slot}`,
              (texture: (key: string, t: TextureAsset) => unknown) =>
                ({
                  baseColor: [c[0], c[1], c[2], 1],
                  metallic: slot === 'steel' ? 0.6 : 0,
                  roughness: slot === 'rubber' ? 0.8 : 0.45,
                  normalTexture: { texture: texture('actuator-normal', textures.normal) },
                  occlusionTexture: { texture: texture('actuator-ao', textures.ao) },
                }) as StandardMaterialOptions,
            ];
          }),
        ),
        'map-normal': (texture) => mapMaterial(texture, 'map-normal', textures.normal),
        'map-ao': (texture) => mapMaterial(texture, 'map-ao', textures.ao),
      },
    });
    try {
      const at = async (view: View, mesh: MeshAsset, legend?: readonly string[]) => {
        renderer.aim(view);
        const image = await renderer.render(mesh, legend);
        expect(renderer.covered(image)).toBeGreaterThan(0);
        return image;
      };
      const bakedPair = await at(pair, shellMesh(shell, true, detail));
      expect(renderer.covered(bakedPair)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      const extended = await at(boot, skinnedView(skinned, paletteAt(r, skinned, 0.5), false));
      expect(renderer.covered(extended)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(renderer.state()).toBe('alive');
      if (OUT === undefined) return;

      const images: PNG[] = [];
      for (const step of steps) {
        images.push(await at(frameSnapshot(step.snapshot, DIRECTION), isUv(step) ? checkerMesh(step.snapshot) : stateMesh(step.snapshot, touched(step))));
      }
      const extra: { png: PNG; entry: Record<string, unknown> }[] = [];
      const inspection = shell.inspect();
      extra.push({
        png: await at(main, shellMesh(shell, true)),
        entry: {
          session: 'shell',
          op: 'bake (normal, ao)',
          sourceLine: sourceLine('export function actuatorBake'),
          args: actuatorBake(PARAMETERS),
          result: { verts: inspection.vertices, edges: inspection.edges, faces: inspection.faces, metrics: baked.value.report.metrics, backend: baked.value.report.backend, quality: baked.value.report.quality },
        },
      });
      const weights = r.weights('boot');
      if (!weights.ok) throw weights.error;
      const parts = r.parts();
      if (!parts.ok) throw parts.error;
      const partLegend = ['barrel', 'rod', 'boot', 'clamp-low', 'clamp-high'];
      extra.push({
        png: await at(main, partMesh(shell), partLegend),
        entry: {
          session: 'shell',
          op: 'rig + bindRigid + bindAuto',
          sourceLine: sourceLine('export function actuatorRig'),
          args: {
            joints: r.joints.map((j) => ({ name: j.name, parent: j.parent, kind: j.kind, ...(j.limits === undefined ? {} : { limits: j.limits }) })),
            bindings: [
              { part: 'barrel', joint: 'barrel', faces: 'sel.all()' },
              { part: 'rod', joint: 'rod', faces: "createdBy('ram-rod') | createdBy('ram-rod-eye')" },
              { part: 'boot', joints: ['gland', 'rod'], faces: "createdBy('boot')", auto: true },
              { part: 'clamp-low', joint: 'gland', faces: 'boot faces of the lower collar' },
              { part: 'clamp-high', joint: 'rod', faces: 'boot faces of the upper collar' },
            ],
          },
          result: { parts: parts.value },
          legend: partLegend,
        },
      });
      extra.push({
        png: await at(boot, skinnedView(skinned, paletteAt(r, skinned, 0), true)),
        entry: {
          session: 'shell',
          op: 'skin.bind weights (rod weight, blue 0 to red 1)',
          sourceLine: sourceLine("r.bindAuto(sel.createdBy('boot')"),
          args: { joints: ['gland', 'rod'], resolution: 64, stiffness: 0.2, smoothing: 8, maxInfluences: 4, prune: 0.01 },
          result: { status: weights.value.status, vertices: weights.value.vertices.length, metrics: weights.value.report.metrics, backend: weights.value.report.backend, quality: weights.value.report.quality },
        },
      });
      const poseResults: Record<string, unknown>[] = [];
      for (const u of POSES) {
        const pose = r.sample(actuatorPath(PARAMETERS), u);
        if (!pose.ok) throw pose.error;
        const crossed = crossings(r, u);
        expect(crossed).toBe(0);
        poseResults.push({ u, pose: pose.value, crossings: crossed });
        extra.push({
          png: u === 0.5 && PARAMETERS === ACTUATOR_DEFAULTS ? extended : await at(boot, skinnedView(skinned, paletteAt(r, skinned, u), false)),
          entry: {
            session: 'shell',
            op: 'pose (Engine skinning kernel, baked maps)',
            sourceLine: sourceLine('export function actuatorPath'),
            args: { u, pose: pose.value },
            result: { crossings: crossed, kernel: '@forgeax/engine-skinning skinVertexPosition' },
          },
        });
      }
      const scan = r.scan(actuatorPath(PARAMETERS));
      if (!scan.ok) throw scan.error;
      expect(scan.value.pass).toBe(true);
      const firstRig = actuatorRig(buildActuatorShell(PARAMETERS, undefined, true), PARAMETERS);
      const firstCrossings = crossings(firstRig, 1);
      expect(firstCrossings).toBeGreaterThan(0);
      const firstSkinned = exportSkinned(firstRig);
      extra.push({
        png: await at(boot, skinnedView(firstSkinned, paletteAt(firstRig, firstSkinned, 1), true)),
        entry: {
          session: 'shell',
          op: 'pose (first design: boot simplified with the rest, full retraction)',
          sourceLine: sourceLine('simplifyBoot ? sel.all()'),
          args: { simplifyBoot: true, u: 1 },
          result: { crossings: firstCrossings, note: 'decimating the deforming boot loses the fold geometry its skin needs: the lowest fold crosses itself at full compression; the shell keeps the boot at 24 revolutions and simplifies only the rigid parts' },
        },
      });

      const layout = uvLayoutMesh(shell.snapshot());
      const flat = layoutView(WIDTH / HEIGHT);
      const labels = labelMesh(detail);
      const closeup = frame({ min: [-0.03, span.length * 0.1, -0.03], max: [0.03 + OFFSET, span.length * 0.8, 0.03] }, CASE_FOV, [0.35, 0.3, 1]);
      const views: Record<string, PNG> = {
        'V-shaded': bakedPair,
        'V-shaded-plain': await at(pair, shellMesh(shell, false, detail)),
        'V-bake': await at(closeup, shellMesh(shell, true, detail)),
        'V-bake-normal': await at(flat, mapQuad('map-normal')),
        'V-bake-ao': await at(flat, mapQuad('map-ao')),
        'V-uv': await at(main, checkerMesh(shell.snapshot())),
        'V-uv-layout': await at(flat, layout.mesh, layout.legend),
        'V-tags': await at(frameModel(detail, DIRECTION), labels.mesh, labels.legend),
        'V-budget': await at(pair, shellMesh(shell, false, detail)),
        'V-weights': extra[2]?.png as PNG,
        'V-pose-extended': extended,
        'V-pose-retracted': extra[3 + POSES.length - 1]?.png as PNG,
        'V-validate-clash': extra[extra.length - 1]?.png as PNG,
      };
      mkdirSync(join(OUT, 'source'), { recursive: true });
      mkdirSync(join(OUT, 'data'), { recursive: true });
      const all = [...images, ...extra.map((x) => x.png)];
      for (const [i, image] of all.entries()) writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(image));
      for (const [view, image] of Object.entries(views)) writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(image));
      for (const [map, texture] of Object.entries(textures)) writeFileSync(join(OUT, 'data', `bake-${map}.png`), PNG.sync.write(png(texture)));
      for (const file of ['actuator.ts', 'actuator.pack.ts', '__tests__/actuator.case.dawn.test.ts', '__tests__/actuator.unit.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      const uv = measureUv(shell.editMesh);
      if (!uv.ok) throw uv.error;
      const { faceIsland: _faceIsland, islands, ...uvTotals } = uv.value;
      const auto = steps.find((s) => s.entry.op === 'uv.auto') as RecordedStep & { line: number };
      const autoInfo = auto.entry.diagnostics?.filter((d) => d.severity === 'info').at(-1)?.detail as Record<string, unknown>;
      writeFileSync(
        join(OUT, 'bake.json'),
        `${JSON.stringify({ settings: actuatorBake(PARAMETERS), bakeMs: Math.round(bakeMs), buildMs: Math.round(buildMs), report: baked.value.report, provenance: baked.value.provenance, diagnostics: baked.value.diagnostics, uvAuto: { line: auto.line, args: auto.entry.args, ...autoInfo }, uv: { ...uvTotals, islands: islands.length }, maps: { normal: 'data/bake-normal.png', ao: 'data/bake-ao.png' } }, null, 2)}\n`,
      );
      const detailTriangles = triangles(detail);
      const shellTriangles = triangles(shell);
      const texels = PARAMETERS.resolution * PARAMETERS.resolution;
      const budget = {
        rule: 'triangles after export; texture bytes are rgba8 level 0 (the Pack adds box-filtered mips, x 4/3)',
        detail: { triangles: detailTriangles, materialSlots: ['paint', 'chrome', 'steel', 'rubber', 'groove'] },
        shell: { budget: PARAMETERS.budget, triangles: shellTriangles, materialSlots: [...SHELL_SLOTS], ratio: Number((shellTriangles / detailTriangles).toFixed(4)) },
        maps: { resolution: PARAMETERS.resolution, count: 2, bytes: 2 * texels * 4, bytesWithMips: Math.round((2 * texels * 4 * 4) / 3) },
        skin: { joints: skinned.skeleton.jointCount, influences: 4, gpuVertices: (skinned.mesh.attributes.position as Float32Array).length / 3 },
        lod: 'mesh/actuator is LOD-ready: Import generates the chain from Pack LOD requests (C-015 route, Engine side)',
      };
      writeFileSync(join(OUT, 'data', 'budget.json'), `${JSON.stringify(budget, null, 2)}\n`);
      const rows = Array.from(weights.value.vertices, (v, row) => ({
        vertex: v,
        y: shell.editMesh.position(v)[1],
        joints: Array.from(weights.value.joints.subarray(row * 4, row * 4 + 4)),
        weights: Array.from(weights.value.weights.subarray(row * 4, row * 4 + 4)),
      }));
      writeFileSync(join(OUT, 'data', 'weights.json'), `${JSON.stringify({ report: weights.value.report, status: weights.value.status, rows }, null, 1)}\n`);
      writeFileSync(join(OUT, 'data', 'poses.json'), `${JSON.stringify({ path: actuatorPath(PARAMETERS), poses: poseResults, scan: { pass: scan.value.pass, samples: scan.value.samples.length, evaluated: scan.value.evaluated }, firstDesign: { simplifyBoot: true, u: 1, crossings: firstCrossings } }, null, 1)}\n`);
      const validate = { shell: shell.validate({ uniqueUv: true }), detail: detail.validate({ contacts: PORT_CONTACT }) };
      expect(validate.shell.issues.filter((i) => i.severity !== 'info')).toEqual([]);
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validate, null, 2)}\n`);
      const history = {
        case: 'C-112',
        source: { repo: 'ForgeAX/forgeax-modeling', commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree', file: 'examples/actuator/actuator.ts' },
        parameters: PARAMETERS,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'build steps are framed on their own session state; the bake and rig steps share the shell camera; weight and pose steps share one close-up camera covering the full stroke',
          shell: main,
          boot,
          pair,
        },
        highlight: 'build step images show the faces the step touched in magenta, uv steps the checker; the rig step colors one slot per part; weight and first-design steps color the boot by its rod weight (blue gland to red rod); pose steps show the shell wearing the baked maps',
        steps: [
          ...steps.map((step, i) => historyStep(step, i + 1)),
          ...extra.map((x, i) => ({ n: steps.length + i + 1, ...x.entry, image: `step-${String(steps.length + i + 1).padStart(2, '0')}.png` })),
        ],
        final: { budget, bake: { coverage: baked.value.report.metrics.coverage, rayHitRatio: baked.value.report.metrics.rayHitRatio, charts: islands.length }, parts: parts.value, boot: { vertices: weights.value.vertices.length, status: weights.value.status } },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        data: ['bake.json', 'validate.json', 'data/budget.json', 'data/weights.json', 'data/poses.json', 'data/bake-normal.png', 'data/bake-ao.png'],
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await renderer.dispose();
    }
  });
});

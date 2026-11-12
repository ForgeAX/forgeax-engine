import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeMaps, EditMesh, encodeSnapshot, type Model, model, sel, type StandardMaterialOptions, studioEnvironment, type TextureSink } from '@forgeax/engine-modeling';
import type { MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASE_FOV, createCaseRenderer, frame, frameModel, layoutView, uvLayoutMesh } from '../../case/render';
import { generateMeshLods } from '@forgeax/engine-import/mesh-lod-generator';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { buildS6Mechanics, S6_MECHANICS, type S6Mechanics, s6MechanicsMaterials } from '../s6-mechanics';
import { ATLAS, buildS6, buildS6Detail, S6_GROUPS, S6_LODS, S6_NORMALS, type S6Group, s6Bake, s6Materials, texelDensity, VENTED } from '../s6-exterior';

/**
 * Case C-100 stage S6 evidence on the real Renderer (Dawn): every part group built,
 * auto-UVed and baked (normal and AO maps on its uv0 atlas), then the whole car rendered
 * with its procedural materials and baked maps. In CI it builds every group and renders
 * the assembled car at a small size with small bakes; with FORGEAX_CASE_OUT it writes the
 * stage output directory: one step per group checkpoint, the V-* views, the
 * budget table, validate reports, history.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 800;
const BAKE = (group: S6Group) => (OUT === undefined ? 16 : ATLAS.resolution[group]);
const GROUPS = Object.keys(S6_GROUPS) as S6Group[];
const FRONT = [0.62, 0.38, 0.68];
const REAR = [0.6, 0.42, -0.68];
const SIDE = [1, 0.12, 0.02];
const TOP = [0.05, 1, 0.12];

interface Shot {
  readonly group: S6Group;
  readonly checkpoint: string;
  readonly snapshot: Uint8Array;
}

interface Built {
  readonly group: S6Group;
  readonly base: Model;
  readonly maps: { readonly ao: TextureAsset; readonly normal?: TextureAsset };
  readonly buildMs: number;
  readonly bakeMs: number;
  readonly atlas: unknown;
  /** LOD levels (Import's chain) of the group's tiled render mesh and their reports. */
  readonly lods: { readonly meshes: readonly MeshAsset[]; readonly reports: readonly unknown[] };
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

const exportOf = (m: Model): MeshAsset => unwrap(m.toMesh({ normals: S6_NORMALS })).mesh;
const triangles = (m: Model) => m.editMesh.faces().reduce((n, f) => n + m.editMesh.faceVertices(f).length - 2, 0);

/** A group build whose checkpoints are recorded as steps. */
function build(group: S6Group, shots: Shot[]): Built {
  const t0 = performance.now();
  const base = buildS6(group, () => {
    const m = model();
    const checkpoint = m.checkpoint.bind(m);
    (m as unknown as { checkpoint: (name: string) => unknown }).checkpoint = (name: string) => {
      shots.push({ group, checkpoint: name, snapshot: m.snapshot() });
      return checkpoint(name);
    };
    return m;
  });
  const buildMs = performance.now() - t0;
  shots.push({ group, checkpoint: 'atlas', snapshot: base.snapshot() });
  const auto = [...base.journal].reverse().find((e) => e.op === 'uv.auto');
  const t1 = performance.now();
  const baked = unwrap(bakeMaps({ base, detail: buildS6Detail(group, base), ...s6Bake(group), resolution: BAKE(group), mips: false }));
  const bakeMs = performance.now() - t1;
  const textures = baked.textures as { ao: TextureAsset; normal?: TextureAsset };
  const built = { group, base, maps: { ao: textures.ao, ...(textures.normal === undefined ? {} : { normal: textures.normal }) }, buildMs, bakeMs, atlas: auto?.diagnostics?.find((d: { severity: string }) => d.severity === 'info')?.detail };
  return { ...built, lods: { meshes: [], reports: [] } };
}

/** The group's LOD levels, generated like the Pack does, on its tiled render mesh. */
async function withLods(g: Built, index: number): Promise<Built> {
  const pid = definePackageId('01900000-0000-7000-8000-0000000c1069');
  const generated = await generateMeshLods(exportOf(tiled(g, index)), {
    ...S6_LODS,
    levels: S6_LODS.levels.map((level, k) => ({ ...level, mesh: AssetGuid.derive(pid, `lod/${g.group}/${k}`) })),
  });
  if (!generated.ok) throw new Error(JSON.stringify(generated.error));
  return { ...g, lods: { meshes: generated.value.meshes, reports: generated.value.reports } };
}

/** The material slots that own faces (an inspected slot can be empty, e.g. Default). */
const used = (m: Model) => m.inspect().materials.filter((slot) => m.count(sel.material(slot)) > 0);

/**
 * The evidence renders every group in one scene with one material per slot, so the group
 * atlases share one texture: group k's uv0 square moves to tile (k mod 3, k div 3) of a
 * 3 x 2 sheet and its baked maps are copied to the same tile (texel rows follow v).
 */
const TILES = [3, 2] as const;

function tiled(g: Built, index: number, plain = false): Model {
  const copy = model();
  copy.append(g.base.snapshot());
  const mesh = copy.editMesh;
  const [col, row] = [index % TILES[0], Math.floor(index / TILES[0])];
  for (const f of mesh.faces()) {
    for (const h of mesh.faceHalves(f)) {
      const uv = mesh.corner('uv0', h) as Float32Array;
      mesh.setCorner('uv0', h, [((uv[0] as number) + col) / TILES[0], ((uv[1] as number) + row) / TILES[1]]);
    }
  }
  if (plain && copy.count(sel.material('louvre')) > 0) copy.assign(sel.material('louvre'), 'louvre-plain');
  return copy;
}

/** Every group in one model on the tiled sheet. */
function assembled(groups: readonly Built[], plain = false): Model {
  const car = model();
  for (const g of groups) car.append(tiled(g, GROUPS.indexOf(g.group), plain).snapshot());
  return car;
}

/** Texels per group tile in the render sheets: the case renderer publishes its pack as JSON, so full 1024 bakes would overflow it. */
const TILE = OUT === undefined ? 16 : 512;

/** One sheet of every group's baked map, box-filtered to TILE texels per group (missing maps: `fill`). */
function sheet(groups: readonly Built[], map: 'ao' | 'normal', fill: readonly [number, number, number, number]): TextureAsset {
  const width = TILE * TILES[0];
  const height = TILE * TILES[1];
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  let sample: TextureAsset | undefined;
  for (const g of groups) {
    const texture = g.maps[map];
    if (texture === undefined) continue;
    sample ??= texture;
    const k = GROUPS.indexOf(g.group);
    const [col, row] = [k % TILES[0], Math.floor(k / TILES[0])];
    const src = texture.data as Uint8Array;
    const res = BAKE(g.group);
    // Box filter over the source texels each tile texel covers (the group resolutions differ).
    const span = (i: number): [number, number] => [Math.floor((i * res) / TILE), Math.max(Math.floor((i * res) / TILE) + 1, Math.floor(((i + 1) * res) / TILE))];
    for (let y = 0; y < TILE; y++) {
      const [y0, y1] = span(y);
      for (let x = 0; x < TILE; x++) {
        const [x0, x1] = span(x);
        const o = ((row * TILE + y) * width + col * TILE + x) * 4;
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) sum += src[(sy * res + sx) * 4 + c] as number;
          data[o + c] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
        }
      }
    }
  }
  const base = sample ?? (groups[0] as Built).maps.ao;
  return { ...base, shape: { viewDimension: '2d', extent: { width, height } }, mips: { kind: 'none' }, data } as TextureAsset;
}

/** A baked map as a PNG (rgba8 rows). */
function mapPng(texture: TextureAsset): PNG {
  const { width, height } = texture.shape.extent as { width: number; height: number };
  const png = new PNG({ width, height });
  png.data.set((texture.data as Uint8Array).subarray(0, width * height * 4));
  return png;
}

/** One material per slot: the S6 recipe plus the AO sheet (and the louver normal sheet on `louvre`). */
function materials(groups: readonly Built[]): Record<string, (texture: TextureSink) => StandardMaterialOptions> {
  const recipes = s6Materials({ mips: false });
  const ao = sheet(groups, 'ao', [255, 255, 255, 255]);
  const normal = sheet(groups, 'normal', [128, 128, 255, 255]);
  const out: Record<string, (texture: TextureSink) => StandardMaterialOptions> = {};
  const slots = new Set(groups.flatMap((g) => used(g.base)));
  for (const slot of slots) {
    const recipe = recipes[slot] ?? (() => ({ baseColor: [0.5, 0.5, 0.5, 1], metallic: 0, roughness: 0.6 }) as StandardMaterialOptions);
    const withMaps = (withNormal: boolean) => (texture: TextureSink) =>
      ({
        ...recipe(texture),
        occlusionTexture: { texture: texture('s6-ao', ao) },
        ...(withNormal ? { normalTexture: { texture: texture('s6-normal', normal) }, normalScale: [1, 1] } : {}),
      }) as StandardMaterialOptions;
    out[slot] = withMaps(slot === 'louvre');
    if (slot === 'louvre') out['louvre-plain'] = withMaps(false);
  }
  out['map-ao'] = (texture) => ({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1, baseColorTexture: { texture: texture('s6-ao', ao) } }) as StandardMaterialOptions;
  out['map-normal'] = (texture) => ({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1, baseColorTexture: { texture: texture('s6-normal', normal) } }) as StandardMaterialOptions;
  return out;
}

/** A flat quad showing a texture over the unit square, as the image reads (V-uv-ao, V-uv-normal). */
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
  return unwrap(view.toMesh({ normals: { mode: 'flat' } })).mesh;
}

/** A mechanics group for display: its slots renamed `mech-<slot>` (they share names with body slots). */
interface Mechanics {
  readonly group: S6Mechanics;
  readonly model: Model;
  readonly buildMs: number;
  readonly lods: readonly unknown[];
}

async function mechanics(group: S6Mechanics): Promise<Mechanics> {
  const t0 = performance.now();
  const built = buildS6Mechanics(group);
  const buildMs = performance.now() - t0;
  const view = model();
  view.append(built.snapshot());
  for (const slot of used(view)) view.assign(sel.material(slot), `mech-${slot}`);
  const pid = definePackageId('01900000-0000-7000-8000-0000000c1069');
  const generated = await generateMeshLods(exportOf(built), { ...S6_LODS, levels: S6_LODS.levels.map((level, k) => ({ ...level, mesh: AssetGuid.derive(pid, `lod/${group}/${k}`) })) });
  if (!generated.ok) throw new Error(JSON.stringify(generated.error));
  return { group, model: view, buildMs, lods: generated.value.reports };
}

describe('C-100 S6 case evidence on the real renderer (Dawn)', () => {
  it('builds, auto-UVs and bakes every group and renders the finished car', { timeout: 3_600_000 }, async () => {
    const shots: Shot[] = [];
    const groups = await Promise.all(GROUPS.map((g) => build(g, shots)).map((g) => withLods(g, GROUPS.indexOf(g.group))));
    for (const g of groups) expect([g.group, g.base.poisoned]).toEqual([g.group, undefined]);
    const car = assembled(groups);
    const front = frameModel(car, FRONT);
    // A cooked Standard material publishes as about 20 MB of JSON in the case renderer, so the
    // body and the mechanics render with separate renderers (the second test).
    const recipes = materials(groups);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: { Default: [0.6, 0.6, 0.62] },
      materials: recipes,
      environment: unwrap(studioEnvironment()),
      view: front,
    });
    try {
      const shaded = await r.render(exportOf(car));
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      mkdirSync(join(OUT, 'data'), { recursive: true });
      mkdirSync(join(OUT, 'source'), { recursive: true });
      const save = (name: string, png: PNG) => writeFileSync(join(OUT, name), PNG.sync.write(png));
      const at = async (direction: readonly number[], mesh: MeshAsset, of: Model) => {
        r.aim(frameModel(of, direction));
        return r.render(mesh);
      };

      // Steps: every group checkpoint, framed on that group's finished parts.
      const steps = [];
      for (const [i, shot] of shots.entries()) {
        const state = model();
        state.append(shot.snapshot);
        const g = groups.find((x) => x.group === shot.group) as Built;
        const view = shot.checkpoint === 'atlas' ? tiled(g, GROUPS.indexOf(g.group)) : model();
        if (shot.checkpoint !== 'atlas') {
          // States before the atlas lack complete coordinates: box-project both channels; no baked maps yet.
          view.append(shot.snapshot);
          for (const channel of ['uv0', 'uv1'] as const) view.uv.project({ mode: 'box', scale: 1, channel });
        }
        const image = `step-${String(i + 1).padStart(2, '0')}.png`;
        save(image, await at(shot.group === 'wheels' ? SIDE : FRONT, exportOf(view), g.base));
        steps.push({ n: i + 1, group: shot.group, checkpoint: shot.checkpoint, faces: state.inspect().faces, triangles: triangles(state), image });
      }

      // Views of the finished car and the bake.
      const rear = groups.find((g) => g.group === 'rear') as Built;
      const cover = model();
      cover.append(rear.base.snapshot());
      cover.delete(sel.all().minus(sel.tag('part:engine-cover-l').or(sel.tag('part:engine-cover-r'))));
      const coverView = frame(unwrap(cover.bounds(sel.all())), CASE_FOV, [0.35, 0.9, -0.25]);
      const views: Record<string, PNG> = {
        'V-shaded-front': shaded,
        'V-shaded-rear': await at(REAR, exportOf(car), car),
        'V-shaded-side': await at(SIDE, exportOf(car), car),
        'V-shaded-top': await at(TOP, exportOf(car), car),
      };
      r.aim(coverView);
      views['V-bake-louvers'] = await r.render(exportOf(assembled([rear])));
      views['V-bake-louvers-plain'] = await r.render(exportOf(assembled([rear], true)));
      const detail = buildS6Detail('rear', rear.base);
      const detailView = model();
      detailView.append(detail.snapshot());
      for (const channel of ['uv0', 'uv1'] as const) detailView.uv.project({ mode: 'box', scale: 1, channel });
      if (detailView.count(sel.material('louvre')) > 0) detailView.assign(sel.material('louvre'), 'louvre-plain');
      views['V-bake-source'] = await r.render(exportOf(detailView));
      for (const g of groups) {
        const layout = uvLayoutMesh(g.base.snapshot());
        r.aim(layoutView(WIDTH / HEIGHT));
        views[`V-uv-layout-${g.group}`] = await r.render(layout.mesh, layout.legend);
      }
      r.aim(layoutView(WIDTH / HEIGHT));
      views['V-uv-ao'] = await r.render(mapQuad('map-ao'));
      views['V-uv-normal'] = await r.render(mapQuad('map-normal'));
      // LOD: the front group at LOD0, LOD1 and LOD2 from the same camera.
      const frontGroup = groups.find((g) => g.group === 'front') as Built;
      r.aim(frameModel(frontGroup.base, FRONT));
      views['V-lod-0'] = await r.render(exportOf(tiled(frontGroup, GROUPS.indexOf('front'))));
      for (const [k, mesh] of frontGroup.lods.meshes.entries()) views[`V-lod-${k + 1}`] = await r.render(mesh);
      for (const [name, png] of Object.entries(views)) save(`view-${name}.png`, png);
      for (const g of groups) for (const [map, texture] of Object.entries(g.maps)) save(`data/bake-${g.group}-${map}.png`, mapPng(texture));

      // Budget: per group faces, triangles, material slots, atlas and bake facts.
      const budget = groups.map((g) => ({
        group: g.group,
        parts: S6_GROUPS[g.group],
        faces: g.base.inspect().faces,
        triangles: triangles(g.base),
        slots: used(g.base),
        atlas: { resolution: ATLAS.resolution[g.group], padding: ATLAS.padding, texelsPerMeter: Math.round(texelDensity(g.base, ATLAS.resolution[g.group])), metrics: g.atlas },
        bake: { resolution: BAKE(g.group), maps: s6Bake(g.group).maps, normalOn: VENTED(g.group), ms: Math.round(g.bakeMs) },
        lods: S6_LODS.levels.map((level, k) => ({ ...level, report: g.lods.reports[k] })),
        buildMs: Math.round(g.buildMs),
      }));
      writeFileSync(join(OUT, 'data/budget.json'), `${JSON.stringify({ schema: 'forgeax.mech-gt.budget/1', stage: 'S6', groups: budget, total: { exterior: { faces: budget.reduce((n, b) => n + b.faces, 0), triangles: budget.reduce((n, b) => n + b.triangles, 0) } } }, null, 2)}\n`);
      for (const g of groups) writeFileSync(join(OUT, `data/validate-${g.group}.json`), `${JSON.stringify(g.base.validate(), null, 2)}\n`);
      for (const file of ['s6-exterior.ts', 's6-mechanics.ts', 's6-pack.ts', 's6-front.pack.ts', '__tests__/s6.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      writeFileSync(
        join(OUT, 'history.json'),
        `${JSON.stringify(
          {
            case: 'C-100-S6',
            stage: 'S6',
            codeName: 'mech-gt',
            source: { repo: 'ForgeAX/forgeax-modeling', commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree', files: ['examples/mech-gt/s6-exterior.ts', 'examples/mech-gt/s6-pack.ts'] },
            renderer: `Dawn (createCaseRenderer), procedural Standard materials, studio environment, baked AO on every slot and the baked louver normal map (baked at the group atlas resolution, 1088-2176 texels, rendered from ${TILE}-texel box-filtered tiles; full maps in data/bake-*.png)`,
            cameras: { fov: CASE_FOV, width: WIDTH, height: HEIGHT, rule: 'steps: framed on the finished group from the front three-quarter (wheels: side); views name their direction' },
            steps,
            views: Object.keys(views).map((v) => ({ view: v, image: `view-${v}.png` })),
            budget: 'data/budget.json',
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await r.dispose();
    }
  });

  it('renders the mechanics: internals, stowed core, and both inside the wheels with the body left out', { timeout: 3_600_000 }, async () => {
    const mech = await Promise.all(S6_MECHANICS.map((g) => mechanics(g)));
    for (const m of mech) expect([m.group, m.model.poisoned]).toEqual([m.group, undefined]);
    const shots: Shot[] = [];
    const wheels = await withLods(build('wheels', shots), GROUPS.indexOf('wheels'));
    const bare = model();
    for (const m of mech) bare.append(m.model.snapshot());
    const plainWheels = model();
    plainWheels.append(wheels.base.snapshot());
    for (const slot of used(plainWheels)) plainWheels.assign(sel.material(slot), `mech-wheel-${slot}`);
    bare.append(plainWheels.snapshot());
    const body = s6Materials({ mips: false });
    const recipes = {
      ...Object.fromEntries(Object.entries(s6MechanicsMaterials({ mips: false })).map(([slot, recipe]) => [`mech-${slot}`, recipe])),
      ...Object.fromEntries(used(wheels.base).map((slot) => [`mech-wheel-${slot}`, body[slot] as (texture: TextureSink) => StandardMaterialOptions])),
    };
    const r = await createCaseRenderer({ width: WIDTH, height: HEIGHT, slots: { Default: [0.6, 0.6, 0.62] }, materials: recipes, environment: unwrap(studioEnvironment()), view: frameModel(bare, FRONT) });
    try {
      const shaded = await r.render(exportOf(bare));
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;
      const at = async (direction: readonly number[], mesh: MeshAsset, of: Model) => {
        r.aim(frameModel(of, direction));
        return r.render(mesh);
      };
      const views: Record<string, PNG> = {
        'V-shaded-bare': shaded,
        'V-shaded-bare-side': await at(SIDE, exportOf(bare), bare),
        'V-shaded-internals': await at(FRONT, exportOf((mech[0] as Mechanics).model), (mech[0] as Mechanics).model),
        'V-shaded-core': await at(FRONT, exportOf((mech[1] as Mechanics).model), (mech[1] as Mechanics).model),
      };
      for (const [name, png] of Object.entries(views)) writeFileSync(join(OUT, `view-${name}.png`), PNG.sync.write(png));
      const budgetFile = join(OUT, 'data/budget.json');
      const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));
      budget.mechanics = mech.map((m) => ({
        group: m.group,
        faces: m.model.inspect().faces,
        triangles: triangles(m.model),
        slots: used(m.model).map((slot) => slot.replace(/^mech-/, '')),
        lods: S6_LODS.levels.map((level, k) => ({ ...level, report: m.lods[k] })),
        buildMs: Math.round(m.buildMs),
      }));
      const all = [...budget.groups, ...budget.mechanics] as { faces: number; triangles: number }[];
      budget.total = { faces: all.reduce((n, b) => n + b.faces, 0), triangles: all.reduce((n, b) => n + b.triangles, 0), exterior: budget.total.exterior ?? budget.total };
      writeFileSync(budgetFile, `${JSON.stringify(budget, null, 2)}\n`);
      const historyFile = join(OUT, 'history.json');
      const history = JSON.parse(readFileSync(historyFile, 'utf8'));
      history.views = [...history.views, ...Object.keys(views).map((v) => ({ view: v, image: `view-${v}.png` }))];
      writeFileSync(historyFile, `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});

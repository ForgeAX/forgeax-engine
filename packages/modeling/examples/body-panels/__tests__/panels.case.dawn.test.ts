import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MeshAsset } from '@forgeax/engine-types';
import {
  type Model,
  model,
  nurbs,
  sel,
  type StandardMaterialOptions,
  type TextureSink,
  type Tuple3,
  proceduralMaterials,
  type Region2,
  region2d,
  studioEnvironment,
  type SurfacePatch,
} from '@forgeax/engine-modeling';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, type RecordedStep, recordingSessions } from '../../case/record';
import {
  CASE_FOV,
  createCaseRenderer,
  frameModel,
  highlighted,
  historyStep,
  labelMesh,
  touched,
} from '../../case/render';
import {
  buildPanels,
  fenderPatches,
  hoodPatches,
  PAINT,
  PANELS,
  panelMaterials,
  planHalf,
  profileY,
} from '../panels';

/**
 * Case evidence on the real Renderer (Dawn): every step with the procedural
 * materials, final views and a material sheet. In CI it renders the last step and the
 * finished set; with FORGEAX_CASE_OUT it writes the case output directory.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../panels.ts', import.meta.url));
/** Front three-quarter from the left and above: hood, left fender, arch and badge. */
const DIRECTION = [0.62, 0.5, 0.6];
const RIGHT = [-0.62, 0.42, 0.66];

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

/** A finished copy of a session state: highlight slot for the touched faces, weighted normals. */
function finished(snapshot: Uint8Array, highlight?: Parameters<Model['assign']>[0]): MeshAsset {
  const view = model();
  view.append(snapshot);
  if (highlight !== undefined && view.count(highlight) > 0) view.assign(highlight, 'highlight');
  // Rims exist between the shell step and the UV step without corner values.
  const rims = sel.createdBy('wall', 'rim');
  if (view.count(rims) > 0) {
    view.uv.project({ mode: 'box', scale: 1, faces: rims });
    view.uv.project({ mode: 'box', scale: 1, faces: rims, channel: 'uv1' });
  }
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

/** Swatch: a curved 0.4 m panel (uv0 meters, uv1 domain) over a flat checker plate. */
function swatch(material: string): MeshAsset {
  const grid = [0, 1, 2, 3, 4].map((i) =>
    [0, 1, 2, 3, 4].map((j): Tuple3 => {
      const x = (i / 4 - 0.5) * 0.4;
      const z = (j / 4 - 0.5) * 0.4;
      return [x, 0.06 + 0.05 * Math.cos((x / 0.4) * Math.PI) * Math.cos((z / 0.4) * Math.PI), z];
    }),
  );
  const s = unwrap(nurbs.grid(grid));
  const m = model();
  m.surface({ patches: [{ surface: s, flip: true }], chord: 0.0004, material });
  m.box({ size: [0.46, 0.01, 0.46], center: [0, -0.005, 0], material: 'plate' });
  m.uv.project({ mode: 'box', scale: 1, faces: sel.material('plate') });
  m.uv.project({ mode: 'box', scale: 0.46, faces: sel.material('plate'), channel: 'uv1' });
  return unwrap(m.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } })).mesh;
}

const SWATCHES = ['paint', 'carbon', 'chrome', 'brushed', 'glass', 'tire', 'emissive', 'number-l'] as const;

function sheetMaterials(): Record<string, (texture: TextureSink) => StandardMaterialOptions> {
  // Lavapipe samples the coarsest mip along triangle edges: render without mips.
  const panel = panelMaterials({ mips: false });
  const placement = { mips: false } as const;
  return {
    ...panel,
    chrome: () => unwrap(proceduralMaterials.metal({ finish: 'chrome' })),
    brushed: (texture) =>
      unwrap(proceduralMaterials.metal({ finish: 'brushed', texture, placement })),
    glass: () => proceduralMaterials.glass(),
    tire: (texture) => unwrap(proceduralMaterials.tire({ texture, pitch: 0.06, placement })),
    emissive: (texture) =>
      unwrap(
        proceduralMaterials.emissive({
          color: [1, 0.25, 0.05],
          intensity: 2,
          segments: { count: 8, gap: 0.3, texture },
          placement: { ...placement, tile: 0.4 },
        }),
      ),
    plate: (texture) =>
      unwrap(
        proceduralMaterials.decal(
          { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.6 },
          {
            texture,
            key: 'checker',
            mips: false,
            width: 64,
            height: 64,
            background: [0.85, 0.85, 0.82, 1],
            layers: [
              {
                region: Array.from({ length: 16 }, (_, k) => {
                  const x = (k % 4) / 4;
                  const y = Math.floor(k / 4) / 4 + ((k % 4) % 2) / 8;
                  return {
                    outer: [
                      [x, y],
                      [x + 0.25, y],
                      [x + 0.25, y + 0.125],
                      [x, y + 0.125],
                    ] as [number, number][],
                  };
                }),
                color: [0.12, 0.12, 0.13, 1],
              },
            ],
          },
        ),
      ),
  };
}

describe('C-106 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step, the final views and the material sheet', { timeout: 1800000 }, async () => {
    const recording = recordingSessions();
    const panels = buildPanels(recording.session);
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(panels, DIRECTION);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: { Default: [0.6, 0.6, 0.62], highlight: [0.95, 0.2, 0.55] },
      materials: sheetMaterials(),
      environment: unwrap(studioEnvironment()),
      view: main,
    });
    try {
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        r.aim(main);
        const png = await r.render(finished(step.snapshot, touched(step)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      const exported = panels.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const at = async (direction: readonly number[], mesh: MeshAsset, legend?: readonly string[], of: Model = panels) => {
        r.aim(frameModel(of, direction));
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const patches = model();
      patches.append(panels.snapshot());
      const patchNames = ['hood-l', 'hood-r', 'fender-l-front', 'fender-l-rear', 'fender-r-front', 'fender-r-rear'];
      for (const name of patchNames) patches.assign(sel.tag(name), `label:${name}`);
      const patchMesh = unwrap(patches.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } })).mesh;
      const fenderRear = model();
      fenderRear.append(panels.snapshot());
      fenderRear.delete(sel.all().minus(sel.tag('fender-l-front').or(sel.tag('fender-l-rear'))));
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-right': await at(RIGHT, exported.value.mesh),
        'V-top': await at([0.02, 1, 0.12], exported.value.mesh),
        'V-patches': await r.render(patchMesh, patchNames),
        'V-tags': await (async () => {
          const labels = labelMesh(panels);
          return r.render(labels.mesh, labels.legend);
        })(),
        'V-sel-trims': await r.render(highlighted(panels, sel.createdBy('wall', 'rim'))),
        'V-sel-imprints': await r.render(highlighted(panels, sel.tag('carbon').or(sel.tag('badge')))),
        'V-fender': await at([1, 0.15, 0.05], unwrap(fenderRear.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } })).mesh, undefined, fenderRear),
      };
      // Material sheet: one swatch per material in a 4 x 2 grid.
      const cell = { w: 400, h: 300 };
      const sheet = new PNG({ width: cell.w * 4, height: cell.h * 2 });
      const probe = model();
      probe.box({ size: [0.46, 0.12, 0.46], center: [0, 0.05, 0] });
      for (const [k, name] of SWATCHES.entries()) {
        r.aim(frameModel(probe, [0.5, 0.65, 0.6]));
        const png = await r.render(swatch(name));
        const ox = (k % 4) * cell.w;
        const oy = Math.floor(k / 4) * cell.h;
        for (let y = 0; y < cell.h; y++) {
          for (let x = 0; x < cell.w; x++) {
            const sx = Math.floor((x * WIDTH) / cell.w);
            const sy = Math.floor((y * WIDTH) / cell.w + (HEIGHT - (cell.h * WIDTH) / cell.w) / 2);
            const s = (Math.min(HEIGHT - 1, sy) * WIDTH + sx) * 4;
            const o = ((oy + y) * sheet.width + ox + x) * 4;
            for (let c = 0; c < 4; c++) sheet.data[o + c] = png.data[s + c] as number;
          }
        }
      }
      r.aim(main);
      views['V-materials'] = sheet;

      // Per-tool before/after pairs for the tool cards, each from one fixed camera.
      const tools: Record<string, [MeshAsset, MeshAsset, readonly number[], Model]> = {};
      const plates = (region: Region2, material: string) => {
        const m = model();
        for (const shape of region) {
          m.extrudePolygon({ points: shape.outer, ...(shape.holes === undefined ? {} : { holes: shape.holes }), depth: 0.01, material });
        }
        m.rotate(sel.all(), 'x', -90);
        m.uv.project({ mode: 'box', scale: 1 });
        m.uv.project({ mode: 'box', scale: 1, channel: 'uv1' });
        return m;
      };
      const exportOf = (m: Model) => unwrap(m.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } })).mesh;
      {
        const a: Region2 = [{ outer: [[0, 0], [0.5, 0], [0.5, 0.3], [0, 0.3]] }];
        const b = unwrap(region2d.stroke([[[0.1, 0.15], [0.7, 0.45]]], 0.06));
        const before = plates([...a, ...b.region], 'Default');
        const merged = unwrap(region2d.union(a, b.region));
        const after = plates(unwrap(region2d.offset(merged.region, -0.02)).region, 'paint');
        tools['T-region'] = [exportOf(before), exportOf(after), [0.2, 1, 0.5], before];
      }
      {
        const hood = hoodPatches()[0] as SurfacePatch;
        const net = hood.surface;
        const coarse = model();
        coarse.surface({
          patches: [
            {
              surface: {
                degreeU: 1,
                degreeV: 1,
                points: net.points,
                knotsU: [0, ...net.points.map((_, i) => i / (net.points.length - 1)), 1],
                knotsV: [0, ...(net.points[0] ?? []).map((_, j) => j / ((net.points[0]?.length ?? 2) - 1)), 1],
              },
            },
          ],
          chord: 1,
          material: 'Default',
        });
        const smooth = model();
        smooth.surface({ patches: [{ surface: net }], chord: 0.0015, angle: 12, material: 'paint' });
        tools['T-nurbs'] = [exportOf(coarse), exportOf(smooth), DIRECTION, smooth];
      }
      {
        const [front] = fenderPatches(1) as [SurfacePatch];
        const plain = model();
        plain.surface({ patches: [{ surface: front.surface, name: 'fender' }], chord: 0.0015, angle: 12, material: 'paint' });
        const trimmed = model();
        trimmed.surface({ patches: [front], chord: 0.0015, angle: 12, material: 'paint' });
        tools['T-trim'] = [exportOf(plain), exportOf(trimmed), [1, 0.25, 0.1], plain];
      }
      {
        const rear = model();
        rear.append(panels.snapshot());
        rear.delete(sel.all().minus(sel.tag('fender-l-rear')));
        const painted = model();
        painted.append(rear.snapshot());
        painted.assign(sel.all(), 'paint');
        tools['T-decal'] = [exportOf(painted), exportOf(rear), [1, 0.2, -0.1], rear];
      }
      for (const [tool, [before, after, direction, of]] of Object.entries(tools)) {
        r.aim(frameModel(of, direction));
        writeFileSync(join(OUT, `tool-${tool}-before.png`), PNG.sync.write(await r.render(before)));
        writeFileSync(join(OUT, `tool-${tool}-after.png`), PNG.sync.write(await r.render(after)));
      }
      r.aim(main);

      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of ['panels.ts', 'panels.pack.ts', '__tests__/panels.case.dawn.test.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      const validation = panels.validate();
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(validation, null, 2)}\n`);
      const surfacesState = model();
      surfacesState.append((steps.filter((s) => s.entry.op === 'surface').at(-1) as RecordedStep).snapshot);
      let centerline = 0;
      let plan = 0;
      for (const v of surfacesState.editMesh.vertices()) {
        const [x, y, z] = surfacesState.editMesh.position(v) as [number, number, number];
        if (Math.abs(x) < 1e-9 && z >= PANELS.cowl && y > 0.3) centerline = Math.max(centerline, Math.abs(y - profileY(z)));
        if (Math.abs(x) > 0.9) plan = Math.max(plan, Math.abs(x) - planHalf(z));
      }
      const inspection = panels.inspect();
      const history = {
        case: 'C-106',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/body-panels/panels.ts',
        },
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'steps and V-shaded share one camera on the finished set; other views name their direction',
          main,
        },
        highlight: 'each step image shows the faces the step touched in magenta; all other faces use the procedural materials',
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        fit: {
          contours: 'mech-gt S2 side profile (hood centerline) and plan outline (fender outer line)',
          centerlineDeviation: centerline,
          planDeviation: plan,
          paint: PAINT,
        },
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          gpuVertices: exported.value.report.gpuVertices,
          materialSlots: exported.value.report.materialSlots,
          labels: inspection.labels,
          tags: inspection.tags,
          validate: 'validate.json',
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-patches': patchNames,
          'V-sel-trims': "createdBy('wall', 'rim'): rims of the wheel arches, vents and panel edges",
          'V-sel-imprints': "tag('carbon') or tag('badge'): the carbon strip and the badge text imprinted as faces",
          'V-materials': `swatches left to right, top to bottom: ${SWATCHES.join(', ')}`,
          'V-fender': 'the left fender alone from the side: arch trim, GT badge imprint and the number decal texture',
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});

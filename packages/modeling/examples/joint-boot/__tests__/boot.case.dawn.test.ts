import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EDGE_SHARP,
  EditMesh,
  encodeSnapshot,
  type FaceSelector,
  type Model,
  model,
  type OpReport,
  sel,
} from '@forgeax/engine-modeling';
import { createModelingTools } from '@forgeax/engine-modeling/tools';
import type { MeshAsset } from '@forgeax/engine-types';
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
  historyStep,
  labelMesh,
  stateMesh,
  touched,
} from '../../case/render';
import { BOOT_DEFAULTS, BOOT_GRID, type BootParameters, buildBoot, KNEE } from '../boot';

/**
 * Case evidence on the real Renderer (Dawn). In CI it renders the last step, the
 * finished boot, its clamp selection and the wire view; with FORGEAX_CASE_OUT set it
 * writes the case output directory: one image per step, the final views
 * (shaded, wire per stage, tags, selection, normals and hard edges, validate section,
 * history sheet, budget diff, UV checker), history.json, validate.json and sources.
 */
const OUT = process.env.FORGEAX_CASE_OUT;
const WIDTH = OUT === undefined ? 240 : 1200;
const HEIGHT = OUT === undefined ? 160 : 900;
const SOURCE = fileURLToPath(new URL('../boot.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Three-quarter view from the front, slightly above the knee. */
const DIRECTION = [0.45, 0.32, 0.84] as const;
/** The diff variant: the same boot at a 1500 triangle budget. */
const LEAN: BootParameters = { ...BOOT_DEFAULTS, budget: 1500 };

const SLOT_COLORS = {
  Default: [0.56, 0.58, 0.6],
  rubber: [0.16, 0.16, 0.17],
  steel: [0.72, 0.74, 0.77],
  wire: [0.95, 0.78, 0.25],
  sharp: [0.9, 0.12, 0.1],
  section: [0.95, 0.55, 0.15],
  highlight: [0.95, 0.2, 0.55],
  'tag:cuff-thigh': [0.25, 0.6, 0.9],
  'tag:clamp-thigh': [0.95, 0.75, 0.2],
  'tag:fold': [0.3, 0.75, 0.35],
  'tag:cuff-shin': [0.65, 0.4, 0.85],
  'tag:clamp-shin': [0.9, 0.3, 0.25],
} as const;

const SOURCE_TAGS = ['cuff-thigh', 'clamp-thigh', 'fold', 'cuff-shin', 'clamp-shin'] as const;

type Triple = [number, number, number];

/** One flat ribbon per edge, lifted along the edge normal: a wire overlay the Renderer can draw. */
function ribbons(m: Model, width: number, keep: (mesh: EditMesh, e: number) => boolean): Uint8Array {
  const mesh = m.editMesh;
  const out = new EditMesh();
  const normal = (f: number): Triple => {
    const p = mesh.faceVertices(f).map((v) => mesh.position(v));
    const n: Triple = [0, 0, 0];
    for (let i = 0; i < p.length; i++) {
      const a = p[i] as Triple;
      const b = p[(i + 1) % p.length] as Triple;
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const l = Math.hypot(...n) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  for (const e of mesh.edges()) {
    if (!keep(mesh, e)) continue;
    const [ia, ib] = mesh.edgeVertices(e);
    const a = mesh.position(ia);
    const b = mesh.position(ib);
    const n: Triple = [0, 0, 0];
    for (const f of [mesh.hFace[e * 2] as number, mesh.hFace[e * 2 + 1] as number]) {
      if (f < 0) continue;
      const fn = normal(f);
      n[0] += fn[0];
      n[1] += fn[1];
      n[2] += fn[2];
    }
    const ln = Math.hypot(...n) || 1;
    const nn: Triple = [n[0] / ln, n[1] / ln, n[2] / ln];
    const d: Triple = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const s: Triple = [nn[1] * d[2] - nn[2] * d[1], nn[2] * d[0] - nn[0] * d[2], nn[0] * d[1] - nn[1] * d[0]];
    const ls = (Math.hypot(...s) || 1) / (width / 2);
    const at = (p: Triple, sign: number) =>
      out.addVertex(
        p[0] + (sign * s[0]) / ls + nn[0] * width * 0.6,
        p[1] + (sign * s[1]) / ls + nn[1] * width * 0.6,
        p[2] + (sign * s[2]) / ls + nn[2] * width * 0.6,
      );
    out.addFace([at(a, -1), at(b, -1), at(b, 1), at(a, 1)]);
  }
  return encodeSnapshot(out);
}

/** A state with an overlay part in one slot, plus optional face slots. */
function overlaid(snapshot: Uint8Array, overlay: Uint8Array | undefined, slot: string, faces: readonly [FaceSelector, string][] = []): MeshAsset {
  const view = model();
  view.append(snapshot);
  for (const [selector, name] of faces) if (view.count(selector) > 0) view.assign(selector, name);
  if (overlay !== undefined) {
    view.append(overlay, { tag: 'overlay' });
    view.assign(sel.tag('overlay'), slot);
  }
  view.uv.project({ mode: 'box', scale: 0.5 });
  const out = view.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } });
  if (!out.ok) throw out.error;
  return out.value.mesh;
}

function sessionOf(snapshot: Uint8Array): Model {
  const m = model();
  m.append(snapshot);
  return m;
}

/** A copy of the boot cut through the leg axis with its front half removed: the capped wall section faces the camera. */
function section(m: Model): Model {
  const cut = model();
  cut.append(m.snapshot());
  cut.planeCut({ point: [KNEE[0], KNEE[1], KNEE[2]], normal: [-DIRECTION[0], 0, -DIRECTION[2]], keep: 'positive', fillHoles: true, material: 'section' });
  return cut;
}

/** Contact sheet of step images (box-filtered by `factor`), `columns` per row. */
function contactSheet(images: readonly PNG[], factor: number, columns: number): PNG {
  const w = Math.floor(WIDTH / factor);
  const h = Math.floor(HEIGHT / factor);
  const rows = Math.ceil(images.length / columns);
  const sheet = new PNG({ width: w * columns, height: h * rows });
  for (let i = 0; i < sheet.data.length; i += 4) sheet.data[i + 3] = 255;
  for (const [i, image] of images.entries()) {
    const ox = (i % columns) * w;
    const oy = Math.floor(i / columns) * h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let sum = 0;
          for (let dy = 0; dy < factor; dy++) {
            for (let dx = 0; dx < factor; dx++) sum += image.data[((y * factor + dy) * WIDTH + x * factor + dx) * 4 + c] as number;
          }
          sheet.data[((oy + y) * sheet.width + ox + x) * 4 + c] = Math.round(sum / (factor * factor));
        }
      }
    }
  }
  return sheet;
}

function metricsOf(entry: OpReport): Record<string, number> {
  const info = entry.diagnostics?.find((d) => d.severity === 'info');
  return (info?.detail as { metrics: Record<string, number> }).metrics;
}

function differing(a: PNG, b: PNG): number {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs((a.data[i] as number) - (b.data[i] as number)) + Math.abs((a.data[i + 1] as number) - (b.data[i + 1] as number)) > 24) changed++;
  }
  return changed;
}

describe('C-108 case evidence on the real renderer (Dawn)', () => {
  it('renders every recorded step and the final views', { timeout: 3600000 }, async () => {
    const recording = recordingSessions();
    const boot = buildBoot(BOOT_DEFAULTS, recording.session);
    expect(boot.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    const main = frameModel(boot, DIRECTION);
    // Close-up on the thigh clamp and the first folds of a state, where single triangles read.
    const closeOf = (m: Model) => {
      const b = m.bounds(sel.all());
      if (!b.ok) throw b.error;
      const [cx, cy, cz] = [0, 1, 2].map((k) => ((b.value.min[k] as number) + (b.value.max[k] as number)) / 2) as [number, number, number];
      return frame({ min: [cx - 0.07, cy + 0.06, cz + 0.06], max: [cx + 0.07, cy + 0.2, cz + 0.17] }, CASE_FOV, [0.25, 0.2, 1]);
    };
    const close = closeOf(boot);
    const r = await createCaseRenderer({
      width: WIDTH,
      height: HEIGHT,
      slots: SLOT_COLORS,
      metallic: ['steel'],
      view: main,
      checker: checkerTexture(),
    });
    try {
      const images: PNG[] = [];
      for (const step of OUT === undefined ? steps.slice(-1) : steps) {
        r.aim(frameSnapshot(step.snapshot, DIRECTION));
        const png = await r.render(step.entry.op.startsWith('uv.') ? checkerMesh(step.snapshot) : stateMesh(step.snapshot, touched(step as RecordedStep)));
        expect(r.covered(png)).toBeGreaterThan(0);
        images.push(png);
      }
      r.aim(main);
      const exported = boot.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } });
      if (!exported.ok) throw exported.error;
      const shaded = await r.render(exported.value.mesh);
      expect(r.covered(shaded)).toBeGreaterThan(WIDTH * HEIGHT * 0.05);
      const clampSel = await r.render(overlaid(boot.snapshot(), undefined, 'wire', [[sel.createdBy('clamp'), 'highlight']]));
      // Falsifier: the labeled clamps exist on screen (the highlight changes pixels).
      expect(differing(shaded, clampSel)).toBeGreaterThan(WIDTH * HEIGHT * 0.01);
      r.aim(close);
      const wireFinal = await r.render(overlaid(boot.snapshot(), ribbons(boot, 0.0012, () => true), 'wire'));
      expect(differing(wireFinal, await r.render(overlaid(boot.snapshot(), undefined, 'wire')))).toBeGreaterThan(WIDTH * HEIGHT * 0.02);
      r.aim(main);
      expect(r.state()).toBe('alive');
      if (OUT === undefined) return;

      const at = async (view: ReturnType<typeof frameModel>, mesh: MeshAsset, legend?: readonly string[]) => {
        r.aim(view);
        const png = await r.render(mesh, legend);
        r.aim(main);
        return png;
      };
      const stepOf = (op: string) => steps.find((s) => s.entry.op === op) as RecordedStep & { line: number };
      const union = stepOf('voxel.union');
      const remesh = stepOf('remesh');
      const simplify = stepOf('simplify');
      const uvStep = stepOf('uv.project');
      const wireOf = (step: RecordedStep) => {
        const m = sessionOf(step.snapshot);
        return at(closeOf(m), overlaid(step.snapshot, ribbons(m, 0.0012, () => true), 'wire'));
      };
      const sharpOverlay = ribbons(boot, 0.0025, (mesh, e) => ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0);
      const sourceTags = (() => {
        const view = sessionOf(union.snapshot);
        for (const tag of SOURCE_TAGS) if (view.count(sel.tag(tag)) > 0) view.assign(sel.tag(tag), `tag:${tag}`);
        view.uv.project({ mode: 'box', scale: 0.5 });
        const out = view.toMesh({ normals: { mode: 'weighted' } });
        if (!out.ok) throw out.error;
        return out.value.mesh;
      })();
      const cut = section(boot);
      const lean = buildBoot(LEAN);
      expect(lean.poisoned).toBeUndefined();
      const labels = labelMesh(boot);
      const views: Record<string, PNG> = {
        'V-shaded': shaded,
        'V-wire-union': await wireOf(union),
        'V-wire-remesh': await wireOf(remesh),
        'V-wire-simplify': await wireOf(simplify),
        'V-tags': await r.render(labels.mesh, labels.legend),
        'V-tags-source': await at(frameSnapshot(union.snapshot, DIRECTION), sourceTags, [...SOURCE_TAGS]),
        'V-sel': clampSel,
        'V-normals': await r.render(overlaid(boot.snapshot(), sharpOverlay, 'sharp')),
        'V-validate': await at(frameModel(cut, DIRECTION), overlaid(cut.snapshot(), undefined, 'wire')),
        'V-diff-a': await at(close, overlaid(boot.snapshot(), ribbons(boot, 0.0012, () => true), 'wire')),
        'V-diff-b': await at(close, overlaid(lean.snapshot(), ribbons(lean, 0.0012, () => true), 'wire')),
        'V-uv': await at(frameSnapshot(uvStep.snapshot, DIRECTION), checkerMesh(uvStep.snapshot)),
      };
      views['V-history'] = contactSheet(images, 4, 6);
      mkdirSync(join(OUT, 'source'), { recursive: true });
      for (const [i, png] of images.entries()) {
        writeFileSync(join(OUT, `step-${String(i + 1).padStart(2, '0')}.png`), PNG.sync.write(png));
      }
      for (const [view, png] of Object.entries(views)) {
        writeFileSync(join(OUT, `view-${view}.png`), PNG.sync.write(png));
      }
      for (const file of ['boot.ts', 'boot.pack.ts', '__tests__/boot.case.dawn.test.ts', '../case/render.ts', '../case/record.ts']) {
        copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), join(OUT, 'source', file.split('/').at(-1) as string));
      }
      const validate = createModelingTools({ projectRoot: ROOT }).find((t) => t.descriptor.id === 'model.validate');
      const report = (await validate?.execute({ source: 'examples/joint-boot/boot.pack.ts' } as never, {} as never)) as {
        ok: boolean;
        value?: unknown;
      };
      expect(report.ok).toBe(true);
      writeFileSync(join(OUT, 'validate.json'), `${JSON.stringify(report.value, null, 2)}\n`);
      const jobs = [union, remesh, simplify].map((s) => ({
        op: s.entry.op,
        line: s.line,
        args: s.entry.args,
        metrics: metricsOf(s.entry),
        warnings: s.entry.diagnostics?.filter((d) => d.severity === 'warn').map((d) => d.message) ?? [],
      }));
      const inspection = boot.inspect();
      const sharpEdges = boot.count(sel.edges.sharp());
      const history = {
        case: 'C-108',
        source: {
          repo: 'ForgeAX/forgeax-modeling',
          commit: process.env.FORGEAX_CASE_COMMIT ?? 'working-tree',
          file: 'examples/joint-boot/boot.ts',
        },
        parameters: BOOT_DEFAULTS,
        grid: BOOT_GRID,
        cameras: {
          fov: CASE_FOV,
          width: WIDTH,
          height: HEIGHT,
          rule: 'every step is framed on its own state from one fixed direction; final views frame the finished boot; the wire views and the V-diff pair use one close-up on the thigh clamp, placed on each state own center',
          boot: main,
          close,
        },
        highlight: 'geometry steps show the faces the step touched (its label) in magenta; uv.project shows the checker on the session own uv0',
        steps: steps.map((step, i) => historyStep(step, i + 1)),
        jobs,
        final: {
          verts: inspection.vertices,
          edges: inspection.edges,
          faces: inspection.faces,
          triangles: exported.value.report.triangles,
          gpuVertices: exported.value.report.gpuVertices,
          materialSlots: exported.value.report.materialSlots,
          labels: inspection.labels,
          tags: inspection.tags,
          sharpEdges,
          clampFaces: boot.count(sel.createdBy('clamp')),
          lean: { budget: LEAN.budget, faces: lean.inspect().faces, metrics: metricsOf(lean.journal.find((e) => e.op === 'simplify') as OpReport) },
          validate: 'validate.json',
        },
        views: Object.keys(views).map((view) => ({ view, image: `view-${view}.png` })),
        legend: {
          'V-shaded': 'the finished knee boot: rubber sleeve and steel clamps (exported MeshAsset, auto-smooth 40 degrees)',
          'V-wire-union': 'close-up wire of the voxel smooth union: Surface Nets quads on the 6 mm grid',
          'V-wire-remesh': 'the same close-up after the isotropic remesh: near-equilateral triangles of about 12 mm',
          'V-wire-simplify': 'after QEM simplification to the 4000 triangle budget: large triangles on the smooth folds, dense rows kept along the clamp label borders and hard edges',
          'V-tags': labels.legend,
          'V-tags-source': 'nearest-face provenance of the union surface: the source ring tags each face carries',
          'V-sel': "sel.createdBy('clamp') in magenta: the two offset steel clamps (roles top and side)",
          'V-normals': `the ${sharpEdges} edges marked sharp (red): clamp borders and wall edges, kept exact by simplify`,
          'V-validate': 'section through the leg axis (orange cap): the boot is one closed, hollow corrugated wall',
          'V-history': 'every step, in order (contact sheet of the step images)',
          'V-diff-a': `budget ${BOOT_DEFAULTS.budget} triangles, close-up wire`,
          'V-diff-b': `budget ${LEAN.budget} triangles, same camera: the clamp borders keep their rows while the folds coarsen`,
          'V-uv': 'checker on the cylinder-projected uv0 (the voxel surface itself carries no UVs)',
        },
      };
      writeFileSync(join(OUT, 'history.json'), `${JSON.stringify(history, null, 2)}\n`);
    } finally {
      await r.dispose();
    }
  });
});

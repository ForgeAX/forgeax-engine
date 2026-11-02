// Shared driver of the C-100 stage evidence generators (s1-evidence.mjs, s4-evidence.mjs):
// every image and data file comes from `forgeax model *` run in the modeling project.
// Needs the Dawn environment of `forgeax model render` (Linux: a Vulkan ICD).
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

export const SHEET = { views: ['front', 'right', 'top', 'iso'], width: 400, height: 400 };

export function createEvidence(engineArg, outArg, { sheet = SHEET } = {}) {
  const engine = resolve(engineArg);
  const out = resolve(outArg);
  const project = join(engine, 'packages/modeling');
  const cli = join(engine, 'packages/engine/dist/bin/forgeax.mjs');
  const { PNG } = createRequire(join(engine, 'package.json'))('pngjs');
  mkdirSync(join(out, 'data'), { recursive: true });
  mkdirSync(join(out, 'source'), { recursive: true });

  const git = (...args) => spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' }).stdout.trim();
  function forgeax(op, source, args = {}) {
    const argv = ['model', op, '--source', source];
    for (const [key, value] of Object.entries(args))
      argv.push(`--${key}`, typeof value === 'string' ? value : JSON.stringify(value));
    argv.push('--json');
    const started = performance.now();
    let parsed;
    // Every capture runs the exact contact check of all sessions; on a loaded machine a
    // large assembly can exceed the 60 s capture budget, which is retried.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = spawnSync(process.execPath, [cli, ...argv], { cwd: project, encoding: 'utf8', maxBuffer: 256 << 20 });
      parsed = JSON.parse(result.stdout);
      if (parsed.ok || parsed.error?.code !== 'model-work-budget') break;
    }
    const ms = Math.round(performance.now() - started);
    if (!parsed.ok) throw new Error(`forgeax ${argv.join(' ')}: ${JSON.stringify(parsed.error)}`);
    const command = `forgeax ${argv.map((a) => (/[\s"'[{(]/.test(a) ? `'${a}'` : a)).join(' ')}`;
    return { value: parsed.value, command, ms };
  }
  const copy = (uri, name) => {
    copyFileSync(join(project, uri), join(out, name));
    return name;
  };
  const save = (name, value) => {
    writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`);
    return name;
  };
  const viewOf = (render, view) => render.value.views.find((v) => v.view === view).image;
  /** Side-by-side strip of rendered PNGs; the tiles are removed once composed. */
  function strip(names, target) {
    const images = names.map((name) => PNG.sync.read(readFileSync(join(out, name))));
    const gutter = 4;
    const width = images.reduce((w, image) => w + image.width, 0) + gutter * (images.length - 1);
    const png = new PNG({ width, height: Math.max(...images.map((image) => image.height)) });
    png.data.fill(18);
    let x = 0;
    for (const image of images) {
      PNG.bitblt(image, png, 0, 0, image.width, image.height, x, 0);
      x += image.width + gutter;
    }
    writeFileSync(join(out, target), PNG.sync.write(png));
    for (const name of names) rmSync(join(out, name));
    return target;
  }
  const box = (b) => ({ min: b.slice(0, 3), max: b.slice(3, 6), size: [0, 1, 2].map((k) => b[k + 3] - b[k]), center: [0, 1, 2].map((k) => (b[k + 3] + b[k]) / 2) });
  const selectBounds = (source, selector) => box(forgeax('select', source, { selector }).value.selected.bounds);
  const sources = (files) => {
    for (const file of files) copyFileSync(join(project, 'examples/mech-gt', file), join(out, 'source', file.split('/').at(-1)));
  };

  /**
   * One step per checkpoint of a form's output session, rendered with that form's final
   * bounds as the frame; `final` renders the finished state. Each step lists the
   * operations since the previous step of the same form, with their source lines.
   */
  const steps = [];
  const forms = new Map();
  /** A form's history and final render; `history` passes options to its capture (a longer `timeoutMs`). */
  function form(name, source, history = {}) {
    history = forgeax('history', source, history);
    const final = forgeax('render', source, sheet);
    forms.set(name, { source, history, final, main: history.value.sessions.find((s) => s.output !== undefined) });
    return forms.get(name);
  }
  function stage(name, checkpoint, summary, selector, extra = {}) {
    const f = forms.get(name);
    const previous = steps.filter((s) => s.form === name).at(-1)?.opEnd ?? 0;
    const point = f.main.checkpoints.find((c) => c.name === checkpoint);
    const opEnd = point === undefined ? f.main.steps.length : point.opIndex;
    const render =
      checkpoint === 'final' && selector === undefined && Object.keys(extra).length === 0
        ? f.final
        : forgeax('render', f.source, {
            ...sheet,
            ...extra,
            frame: f.final.value.mesh.bounds,
            ...(checkpoint === 'final' ? {} : { checkpoint }),
            ...(selector === undefined ? {} : { selector }),
          });
    const n = steps.length + 1;
    const ops = f.main.steps.slice(previous, opEnd);
    steps.push({
      n,
      form: name,
      opEnd,
      op: checkpoint === 'final' ? 'model render' : `model render --checkpoint ${checkpoint}`,
      command: render.command,
      checkpoint,
      summary,
      operations: ops.map((s) => ({ opIndex: s.opIndex, op: s.op, label: s.label ?? null, status: s.status, faces: s.faces, sourceLine: s.source?.line ?? null })),
      sourceLines: ops.length === 0 ? null : [ops[0].source?.line ?? null, ops.at(-1).source?.line ?? null],
      ...(selector === undefined ? {} : { selector }),
      ...(Object.keys(extra).length === 0 ? {} : { options: extra }),
      ...(render.value.views.some((v) => v.annotation) ? { annotation: render.value.views.map((v) => ({ view: v.view, extents: v.annotation?.extents, measures: v.annotation?.measures })) } : {}),
      result: { faces: render.value.mesh.faces, triangles: render.value.mesh.triangles, materialSlots: render.value.mesh.materialSlots, coverage: render.value.views.map((v) => ({ view: v.view, coverage: v.coverage })) },
      image: copy(render.value.sheet.image, `step-${String(n).padStart(2, '0')}.png`),
      ms: render.ms,
    });
  }
  const historySteps = () => steps.map(({ opEnd, ...s }) => s);

  return { project, out, git, forgeax, copy, save, viewOf, strip, box, selectBounds, sources, form, stage, historySteps };
}

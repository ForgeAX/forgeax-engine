import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Collects each finished run: measures the delivered mesh with the bench's own measure.mjs,
// checks the condition's protocol, then lifts the mesh into one neutral modeling session and
// runs `forgeax model validate` and `forgeax model render` (real Dawn renderer) on it.

const here = import.meta.dirname;
const engineRoot = resolve(here, '../../../..');
const forgeax = join(engineRoot, 'packages/engine/dist/bin/forgeax.mjs');
const protocol = JSON.parse(readFileSync(join(here, 'protocol.json'), 'utf8'));
const briefSet = JSON.parse(readFileSync(join(here, 'briefs.json'), 'utf8'));

const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: '/tmp/m5-runs' },
    runs: { type: 'string' },
  },
});

// `view` drops zero-area triangles before lifting, so a mesh the strict validation rejects
// still gets a review image; they cover no pixels. Validation keeps the strict `eval` form.
function wrapperPack(view) {
  return `import { createMeshBuilder } from '@forgeax/engine/geometry';
import { model, sel } from '@forgeax/engine/modeling';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import produced from '../assets/prop.pack.ts';

// Benchmark evaluation only: the delivered mesh lifted into one neutral session (one
// material slot, box UVs) so validation and renders treat both conditions alike.
function withoutZeroArea(mesh) {
  const p = mesh.attributes.position instanceof Float32Array ? mesh.attributes.position : new Float32Array(mesh.attributes.position);
  const source = mesh.indices ?? Uint32Array.from({ length: p.length / 3 }, (_, i) => i);
  const kept = [];
  for (const s of mesh.submeshes ?? [{ indexOffset: 0, indexCount: source.length, topology: 'triangle-list' }]) {
    if (s.topology !== 'triangle-list') continue;
    for (let i = s.indexOffset; i + 2 < s.indexOffset + s.indexCount; i += 3) {
      const [a, b, c] = [source[i], source[i + 1], source[i + 2]];
      const u = [p[3 * b] - p[3 * a], p[3 * b + 1] - p[3 * a + 1], p[3 * b + 2] - p[3 * a + 2]];
      const v = [p[3 * c] - p[3 * a], p[3 * c + 1] - p[3 * a + 1], p[3 * c + 2] - p[3 * a + 2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (n[0] !== 0 || n[1] !== 0 || n[2] !== 0) kept.push(a, b, c);
    }
  }
  if (kept.length === source.length) return mesh;
  const f32 = (x) => (x === undefined ? undefined : x instanceof Float32Array ? x : new Float32Array(x));
  const attributes = { position: p, normal: f32(mesh.attributes.normal), uv: f32(mesh.attributes.uv) };
  for (const key of Object.keys(attributes)) if (attributes[key] === undefined) delete attributes[key];
  const rebuilt = createMeshBuilder({ attributes, indices: new Uint32Array(kept) }).build();
  if (!rebuilt.ok) throw new Error(rebuilt.error.message);
  return rebuilt.value;
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000e7a1'),
  build: async (context) => {
    const values = Object.fromEntries((produced.parameters ?? []).map((p) => [p.name, p.default]));
    const built = await produced.build({ ...context, packageId: produced.packageId, ...(produced.parameters === undefined ? {} : { values }) });
    if (!built.ok) return built;
    const m = model();
    m.lift(${view ? "withoutZeroArea(built.value['mesh/prop'])" : "built.value['mesh/prop']"});
    m.assign(sel.all(), 'surface');
    m.uv.project({ mode: 'box', scale: 0.1 });
    return m.finish({ key: 'eval', normals: { mode: 'weighted' } });
  },
});
`;
}

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|mts|js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function protocolViolations(dir, condition, run) {
  const sources = sourceFiles(join(dir, 'assets')).map((path) => readFileSync(path, 'utf8'));
  const text = sources.join('\n');
  const violations = [];
  if (condition === 'control') {
    for (const pattern of protocol.conditions.control.forbiddenPatterns) {
      if (text.includes(pattern)) violations.push(`control source contains ${pattern}`);
      if (run.bashCommands.some((command) => command.includes(pattern))) {
        violations.push(`control ran a command containing ${pattern}`);
      }
    }
  } else if (!text.includes('@forgeax/engine/modeling') || !/\bmodel\(\)/.test(text)) {
    violations.push('tools source does not build with model() from @forgeax/engine/modeling');
  }
  return [...new Set(violations)];
}

function cli(dir, argv, timeoutMs) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [forgeax, ...argv, '--json'], {
    cwd: dir,
    env: process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  const line = result.stdout.split('\n').find((candidate) => candidate.startsWith('{"ok"'));
  const seconds = (performance.now() - started) / 1000;
  if (line === undefined) {
    return {
      ok: false,
      seconds,
      error: (result.stderr || result.error?.message || '').slice(-2000),
    };
  }
  return { ...JSON.parse(line), seconds };
}

export function collectRun(dir) {
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  const brief = briefSet.briefs.find((b) => b.id === run.brief);
  const briefPath = join(dir, '.bench/brief.source.json');
  writeFileSync(briefPath, JSON.stringify(brief));
  const measured = spawnSync(
    process.execPath,
    [join(here, 'measure.mjs'), join(dir, 'assets/prop.pack.ts'), briefPath],
    { cwd: dir, encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 },
  );
  let measure;
  try {
    measure = JSON.parse(measured.stdout);
  } catch {
    measure = { build: { ok: false, error: `measure failed: ${measured.stderr.slice(-1000)}` } };
  }
  const violations = protocolViolations(dir, run.condition, run);
  let validate = null;
  let render = null;
  if (measure.build.ok) {
    writeFileSync(join(dir, '.bench/eval.pack.ts'), wrapperPack(false));
    writeFileSync(join(dir, '.bench/view.pack.ts'), wrapperPack(true));
    const v = cli(dir, ['model', 'validate', '--source', '.bench/eval.pack.ts'], 900_000);
    const session = v.value?.sessions?.find((s) => s.output === 'mesh/eval');
    validate = {
      ok: v.ok === true,
      seconds: v.seconds,
      status: session?.status ?? 'fail',
      buildError: v.value?.build?.error ?? (v.ok ? null : (v.error ?? null)),
      mesh: session?.mesh ?? null,
      issues: (session?.issues ?? []).reduce((counts, issue) => {
        const key = `${issue.code}:${issue.certainty}`;
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {}),
    };
    const inspect = cli(dir, ['model', 'inspect', '--source', '.bench/view.pack.ts'], 900_000);
    const viewSession = inspect.value?.sessions?.find((s) => s.output === 'mesh/eval');
    const r = cli(
      dir,
      [
        'model',
        'render',
        '--source',
        '.bench/view.pack.ts',
        '--annotate',
        'false',
        ...(viewSession === undefined ? [] : ['--session', String(viewSession.index)]),
      ],
      900_000,
    );
    if (r.ok === true) {
      const out = join(dir, '.bench/render');
      mkdirSync(out, { recursive: true });
      copyFileSync(join(dir, r.value.sheet.image), join(out, 'sheet.png'));
      const iso = r.value.views.find((view) => view.view === 'iso');
      if (iso !== undefined) copyFileSync(join(dir, iso.image), join(out, 'iso.png'));
      render = {
        ok: true,
        seconds: r.seconds,
        sheet: join(out, 'sheet.png'),
        iso: iso === undefined ? null : join(out, 'iso.png'),
        mesh: r.value.mesh,
      };
    } else {
      render = { ok: false, seconds: r.seconds, error: r.error ?? r.value ?? null };
    }
  }
  const completed =
    measure.build.ok &&
    measure.closedValid === true &&
    measure.checksPass === true &&
    validate !== null &&
    validate.status !== 'fail' &&
    violations.length === 0;
  const record = {
    schema: 'forgeax.ai-benchmark.collect/1',
    brief: run.brief,
    condition: run.condition,
    completed,
    measure,
    validate,
    render,
    violations,
  };
  writeFileSync(join(dir, 'collect.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

if (process.argv[1] === import.meta.filename) {
  const wanted = args.runs?.split(',');
  for (const name of readdirSync(args.root).sort()) {
    const dir = join(args.root, name);
    if (!existsSync(join(dir, 'run.json'))) continue;
    if (wanted !== undefined && !wanted.includes(name)) continue;
    const record = collectRun(dir);
    console.log(
      `${name}: completed=${record.completed} build=${record.measure.build.ok} closedValid=${record.measure.closedValid} checks=${record.measure.checksPass} validate=${record.validate?.status} render=${record.render?.ok} violations=${record.violations.length}`,
    );
  }
}

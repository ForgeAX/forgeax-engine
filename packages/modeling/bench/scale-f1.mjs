// F1-scale measurement (K5-6, AS-10-T2): builds a many-part assembly with the public
// modeling API, exports it and generates LODs, and reports face and triangle counts, phase
// times and memory. A measurement, not a threshold: it fails only on an error.
//
//   npx tsup && node bench/scale-f1.mjs [--fixture tiny|f1] [--parts N] [--radial N]
//     [--height-segments N] [--target-triangles N] [--out reports/scale-<date>.json]
//
// Needs a built `dist` (the script imports the package as a game would). Run it under
// `forgeax-heavy` on the shared pub server; add `--expose-gc` to sample heap after a GC.
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Part counts and per-part density: f1 is >= 400 parts at 0.5-1 M triangles (AS-10-T2). */
export const FIXTURES = {
  tiny: { parts: 6, radial: 8, heightSegments: 2 },
  f1: { parts: 400, radial: 40, heightSegments: 16 },
};

/** The F1 triangle budget the measured run is extrapolated to (middle of 0.5-1 M). */
export const F1_TARGET_TRIANGLES = 750_000;

const LODS = {
  maxError: 0.004,
  levels: [
    { triangleRatio: 0.5, screenCoverage: 0.5 },
    { triangleRatio: 0.25, screenCoverage: 0.2, maxError: 0.015 },
  ],
};

const round = (x, digits = 1) => Math.round(x * 10 ** digits) / 10 ** digits;
const mb = (bytes) => round(bytes / 1048576);

/** One part: a bevelled cylinder with box-projected UVs, so every part adds a few thousand faces. */
function prototype(model, sel, { radial, heightSegments }) {
  const m = model();
  m.cylinder({
    radiusTop: 0.4,
    radiusBottom: 0.5,
    height: 1,
    radialSegments: radial,
    heightSegments,
  });
  m.bevel(sel.facing('+y').boundary(), { width: 0.04, segments: 2 });
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}

/** Samples the process high-water marks; heap is read at phase boundaries only. */
function memorySampler() {
  let peakHeap = 0;
  return {
    sample() {
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    },
    summary: () => ({
      peakRssMb: mb(process.resourceUsage().maxRSS * 1024),
      peakHeapUsedMb: mb(peakHeap),
    }),
  };
}

/**
 * Runs the fixture through build, export and LOD generation.
 * `deps`: `{ model, sel, lodTopologyReport, generateMeshLods, deriveGuid }` (the dist exports
 * in the CLI, the source modules in the unit test).
 */
export async function runScale(deps, fixture, targetTriangles = F1_TARGET_TRIANGLES) {
  const { model, sel, lodTopologyReport, generateMeshLods, deriveGuid } = deps;
  const memory = memorySampler();
  const phase = async (fn) => {
    memory.sample();
    const started = performance.now();
    const value = await fn();
    const ms = performance.now() - started;
    memory.sample();
    return { value, ms };
  };

  const built = await phase(() => {
    const part = prototype(model, sel, fixture);
    const assembly = model();
    const columns = Math.ceil(Math.sqrt(fixture.parts));
    for (let i = 0; i < fixture.parts; i++) {
      const at = [(i % columns) * 1.5, 0, Math.floor(i / columns) * 1.5];
      const r = assembly.append(part, { translate: at, label: `part:${i}` });
      if (r.error !== undefined) throw new Error(`append part ${i}: ${r.error.message}`);
    }
    return assembly;
  });
  const assembly = built.value;

  const exported = await phase(() => {
    const out = assembly.toMesh({ normals: { mode: 'autoSmooth', angle: 40 } });
    if (!out.ok) throw new Error(`export: ${out.error.message}`);
    return out.value;
  });
  const { mesh, report } = exported.value;

  const lods = await phase(async () => {
    const out = await generateMeshLods(mesh, {
      ...LODS,
      levels: LODS.levels.map((level, k) => ({ ...level, mesh: deriveGuid(`scale-f1/lod/${k}`) })),
    });
    if (!out.ok) throw new Error(`lod: ${JSON.stringify(out.error)}`);
    return out.value;
  });

  const topology = await phase(() => lodTopologyReport([mesh, ...lods.value.meshes]));
  memory.sample();

  const triangles = report.triangles;
  const factor = round(targetTriangles / triangles, 3);
  const phasesMs = {
    build: round(built.ms),
    export: round(exported.ms),
    lod: round(lods.ms),
    lodTopology: round(topology.ms),
  };
  const lodTriangles = lods.value.reports.map((r) => r.triangleCount);
  return {
    fixture,
    host: {
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      node: process.version,
      loadAverage: round(loadavg()[0] ?? 0, 2),
    },
    parts: fixture.parts,
    faces: assembly.editMesh.faceCount,
    triangles,
    gpuVertices: report.gpuVertices,
    lodTriangles: [triangles, ...lodTriangles],
    lodTopology: topology.value,
    phasesMs,
    totalMs: round(Object.values(phasesMs).reduce((a, b) => a + b, 0)),
    memory: { ...memory.summary(), gcExposed: typeof globalThis.gc === 'function' },
    extrapolation: {
      model: 'linear in triangle count, an assumption: super-linear phases make it a lower bound',
      targetTriangles,
      factor,
      phasesMs: Object.fromEntries(
        Object.entries(phasesMs).map(([k, v]) => [k, round(v * factor)]),
      ),
    },
  };
}

function option(argv, name) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const modeling = await import(pathToFileURL(resolve(root, 'dist/index.mjs')).href);
  const { generateMeshLods } = await import('@forgeax/engine-import/mesh-lod-generator');
  const { AssetGuid, definePackageId } = await import('@forgeax/engine-pack/source');
  const packageId = definePackageId('01900000-0000-7000-8000-0000000c1056');

  const named = FIXTURES[option(argv, 'fixture') ?? 'f1'];
  if (named === undefined)
    throw new Error(`--fixture is one of ${Object.keys(FIXTURES).join(', ')}`);
  const number = (name, fallback) => {
    const raw = option(argv, name);
    return raw === undefined ? fallback : Number(raw);
  };
  const fixture = {
    parts: number('parts', named.parts),
    radial: number('radial', named.radial),
    heightSegments: number('height-segments', named.heightSegments),
  };
  const result = await runScale(
    {
      model: modeling.model,
      sel: modeling.sel,
      lodTopologyReport: modeling.lodTopologyReport,
      generateMeshLods,
      deriveGuid: (name) => AssetGuid.derive(packageId, name),
    },
    fixture,
    number('target-triangles', F1_TARGET_TRIANGLES),
  );
  const date = new Date().toISOString().slice(0, 10);
  const out = resolve(root, option(argv, 'out') ?? `reports/scale-${date}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\nwrote ${out}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  });
}

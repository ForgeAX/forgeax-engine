// Fixed asset bench: builds a roster of existing examples, measures each exported output with
// assetStats, checks it against one output profile and writes a JSON baseline. The roster and profiles are
// the contract; a previous baseline is diffed in the printed table.
//
// usage:
//   node scripts/asset-bench/run.ts [--out <file.json>] [--compare <previous.json>]
// Requires the built package (`pnpm --filter @forgeax/engine-modeling build`); the bench script in
// package.json runs the build first. Default output: scripts/asset-bench/baselines/results.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..', '..');
const EXAMPLES = join(PKG, 'examples');
const DEFAULT_OUT = join(HERE, 'baselines', 'results.json');
/** Builds slower than this are skipped, per the bench contract. */
const MAX_BUILD_MS = 60_000;

type Builder = () => unknown;

interface RosterEntry {
  readonly id: string;
  readonly profile: 'mobile-hero' | 'mobile-prop' | 'mobile-scenery';
  readonly rationale: string;
  readonly file: string;
  readonly build: string;
  /** How to pick the mesh-bearing models out of the builder result. */
  readonly parts: 'model' | 'armor';
}

const ROSTER: readonly RosterEntry[] = [
  {
    id: 'crate',
    profile: 'mobile-prop',
    rationale: 'a single rigid prop with bevel-free panels',
    file: 'crate/crate.ts',
    build: 'buildCrate',
    parts: 'model',
  },
  {
    id: 'desk-lamp',
    profile: 'mobile-prop',
    rationale: 'multi-part household prop',
    file: 'desk-lamp/lamp.ts',
    build: 'buildLamp',
    parts: 'model',
  },
  {
    id: 'wheel-rim',
    profile: 'mobile-hero',
    rationale: 'close-up mechanical hero part',
    file: 'wheel-rim/wheel-rim.ts',
    build: 'buildWheelRim',
    parts: 'model',
  },
  {
    id: 'bracket',
    profile: 'mobile-prop',
    rationale: 'small machined bracket',
    file: 'bracket/bracket.ts',
    build: 'buildBracket',
    parts: 'model',
  },
  {
    id: 'armor-bake',
    profile: 'mobile-hero',
    rationale: 'two-part armor plate pair used for baking',
    file: 'armor-bake/armor.ts',
    build: 'buildArmorParts',
    parts: 'armor',
  },
  {
    id: 'pauldron',
    profile: 'mobile-hero',
    rationale: 'shoulder armor hero asset',
    file: 'pauldron/pauldron.ts',
    build: 'buildPauldron',
    parts: 'model',
  },
  {
    id: 'hair-fork',
    profile: 'mobile-prop',
    rationale: 'thin forked hair part',
    file: 'hair-fork/body.ts',
    build: 'buildHairFork',
    parts: 'model',
  },
  {
    id: 'housing',
    profile: 'mobile-prop',
    rationale: 'enclosure with openings',
    file: 'housing/housing.ts',
    build: 'buildHousing',
    parts: 'model',
  },
  {
    id: 'tunic',
    profile: 'mobile-scenery',
    rationale: 'soft cloth shape that tiles',
    file: 'tunic/tunic.ts',
    build: 'buildTunic',
    parts: 'model',
  },
  {
    id: 'sheet-bracket',
    profile: 'mobile-prop',
    rationale: 'sheet-metal bracket',
    file: 'sheet-bracket/body.ts',
    build: 'buildSheetBracket',
    parts: 'model',
  },
];

/** Roster entries skipped without being built, with the reason recorded in the output. */
const SKIPPED_STATIC: readonly { readonly id: string; readonly reason: string }[] = [
  {
    id: 'thin-vent',
    reason: 'not an asset: the builder returns a 2-triangle backing plus a hole plan',
  },
  {
    id: 'plate',
    reason: 'roster cap: 10 entries (6 required + 4 extra); built in about 25 ms when probed',
  },
  {
    id: 'joint-boot',
    reason: 'roster cap: built in about 7.8 s when probed (within the 60 s limit)',
  },
  { id: 'hood-linkage', reason: 'roster cap: built in about 0.4 s when probed' },
  { id: 'door-hinge', reason: 'roster cap: built in about 0.3 s when probed' },
  { id: 'hydraulic-joint', reason: 'roster cap: built in about 0.3 s when probed (35k triangles)' },
];

interface AssetRecord {
  readonly id: string;
  readonly profile: string;
  readonly rationale: string;
  readonly buildMs: number;
  readonly stats?: Record<string, number>;
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly failure?: string;
}

function usage(): never {
  process.stderr.write(
    'usage: node scripts/asset-bench/run.ts [--out <file.json>] [--compare <previous.json>]\n',
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): { out: string; compare?: string } {
  let out = DEFAULT_OUT;
  let compare: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      const v = argv[++i];
      if (v === undefined) usage();
      out = resolve(v);
    } else if (arg === '--compare') {
      const v = argv[++i];
      if (v === undefined) usage();
      compare = resolve(v);
    } else {
      usage();
    }
  }
  return compare === undefined ? { out } : { out, compare };
}

async function loadKernel(): Promise<{
  assetStats: (parts: unknown[]) => { ok: boolean; value?: unknown; error?: { message: string } };
  checkAssetBudget: (
    stats: unknown,
    profile: string,
  ) => { ok: boolean; issues: { code: string }[] };
}> {
  const entry = pathToFileURL(join(PKG, 'dist', 'index.mjs')).href;
  if (!existsSync(join(PKG, 'dist', 'index.mjs'))) {
    throw new Error('dist/index.mjs is missing: build the package before the asset bench');
  }
  return (await import(entry)) as never;
}

function partsOf(
  result: unknown,
  kind: RosterEntry['parts'],
  id: string,
): { id: string; model: { toMesh: (o: unknown) => unknown } }[] {
  const r = result as Record<string, unknown>;
  if (kind === 'model') return [{ id, model: r as never }];
  if (kind === 'armor') {
    return [
      { id: `${id}/base`, model: r.base as never },
      { id: `${id}/detail`, model: r.detail as never },
    ];
  }
  throw new Error(`unknown parts kind ${kind}`);
}

async function measure(
  entry: RosterEntry,
  kernel: Awaited<ReturnType<typeof loadKernel>>,
): Promise<AssetRecord> {
  const started = performance.now();
  const base = { id: entry.id, profile: entry.profile, rationale: entry.rationale };
  let built: unknown;
  try {
    const mod = (await import(pathToFileURL(join(EXAMPLES, entry.file)).href)) as Record<
      string,
      Builder
    >;
    const builder = mod[entry.build];
    if (builder === undefined) throw new Error(`export ${entry.build} not found in ${entry.file}`);
    built = builder();
  } catch (e) {
    return {
      ...base,
      buildMs: Math.round(performance.now() - started),
      ok: false,
      issues: [],
      failure: `build threw: ${(e as Error).message}`,
    };
  }
  const buildMs = Math.round(performance.now() - started);
  if (buildMs > MAX_BUILD_MS) {
    return {
      ...base,
      buildMs,
      ok: false,
      issues: [],
      failure: `build exceeded ${MAX_BUILD_MS} ms`,
    };
  }
  const parts: { id: string; mesh: unknown }[] = [];
  for (const p of partsOf(built, entry.parts, entry.id)) {
    const exported = p.model.toMesh({ normals: { mode: 'smooth' } }) as
      | { ok: true; value: { mesh: unknown } }
      | { ok: false; error: { code: string } };
    if (!exported.ok) {
      return {
        ...base,
        buildMs,
        ok: false,
        issues: [],
        failure: `toMesh ${p.id}: ${exported.error.code}`,
      };
    }
    parts.push({ id: p.id, mesh: exported.value.mesh });
  }
  const stats = kernel.assetStats(parts);
  if (!stats.ok || stats.value === undefined) {
    return {
      ...base,
      buildMs,
      ok: false,
      issues: [],
      failure: `assetStats: ${stats.error?.message ?? 'unknown'}`,
    };
  }
  const verdict = kernel.checkAssetBudget(stats.value, entry.profile);
  return {
    ...base,
    buildMs,
    stats: stats.value as Record<string, number>,
    ok: verdict.ok,
    issues: verdict.issues.map((i) => i.code),
  };
}

function num(v: number | undefined): string {
  return v === undefined ? '-' : Number.isInteger(v) ? String(v) : v.toFixed(3);
}

function printTable(
  records: readonly AssetRecord[],
  previous: Record<string, AssetRecord> | undefined,
): void {
  const head = [
    'id',
    'profile',
    'tri',
    'verts',
    'parts',
    'mats',
    'uvCov',
    'uvOver',
    'uvOut',
    'texelSpread',
    'raw B',
    'quant B',
    'build ms',
    'verdict',
  ];
  const rows = records.map((r) => {
    const s = r.stats ?? {};
    const delta = previous?.[r.id]?.stats?.triangles;
    const tri =
      num(s.triangles) +
      (delta !== undefined && s.triangles !== undefined
        ? ` (${s.triangles - delta >= 0 ? '+' : ''}${s.triangles - delta})`
        : '');
    const verdict =
      r.failure !== undefined ? `FAIL ${r.failure}` : r.ok ? 'pass' : `fail ${r.issues.join(',')}`;
    return [
      r.id,
      r.profile,
      tri,
      num(s.vertices),
      num(s.parts),
      num(s.materials),
      num(s.uvCoverage),
      num(s.uvOverlap),
      num(s.uvOutOfRange),
      num(s.texelSpread),
      num(s.rawBytes),
      num(s.quantizedBytes),
      String(r.buildMs),
      verdict,
    ];
  });
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: readonly string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  process.stdout.write(`${line(head)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const kernel = await loadKernel();
  const records: AssetRecord[] = [];
  for (const entry of ROSTER) {
    records.push(await measure(entry, kernel));
  }
  let previous: Record<string, AssetRecord> | undefined;
  if (args.compare !== undefined) {
    const prev = JSON.parse(readFileSync(args.compare, 'utf8')) as { assets: AssetRecord[] };
    previous = Object.fromEntries(prev.assets.map((a) => [a.id, a]));
  }
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as { version: string };
  const out = {
    kernel: pkg.version,
    generatedAt: new Date().toISOString(),
    profiles: ['mobile-hero', 'mobile-prop', 'mobile-scenery', 'desktop-hero'],
    assets: records,
    skipped: SKIPPED_STATIC,
  };
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(out, null, 2)}\n`);
  printTable(records, previous);
  if (previous !== undefined) {
    const changed = records
      .filter(
        (r) =>
          previous?.[r.id] && JSON.stringify(previous[r.id]?.stats) !== JSON.stringify(r.stats),
      )
      .map((r) => r.id);
    process.stdout.write(
      `\ncompared with ${args.compare}: ${changed.length === 0 ? 'no stat changes' : `changed: ${changed.join(', ')}`}\n`,
    );
  }
  process.stdout.write(
    `\nwrote ${args.out}\nskipped: ${SKIPPED_STATIC.map((s) => `${s.id} (${s.reason})`).join('; ')}\n`,
  );
}

await main();

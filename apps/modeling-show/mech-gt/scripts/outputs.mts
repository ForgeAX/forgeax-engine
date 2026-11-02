import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { createMeshJobCooker } from '@forgeax/engine/modeling';
import { S6_JOBS } from '../../../../packages/modeling/examples/mech-gt/s6-job.ts';
import { S7_JOB } from '../../../../packages/modeling/examples/mech-gt/s7-job.ts';

/**
 * Built outputs of the mech-gt sibling Packs for the Dawn recorder, with their
 * `modeling-mesh-job` cook sources cooked in-process (the same cooker the build root
 * registers). Each Pack's outputs are cached in `.cache/` under a key of the modeling
 * source (HEAD plus working-tree diff) and the Pack file, so a change re-cooks only the
 * Packs it touches.
 *
 *   node scripts/outputs.mts <pack file>...   # prepare (run Packs in parallel processes)
 */
const ASSETS = resolve(import.meta.dirname, '../assets');
const CACHE = resolve(import.meta.dirname, '../.cache');
const MODELING = resolve(import.meta.dirname, '../../../../packages/modeling');

export type Outputs = Readonly<Record<string, { readonly kind: string }>>;

/** Sibling Pack files the program can load (everything but the Show's own Pack). */
export function packFiles(): string[] {
  return readdirSync(ASSETS).filter((f) => f.endsWith('.pack.ts') && f !== 'show.pack.ts');
}

let modelingKey: string | undefined;
function cacheKey(file: string): string {
  modelingKey ??= createHash('sha256')
    .update(execFileSync('git', ['-C', MODELING, 'rev-parse', 'HEAD']))
    .update(execFileSync('git', ['-C', MODELING, 'diff', 'HEAD'], { maxBuffer: 1 << 30 }))
    .digest('hex');
  return createHash('sha256').update(modelingKey).update(readFileSync(resolve(ASSETS, file))).digest('hex').slice(0, 16);
}

const cooker = createMeshJobCooker([S7_JOB, ...S6_JOBS]);

/** The Pack's outputs, cooked; from the cache when its key matches. */
export async function packOutputs(file: string): Promise<{ readonly packageId: Uint8Array; readonly outputs: Outputs }> {
  const pack = (await import(resolve(ASSETS, file))).default;
  const cached = resolve(CACHE, `${basename(file, '.pack.ts')}-${cacheKey(file)}.bin`);
  if (existsSync(cached)) return { packageId: pack.packageId, outputs: deserialize(readFileSync(cached)) };
  const values = Object.fromEntries((pack.parameters ?? []).map((p: { name: string; default: unknown }) => [p.name, p.default]));
  const built = await pack.build({ packageId: pack.packageId, values });
  if (!built.ok) throw built.error;
  const outputs: Record<string, { kind: string }> = {};
  const { AssetGuid } = await import('@forgeax/engine/pack/guid');
  for (const [key, value] of Object.entries(built.value as Record<string, { kind: string; execution?: string; source?: unknown }>)) {
    if (value.execution === 'cooked' && value.kind === cooker.key) {
      const guid = AssetGuid.format(AssetGuid.derive(pack.packageId, key));
      outputs[key] = (await cooker.cook({ guid, source: value.source } as never)).payload as { kind: string };
    } else outputs[key] = value;
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, serialize(outputs));
  return { packageId: pack.packageId, outputs };
}

if (process.argv[1] === import.meta.filename) {
  for (const file of process.argv.slice(2)) {
    const started = performance.now();
    const { outputs } = await packOutputs(basename(file));
    console.log(`${basename(file)}: ${Object.keys(outputs).length} outputs, ${((performance.now() - started) / 1000).toFixed(0)} s`);
  }
}

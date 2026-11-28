import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// usage: node scripts/mutation/run.ts <set.json | set-name> [mutation-id ...] [--out <result.json>]
// A bare name (no path, no .json) resolves to scripts/mutation/sets/<name>.json; no argument lists the sets.
// A set is { tests: string[], mutations: { id, file, old, new }[] }. Each mutation replaces the one
// occurrence of `old` in `file` (repo-relative), runs `tests` with vitest, and restores the file.
// A mutation is KILLED when a test fails, SURVIVED when all pass, SKIPPED when `old` is not found
// exactly once (the source moved on: re-derive the mutation). Exit 1 if any mutation is SKIPPED or
// SURVIVED without a `survives` reason in the set.
interface Mutation {
  readonly id: string;
  readonly file: string;
  readonly old: string;
  readonly new: string;
  readonly survives?: string;
}
interface MutationSet {
  readonly tests: readonly string[];
  readonly mutations: readonly Mutation[];
}
type Verdict = 'KILLED' | 'SURVIVED' | 'SKIPPED' | 'ERROR';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? (args.splice(outAt, 2)[1] as string) : undefined;
const [setArg, ...only] = args;
const setsDir = join(root, 'scripts/mutation/sets');
if (setArg === undefined) {
  const names = readdirSync(setsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length));
  console.error(`usage: node scripts/mutation/run.ts <set-name | set.json> [mutation-id ...] [--out <file>]`);
  console.error(`sets: ${names.join(' ')}`);
  process.exit(2);
}
const setFile =
  setArg.endsWith('.json') || setArg.includes('/') ? resolve(setArg) : join(setsDir, `${setArg}.json`);
if (!existsSync(setFile)) {
  console.error(`no mutation set at ${setFile}`);
  process.exit(2);
}
const set = JSON.parse(readFileSync(setFile, 'utf8')) as MutationSet;

function findBin(name: string): string {
  for (let dir = root; dir !== dirname(dir); dir = dirname(dir)) {
    const bin = join(dir, 'node_modules/.bin', name);
    if (existsSync(bin)) return bin;
  }
  throw new Error(`node_modules/.bin/${name} not found above ${root}`);
}
const vitest = findBin('vitest');
const heavy = join(homedir(), '.local/bin/forgeax-heavy');
const prefix = existsSync(heavy) ? [heavy, '--low'] : [];

const results: Record<string, { verdict: Verdict; summary: string; failed: string[] }> = {};
const originals = new Map<string, string>();
const restore = () => {
  for (const [file, text] of originals) writeFileSync(file, text);
  originals.clear();
};
process.on('SIGINT', () => {
  restore();
  process.exit(130);
});
process.on('SIGTERM', () => {
  restore();
  process.exit(143);
});

for (const m of set.mutations) {
  if (only.length > 0 && !only.includes(m.id)) continue;
  const file = join(root, m.file);
  const text = readFileSync(file, 'utf8');
  const hits = text.split(m.old).length - 1;
  let entry: (typeof results)[string];
  if (hits !== 1) {
    entry = { verdict: 'SKIPPED', summary: `old text matched ${hits}x`, failed: [] };
  } else {
    originals.set(file, text);
    writeFileSync(file, text.replace(m.old, () => m.new));
    try {
      const cmd = [
        ...prefix,
        vitest,
        'run',
        ...set.tests,
        '--maxWorkers=8',
        '--typecheck.enabled=false',
      ];
      const run = spawnSync(cmd[0] as string, cmd.slice(1), {
        cwd: root,
        encoding: 'utf8',
        timeout: 220_000,
        maxBuffer: 256 * 1024 * 1024,
      });
      const log = `${run.stdout}${run.stderr}`;
      const summary = /Tests\s+(.*)/.exec(log)?.[1] ?? '';
      const failed = [...log.matchAll(/^\s+(?:×|FAIL)\s+(.*)$/gm)].map((f) => (f[1] as string).slice(0, 110));
      const verdict: Verdict =
        run.error !== undefined || summary === '' || /no tests/i.test(summary)
          ? 'ERROR'
          : run.status === 0
            ? 'SURVIVED'
            : 'KILLED';
      entry = { verdict, summary: summary || log.slice(-300), failed: failed.slice(0, 8) };
    } finally {
      restore();
    }
  }
  results[m.id] = entry;
  console.log(m.id, entry.verdict, entry.summary);
}

const count = (v: Verdict) => Object.values(results).filter((r) => r.verdict === v).length;
const unexplained = set.mutations.filter((m) => {
  const r = results[m.id];
  return r !== undefined && (r.verdict !== 'KILLED' && !(r.verdict === 'SURVIVED' && m.survives));
});
console.log(
  `killed ${count('KILLED')}, survived ${count('SURVIVED')}, skipped ${count('SKIPPED')}, error ${count('ERROR')}`,
);
if (out !== undefined) writeFileSync(out, `${JSON.stringify(results, null, 1)}\n`);
for (const m of unexplained) console.error(`unexplained: ${m.id} ${results[m.id]?.verdict}`);
process.exit(unexplained.length > 0 ? 1 : 0);

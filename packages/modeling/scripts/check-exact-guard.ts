import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  brepClosure,
  brepViolations,
  closureViolations,
  DIGEST_FILE,
  diffVerdict,
  kernelClosure,
  recordedClosure,
  rel,
  SRC,
} from '../src/__tests__/digest-guard.ts';

// usage: node scripts/check-exact-guard.ts [--base <rev>] [--exact]
// Exit 1 when the TS kernel closure reaches brep/ or model.ts, hides an import from the digest
// walk, when the exact-stage closure (brep/index.ts) imports model.ts, or when an exact-stage PR (touches src/brep/, or --exact) changes the closure or the digest.
const args = process.argv.slice(2);
const flag = (name: string) => args.indexOf(name);
const base = flag('--base') >= 0 ? (args[flag('--base') + 1] as string) : 'origin/main';
const declared = flag('--exact') >= 0;

const root = join(SRC, '..');
const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });

const closure = kernelClosure();
const failures: string[] = [];
for (const v of closureViolations(closure)) failures.push(`${v.rule}: ${v.file} ${v.detail}`);
for (const v of brepViolations(brepClosure())) failures.push(`brep ${v.rule}: ${v.file} ${v.detail}`);

const names = new Set([...closure.keys()].map(rel));
for (const name of recordedClosure(readFileSync(DIGEST_FILE, 'utf8'))) names.add(name);
const baseDigest = git('show', `${base}:src/compute/kernel-digest.ts`);
for (const name of recordedClosure(baseDigest)) names.add(name);

const prefix = git('rev-parse', '--show-prefix').trim();
const changed = git('diff', '--name-only', `${base}...HEAD`, '--', '.')
  .split('\n')
  .filter(Boolean)
  .map((file) => (prefix !== '' && file.startsWith(prefix) ? file.slice(prefix.length) : file));
const verdict = diffVerdict(changed, names, declared);
for (const file of verdict.touched) {
  failures.push(`exact-stage PR changes the TS kernel closure: ${file}`);
}

const mode = verdict.exactStage ? 'exact-stage PR' : 'digest-changing or unrelated PR';
if (failures.length > 0) {
  console.error(`exact guard RED (${mode}, base ${base})\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `exact guard green (${mode}, base ${base}): closure ${closure.size} files, ${changed.length} changed`,
);

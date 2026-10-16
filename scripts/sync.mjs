#!/usr/bin/env node
// Dual-lockfile sync entry — runs `pnpm install` then `bun install` in sequence
// (default Bun install is non-frozen). Exits with max(both exit codes). CI does NOT
// call this; CI uses `--frozen-lockfile`. See plan-strategy §K-5 / §3 R-5 + research §F-8.
//
// Note: Bun 1.3+ no longer accepts `--frozen-lockfile=false` (the flag has no value form);
// plain `bun install` is non-frozen and updates `bun.lock` as needed.
//
// Constraints: ≤ 50 LOC; no npm dependencies (only `node:child_process` + `node:process`).
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const run = (cmd, args) => {
  process.stdout.write(`\n› ${cmd} ${args.join(' ')}\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (r.error) {
    process.stderr.write(`failed to spawn ${cmd}: ${r.error.message}\n`);
    return 127;
  }
  return r.status ?? 1;
};

const pnpmCode = run('pnpm', ['install']);
if (pnpmCode !== 0) {
  process.stderr.write('\n[sync] pnpm install failed; aborting before bun install.\n');
  process.exit(pnpmCode);
}
const bunCode = run('bun', ['install']);
const finalCode = Math.max(pnpmCode, bunCode);
process.stdout.write(`\n[sync] done (pnpm=${pnpmCode}, bun=${bunCode}, exit=${finalCode}).\n`);
process.exit(finalCode);

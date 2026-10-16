#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const smoke = resolve(here, 'smoke.mjs');
const frames = process.env.SMOKE_MIN_FRAMES ?? '60';

function run(profile) {
  const result = spawnSync(process.execPath, [smoke], {
    cwd: resolve(here, '..'),
    env: { ...process.env, CSM_MVD_PROFILE: profile, CSM_MVD_SCENE: 'near', SMOKE_MIN_FRAMES: frames },
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    process.stderr.write(output);
    process.exit(result.status ?? 1);
  }
  const match = output.match(/pixel RGBA sha256=([0-9a-f]+)/);
  if (match?.[1] === undefined) {
    throw new Error(`missing Dawn pixel hash for ${profile}`);
  }
  return { profile, hash: match[1] };
}

const pcf3 = run('pcf3');
const pcf5 = run('pcf5');
if (pcf3.hash === pcf5.hash) {
  throw new Error(`Dawn composed WGSL regression: ${pcf3.profile} and ${pcf5.profile} produced the same hash ${pcf3.hash}`);
}
console.log(JSON.stringify({ backend: 'webgpu', frames: Number(frames), pcf3, pcf5, distinct: true }));

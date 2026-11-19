import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreCoreCompiler } from './restore-core-shader-inputs.mjs';

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const coreId = argument('--core-artifact-id');
const pointId = argument('--point-artifact-id');
if (!/^[1-9]\d*$/.test(coreId ?? '') || !/^[1-9]\d*$/.test(pointId ?? ''))
  throw new Error('exact core and point artifact IDs required');
// The SDK clean removes package dist and shared-build-inputs, not this download.
const staging = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'forgeax-sdk-shaders-'));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
for (const [id, name] of [
  [coreId, 'core'],
  [pointId, 'point'],
]) {
  const destination = join(staging, name);
  mkdirSync(destination);
  execFileSync(
    process.execPath,
    ['scripts/ci/download-artifact-with-retry.mjs', '--artifact-ids', id, '--path', destination],
    { stdio: 'inherit', env: { ...process.env, FORGEAX_ARTIFACT_EXPECTED_SHA: sha } },
  );
}
execFileSync(
  process.execPath,
  [
    'scripts/ci/unpack-shared-app-inputs.mjs',
    '--root',
    join(staging, 'point'),
    '--archive',
    'shared-app-inputs.tar.gz',
    '--destination',
    'shared-app-inputs',
  ],
  { stdio: 'inherit' },
);
// Keep the producer's native bytes; sdk:build still rebuilds all JS from source.
await restoreCoreCompiler(process.cwd(), join(staging, 'core'));
appendFileSync(process.env.GITHUB_ENV, `FORGEAX_SDK_SHADER_INPUTS=${staging}\n`);
console.log(`[sdk-shader-inputs] downloaded original base and point bytes for ${sha}`);

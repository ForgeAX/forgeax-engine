import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const fixturePath = fileURLToPath(
  new URL('../src/__tests__/fixtures/profile-capture/model-input.json', import.meta.url),
);
const result = spawnSync(process.execPath, [cliPath, 'summary', '--file', fixturePath], {
  encoding: 'utf8',
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} else {
  process.stdout.write(result.stdout);
}

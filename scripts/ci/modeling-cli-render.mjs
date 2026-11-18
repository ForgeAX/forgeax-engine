import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Independent CLI evidence owns one terminal process and its native GPU instance. */
export async function renderModelInCliProcess(cli, root, input) {
  const { stdout } = await execute(
    process.execPath,
    [
      cli,
      'model',
      'render',
      '--input',
      JSON.stringify(input),
      '--root',
      root,
      '--detail',
      '--json',
    ],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

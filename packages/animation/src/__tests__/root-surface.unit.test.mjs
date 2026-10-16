// @perf-budget-skip: intentional published public-root cold-import contract gate.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

// Use a fresh native consumer process: Vite transformation time is not SDK cold-start time.
// The five-second test deadline is retained; the child has a tighter four-second bound.
describe('animation graph registration stays plugin-owned', () => {
  it('does not project the plugin-internal registration helper from the public root', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const root = await import("@forgeax/engine-animation"); console.log(JSON.stringify(Object.hasOwn(root, "registerEvaluateAnimationGraph")));',
      ],
      { cwd: new URL('../../', import.meta.url), timeout: 4000 },
    );
    expect(JSON.parse(stdout)).toBe(false);
  });
});

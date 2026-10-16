import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, '..', 'scripts', 'run-capability-matrix.mjs');

describe('M0 capability matrix policy', () => {
  it('rejects browser capability without real isolation headers', () => {
    const output = execFileSync(process.execPath, [runner, '--self-test'], { encoding: 'utf8' });
    expect(output).toContain('missing-header fixture rejected');
  });
});

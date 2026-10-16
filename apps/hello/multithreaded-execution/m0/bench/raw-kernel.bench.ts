import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, '..', 'scripts', 'run-raw-kernel.mjs');

describe('M0 raw kernel benchmark policy', () => {
  it('uses p50 and rejects a fastest-single-sample claim', () => {
    const output = execFileSync(process.execPath, [runner, '--self-test'], { encoding: 'utf8' });
    expect(output).toContain('fastest-single outlier rejected');
  });
});

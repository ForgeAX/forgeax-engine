import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const inventoryScript = 'scripts/forgeax/render-consumer-inventory.mjs';

describe('M7 render consumer inventory', () => {
  it('reports source-bound hits for all three channels and closes at zero', () => {
    const output = execFileSync(process.execPath, [inventoryScript, '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const report = JSON.parse(output);

    expect(report.channels).toEqual(['ts', 'executable', 'config']);
    expect(report.hits).toEqual([]);
    expect(report.summary.total).toBe(0);
    expect(report.baseline).toBeDefined();
    expect(report.baseline.sourceSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

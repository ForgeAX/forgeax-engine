import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const requiredKinds = ['bundle-size', 'fps', 'bench', 'gate', 'spike-report'];

function validMetrics() {
  return Object.fromEntries(
    requiredKinds.map((kind) => [kind, { enabled: false, reason: `not applicable to ${kind}` }]),
  );
}

function fixture(metrics: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-declared-'));
  mkdirSync(join(dir, 'packages', 'demo'), { recursive: true });
  mkdirSync(join(dir, 'schemas'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(
    join(dir, 'schemas/forgeax-metrics.schema.json'),
    readFileSync(join(root, 'schemas/forgeax-metrics.schema.json')),
  );
  writeFileSync(
    join(dir, 'packages', 'demo', 'package.json'),
    JSON.stringify({ name: 'demo', forgeax: { metrics } }),
  );
  return dir;
}

describe('metrics declaration gate', () => {
  it('requires the closed five-kind registry on every workspace member', () => {
    const packageFiles = execFileSync(
      'find',
      ['packages', 'apps', 'templates', '-name', 'package.json', '-print'],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const file of packageFiles) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      const metrics = pkg.forgeax?.metrics;
      if (!metrics) continue;
      expect(Object.keys(metrics).sort()).toEqual([...requiredKinds].sort());
    }
  });

  it('passes a complete declaration and rejects a missing kind', () => {
    const good = fixture(validMetrics());
    expect(() =>
      execFileSync('node', [join(root, 'scripts/check-metrics-declared.mjs'), '--root', good], {
        encoding: 'utf8',
      }),
    ).not.toThrow();

    const incomplete = { ...validMetrics() };
    delete incomplete.gate;
    const bad = fixture(incomplete);
    expect(() =>
      execFileSync('node', [join(root, 'scripts/check-metrics-declared.mjs'), '--root', bad], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('keeps the gate vocabulary aligned with the metrics schema', () => {
    const schema = JSON.parse(
      readFileSync(join(root, 'schemas/forgeax-metrics.schema.json'), 'utf8'),
    );
    const script = readFileSync(join(root, 'scripts/check-metrics-declared.mjs'), 'utf8');
    const schemaKinds = schema.required;
    expect(schemaKinds).toEqual(expect.arrayContaining(requiredKinds));
    for (const kind of requiredKinds) expect(script).toContain(kind);
  });
});

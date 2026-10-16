import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDawnErrors, READINESS_FRAME_LIMIT } from '../../scripts/smoke-diagnostics.mjs';

const smokePath = resolve(import.meta.dirname, '../../scripts/smoke-dawn.mjs');

describe('Boss Lightning Dawn pixel probe contract', () => {
  it('requires separate billboard and mesh zones plus the budgeted draw probe', () => {
    const source = readFileSync(smokePath, 'utf8');
    expect(source).toContain('copyTextureToBuffer');
    expect(source).toContain('billboardZone');
    expect(source).toContain('meshZone');
    expect(source).toContain('billboard');
    expect(source).toContain('mesh');
    expect(source).toContain('queuedIntents');
    expect(source).toContain('runtimeDiagnostics');
    expect(source).toContain('billboardEnergy');
    expect(source).toContain('meshEnergy');
    expect(source).toContain('strikeOnly');
    expect(source).toContain('readiness');
    expect(source).toContain('readinessFrameLimit');
    expect(source).toContain('persistentErrors');
    expect(source).toContain('recovery');
    expect(source).toContain('process.exit(0)');
  });

  it('uses the shared default and requested budgets without changing the benchmark window', () => {
    const source = readFileSync(smokePath, 'utf8');
    const declarations = source.match(
      /^const TARGET_FRAMES = [^\n]+;\nconst frameLimit = [^\n]+;$/m,
    )?.[0];
    expect(declarations).toBeDefined();
    const helper = new URL('../../../../shared/scripts/smoke-receipt.mjs', import.meta.url).href;
    const checkBudgets = (code: string) => {
      for (const requested of [undefined, '300']) {
        for (const benchmarkMode of [false, true]) {
          const env = { ...process.env };
          delete env.SMOKE_MIN_FRAMES;
          if (requested !== undefined) env.SMOKE_MIN_FRAMES = requested;
          const output = execFileSync(process.execPath, [
            '--input-type=module',
            '--eval',
            `import { smokeFrameBudget } from ${JSON.stringify(helper)};
const benchmarkMode = ${benchmarkMode};
${code}
console.log(frameLimit);`,
          ], { env, encoding: 'utf8' });
          expect(Number(output.trim())).toBe(benchmarkMode ? 90 : Number(requested ?? 60));
        }
      }
    };
    checkBudgets(declarations!);
    const hardCoded = declarations!.replace(
      /^const TARGET_FRAMES = [^\n]+;/m,
      'const TARGET_FRAMES = 60;',
    );
    expect(hardCoded).not.toBe(declarations);
    expect(() => checkBudgets(hardCoded)).toThrow();
  });

  it('keeps the depth provider and soft-particle oracle explicit', () => {
    const source = readFileSync(smokePath, 'utf8');
    expect(source).toContain('scene-depth');
    expect(source).toContain('depthProviderReady');
    expect(source).toContain('softParticle');
    expect(source).toContain('missing-depth');
  });

  it('keeps independent advanced topology oracles in the Dawn path', () => {
    const source = readFileSync(smokePath, 'utf8');
    for (const topology of ['textureSheet', 'pivot', 'softParticle', 'sorting', 'ribbon', 'trail', 'beam']) {
      expect(source).toContain(topology);
    }
    expect(source).toContain('topologyCounters');
    expect(source).toContain('indirectDraws');
  });

  it('accepts only bounded next-frame preparation warm-up before readiness', () => {
    const { warmupErrors, persistentErrors } = classifyDawnErrors(
      [
        {
          code: 'render-feature-preparation-failed',
          detail: { stage: 'prepare', recovery: 'next-frame' },
          frame: 0,
        },
        {
          code: 'render-feature-preparation-failed',
          detail: { stage: 'prepare', recovery: 'next-frame' },
          frame: READINESS_FRAME_LIMIT + 1,
        },
      ],
      1,
    );
    expect(warmupErrors).toHaveLength(1);
    expect(persistentErrors).toHaveLength(1);
  });
});

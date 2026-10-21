/// <reference types="node" />

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../');
const REPRESENTATIVES = [
  {
    entry: 'apps/learn-render/5.advanced-lighting/1.advanced-lighting/src/index.ts',
    app: 'apps/learn-render/5.advanced-lighting/1.advanced-lighting',
    gate: 'apps/learn-render/5.advanced-lighting/1.advanced-lighting/src/__tests__/lit-pixels.browser.test.ts',
    startup: [
      "const texRes = await assets.load(woodGuidRes.value, 'texture');",
      'if (!texRes.ok)',
      'return;',
      'const woodTex = texRes.value;',
    ],
  },
  {
    entry: 'apps/learn-render/4.advanced-opengl/6.cubemaps/src/index.ts',
    app: 'apps/learn-render/4.advanced-opengl/6.cubemaps',
    gate: 'apps/learn-render/4.advanced-opengl/6.cubemaps/src/__tests__/onerror-gate.browser.test.ts',
    startup: [
      "const hdrHandleRes = await assets.load(guidRes.value, 'equirect');",
      'if (!hdrHandleRes.ok)',
      'return;',
      'const equirect = hdrHandleRes.value;',
    ],
  },
  {
    entry: 'apps/learn-render/5.advanced-lighting/9.ssao/src/main.ts',
    app: 'apps/learn-render/5.advanced-lighting/9.ssao',
    gate: 'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts',
    startup: ['spawnSsaoScene(app.world, target.width / target.height);'],
  },
] as const;

describe('representative producer-ready app smoke contract', () => {
  it('completes managed asset or procedural scene startup before running, with error and real smoke gates intact', () => {
    for (const representative of REPRESENTATIVES) {
      const source = readFileSync(resolve(ROOT, representative.entry), 'utf8');
      expect(source, representative.entry).toContain('forgeaxBundlerAdapter');
      let offset = 0;
      for (const step of representative.startup) {
        const index = source.indexOf(step, offset);
        expect(index, `${representative.entry}: ${step}`).toBeGreaterThanOrEqual(offset);
        offset = index + step.length;
      }
      expect(source.indexOf('app.start()', offset), representative.entry).toBeGreaterThanOrEqual(
        offset,
      );
      expect(source, representative.entry).toContain('__learnRenderErrors');
      expect(source, representative.entry).not.toMatch(
        /createDevImportTransport|__import|preload/i,
      );
      expect(existsSync(resolve(ROOT, representative.app, 'scripts/smoke-dawn.mjs'))).toBe(true);
      expect(existsSync(resolve(ROOT, representative.app, 'scripts/smoke-browser.mjs'))).toBe(true);
      expect(existsSync(resolve(ROOT, representative.gate))).toBe(true);
    }
  });
});

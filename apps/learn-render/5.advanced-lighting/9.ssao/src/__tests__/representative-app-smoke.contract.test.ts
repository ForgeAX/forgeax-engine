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
  },
  {
    entry: 'apps/learn-render/4.advanced-opengl/6.cubemaps/src/index.ts',
    app: 'apps/learn-render/4.advanced-opengl/6.cubemaps',
    gate: 'apps/learn-render/4.advanced-opengl/6.cubemaps/src/__tests__/onerror-gate.browser.test.ts',
  },
  {
    entry: 'apps/learn-render/5.advanced-lighting/9.ssao/src/main.ts',
    app: 'apps/learn-render/5.advanced-lighting/9.ssao',
    gate: 'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts',
  },
] as const;

describe('representative producer-ready app smoke contract', () => {
  it('keeps loadByGuid startup, error reporting, and real smoke gates intact', () => {
    for (const representative of REPRESENTATIVES) {
      const source = readFileSync(resolve(ROOT, representative.entry), 'utf8');
      expect(source, representative.entry).toContain('forgeaxBundlerAdapter');
      expect(source, representative.entry).toContain('loadByGuid');
      expect(source, representative.entry).toContain('__learnRenderErrors');
      expect(source, representative.entry).not.toMatch(
        /createDevImportTransport|importTransport\s*:|__import|preload/i,
      );
      expect(existsSync(resolve(ROOT, representative.app, 'scripts/smoke-dawn.mjs'))).toBe(true);
      expect(existsSync(resolve(ROOT, representative.app, 'scripts/smoke-browser.mjs'))).toBe(true);
      expect(existsSync(resolve(ROOT, representative.gate))).toBe(true);
    }
  });
});

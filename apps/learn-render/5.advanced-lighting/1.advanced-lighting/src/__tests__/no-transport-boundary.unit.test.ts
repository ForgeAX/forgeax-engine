/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../');
const REPRESENTATIVE_ENTRIES = [
  'apps/learn-render/5.advanced-lighting/1.advanced-lighting/src/index.ts',
  'apps/learn-render/4.advanced-opengl/6.cubemaps/src/index.ts',
  'apps/learn-render/5.advanced-lighting/9.ssao/src/main.ts',
];

describe('representative browser import transport ownership', () => {
  it('keeps transport implementation in the shared host adapter', () => {
    for (const relativePath of REPRESENTATIVE_ENTRIES) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/createDevImportTransport/);
      expect(source, relativePath).not.toMatch(/\/__import\/|fetchPack\s*[:(]/);
      if (/importTransport\s*:/.test(source)) {
        expect(source, relativePath).toMatch(
          /importTransport\s*:\s*createRuntimeAssetImportTransport\(runtimeBinding\)/,
        );
        expect(source, relativePath).toContain("from '@forgeax/apps-shared/asset-runtime-config'");
      }
    }
  });

  it('keeps the Engine explicit Host transport adapter available', () => {
    const transport = readFileSync(
      resolve(ROOT, 'packages/runtime/src/dev-import-transport.ts'),
      'utf8',
    );
    expect(transport).toContain('createDevImportTransport');
  });
});

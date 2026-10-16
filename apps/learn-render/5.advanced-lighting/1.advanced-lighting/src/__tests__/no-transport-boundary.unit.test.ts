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

describe('representative browser no-transport boundary', () => {
  it('removes import transport wiring from all three consumer entries', () => {
    for (const relativePath of REPRESENTATIVE_ENTRIES) {
      const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(source, relativePath).not.toMatch(/createDevImportTransport/);
      expect(source, relativePath).not.toMatch(/importTransport\s*:/);
      expect(source, relativePath).toContain('loadByGuid');
    }
  });

  it('keeps the explicit Studio transport implementation available', () => {
    const transport = readFileSync(
      resolve(ROOT, 'packages/runtime/src/dev-import-transport.ts'),
      'utf8',
    );
    expect(transport).toContain('createDevImportTransport');
  });
});

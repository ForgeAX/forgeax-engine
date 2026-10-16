import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('native browser plugin artifact', () => {
  it('delivers the native runtime without the retired Loader or Node module loading', async () => {
    const packageMetadata = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    );
    expect(packageMetadata.exports['./loader']).toBeUndefined();
    expect(Object.keys(packageMetadata.dependencies)).not.toContain('@deepseek-ai/cordis-plugin-loader');
    const browserLoader = await readFile(resolve(packageRoot, 'dist/index.mjs'), 'utf8');
    const executable = browserLoader.replace(/^\/\/.*$/gm, '');
    expect(executable).not.toMatch(/from ["'](?:node:)?module["']/);
    expect(executable).not.toContain('process.env.CORDIS_SHARED');
    expect(executable).not.toContain('process.versions.node');
    expect(executable).not.toContain('process.execArgv');
  });
});

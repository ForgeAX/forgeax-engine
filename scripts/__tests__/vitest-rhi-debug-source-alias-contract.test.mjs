import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const helperPath = resolve(rootDir, 'config/vitest-rhi-debug-source-alias.ts');

describe('rhi-debug source alias contract', () => {
  it('root delegates to the browser project with the exact rhi-debug source alias', async () => {
    const helper = await import(pathToFileURL(helperPath).href);
    const aliases = helper.createRhiDebugSourceAliases();
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find).toBeInstanceOf(RegExp);
    expect(aliases[0].find.test('@forgeax/engine-rhi-debug')).toBe(true);
    expect(aliases[0].find.test('@forgeax/engine-rhi-debug/internal')).toBe(false);
    expect(aliases[0].replacement).toBe(resolve(rootDir, 'packages/rhi-debug/src/index.ts'));

    const rootConfig = readFileSync(resolve(rootDir, 'vitest.config.ts'), 'utf8');
    const browserConfig = readFileSync(
      resolve(rootDir, 'config/vitest-browser-project.ts'),
      'utf8',
    );
    expect(rootConfig).toMatch(/createBrowserProject/);
    expect(browserConfig).toMatch(/createRhiDebugSourceAliases/);
  });
});

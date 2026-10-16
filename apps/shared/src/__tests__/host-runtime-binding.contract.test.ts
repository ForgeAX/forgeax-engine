import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const hosts = [
  ['preview', resolve(import.meta.dirname, '../../../preview/src/main.ts')],
  ['collectathon', resolve(import.meta.dirname, '../../../collectathon/src/main.ts')],
  [
    'learn-render-4.5-framebuffers',
    resolve(
      import.meta.dirname,
      '../../../learn-render/4.advanced-opengl/5.framebuffers/src/index.ts',
    ),
  ],
  [
    'learn-render-5.7-bloom',
    resolve(import.meta.dirname, '../../../learn-render/5.advanced-lighting/7.bloom/src/index.ts'),
  ],
] as const;

function createAppAssembly(source: string): string {
  const callStart = source.indexOf('await createApp(');
  const bundlerStart = source.indexOf('forgeaxBundlerAdapter()', callStart);
  const closingCall = source.slice(bundlerStart).match(/\n\s*\);/);
  const closingCallIndex = closingCall?.index;
  if (callStart < 0 || bundlerStart < 0 || closingCallIndex === undefined) {
    throw new Error('host runtime binding contract: createApp assembly not found');
  }
  return source.slice(callStart, bundlerStart + closingCallIndex);
}

function createAppEnd(source: string): number {
  const bundlerStart = source.indexOf('forgeaxBundlerAdapter()');
  const closingCall = source.slice(bundlerStart).match(/\n\s*\);/);
  const closingCallIndex = closingCall?.index;
  if (bundlerStart < 0 || closingCallIndex === undefined) {
    throw new Error('host runtime binding contract: createApp closing call not found');
  }
  return bundlerStart + closingCallIndex;
}

describe('host createApp runtime binding contract', () => {
  it.each(hosts)('%s carries the binding into createApp assembly', (_host, path) => {
    const source = readFileSync(path, 'utf8');
    const assembly = createAppAssembly(source);
    expect(assembly).toContain('assetRuntimeBinding: runtimeBinding');
    expect(
      source.indexOf('configureRuntimeAssetCatalog', source.indexOf('await createApp(')),
    ).toBeGreaterThan(createAppEnd(source));
  });
});

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

// `vite` serve under NODE_ENV=production leaves import.meta.env.DEV false while
// HMR is active. The shared catalog helpers own that decision (they also
// consult import.meta.hot), so a host that pre-gates the binding or transport
// on DEV drops the scoped catalog transport and fails scene load with
// asset-package-invalid ('publication generation').
describe('hello-skin dev-binding ownership', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../../hello/skin/src/main.ts'),
    'utf8',
  );
  it('does not pre-gate the binding or import transport on import.meta.env.DEV', () => {
    expect(source).not.toMatch(/import\.meta\.env\.DEV/);
  });
  it('carries the binding into createApp and the bundler transport', () => {
    expect(source).toContain('assetRuntimeBinding: runtimeBinding');
    expect(source).toContain('importTransport: createRuntimeAssetImportTransport(runtimeBinding)');
  });
});

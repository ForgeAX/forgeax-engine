/// <reference types="node" />
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps published adapter fields optional without consumer ambient type opt-in', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-rhi-public-types-'));
  try {
    const source = join(directory, 'consumer.mts');
    const entry = fileURLToPath(new URL('../../dist/index.d.ts', import.meta.url));
    writeFileSync(
      source,
      `import type { RequestAdapterOptions } from ${JSON.stringify(entry.replaceAll('\\', '/'))};
export const omitted = {} satisfies RequestAdapterOptions;
export const preferred = { powerPreference: 'high-performance' } satisfies RequestAdapterOptions;
export const compatibility = { featureLevel: 'compatibility' } satisfies RequestAdapterOptions;
export const explicit = { featureLevel: undefined, forceFallbackAdapter: undefined } satisfies RequestAdapterOptions;
// @ts-expect-error Native featureLevel remains a string.
export const invalidLevel = { featureLevel: 42 } satisfies RequestAdapterOptions;
// @ts-expect-error Native powerPreference retains its enum.
export const invalidPreference = { powerPreference: 'not-a-native-preference' } satisfies RequestAdapterOptions;
`,
    );
    const program = ts.createProgram([source], {
      allowImportingTsExtensions: true,
      exactOptionalPropertyTypes: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    ).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);

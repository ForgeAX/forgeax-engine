import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { preparePackProgram } from '@forgeax/engine/pack/runtime';

test('the produced MCP preview runtime is a closed Pack program for preparation and installation', async () => {
  const artifact = process.env.FORGEAX_MCP_PREVIEW_ARTIFACT
    ? pathToFileURL(resolve(process.env.FORGEAX_MCP_PREVIEW_ARTIFACT))
    : new URL('../../dist/preview-runtime.mjs', import.meta.url);
  const source = await readFile(artifact, 'utf8');
  const { default: frontend } = await import(new URL('./preview-manifest.mjs', artifact).href);
  assert.equal(frontend.root.program, 'forgeax.mcp.preview');
  assert.equal(frontend.root.codeRevision, createHash('sha256').update(source).digest('hex'));
  assert.equal(frontend.module.specifier, artifact.href);
  for (const selected of ['default', frontend.module.prepare]) {
    assert.equal(typeof selected, 'string');
    const prepared = preparePackProgram({ entry: 'program-0.mjs', export: selected, modules: { 'program-0.mjs': source } });
    assert.equal(prepared.ok, true, JSON.stringify(prepared.ok ? null : prepared.error));
  }
});

test('ordinary author programs still require literal import specifiers and complete dependencies', () => {
  const dynamic = preparePackProgram({ entry: 'entry.mjs', export: 'load', modules: { 'entry.mjs': 'export const load = specifier => import(specifier);' } });
  assert.equal(dynamic.ok, false);
  assert.equal(dynamic.error.code, 'pack-program-invalid');
  assert.match(dynamic.error.detail.reason, /imports must have literal specifiers/);
  const missing = preparePackProgram({ entry: 'entry.mjs', export: 'load', modules: { 'entry.mjs': 'export const load = () => import("./missing.mjs");' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'pack-program-dependency-unavailable');
});

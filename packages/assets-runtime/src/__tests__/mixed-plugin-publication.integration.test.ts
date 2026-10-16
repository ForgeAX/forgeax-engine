import {
  createRuntimePackPublication,
  type FixedPackExecution,
  preparePackProgram,
  validateFixedPackPublication,
} from '@forgeax/engine-pack/runtime';
import type { PluginBuildTarget } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import {
  createFixedRuntimePackSnapshot,
  RuntimePackProducer,
} from '../../../import/src/runtime-pack.js';
import { captureAssetPublication } from '../capture-publication.js';
import { createCatalogSource } from '../catalog-source.js';
import { validateAssetPublication } from '../validate-publication.js';
import { defined } from './assert-defined.js';

const backend = '01900000-0000-7000-8000-000000000995';
const frontend = '01900000-0000-7000-8000-000000000996';
const shared = '01900000-0000-7000-8000-000000000997';

function fixture() {
  const publication = createRuntimePackPublication({
    scopeId: 'original',
    sourcePath: 'mixed.pack.json',
    sourceRevision: 'mixed',
    packageUrl: 'https://original.invalid/mixed.pack.json',
    pack: {
      assets: [backend, frontend, shared].map((guid) => ({
        guid,
        kind: 'plugin',
        payload: { kind: 'plugin', program: guid === shared ? 'shared' : guid },
        refs: [],
        artifacts: {},
      })),
    },
  });
  const rows = publication.publication.outputs.map((output) => ({
    guid: output.guid,
    kind: output.kind,
    sourceKey: output.sourceKey,
    sourcePath: 'mixed.pack.json',
    packageUrl: 'https://original.invalid/mixed.pack.json',
    publication: publication.publication,
  }));
  const { scopeId, generation, digest, outputSetDigest } = publication.pack;
  const projection = (target: PluginBuildTarget, guids: string[]) => {
    const artifact = preparePackProgram({
      entry: 'plugin.js',
      export: 'default',
      modules: {
        'plugin.js':
          target === 'host'
            ? "import fs from 'node:fs'; throw new Error('must not evaluate backend'); export default { apply() {} };"
            : "throw new Error('must not evaluate frontend'); export default { apply() {} };",
      },
      ...(target === 'host' ? { imports: { 'node:fs': 'node-version' } } : {}),
    }).unwrap();
    return {
      target,
      programs: new Map(
        guids.map((guid) => [
          guid === shared ? 'shared' : guid,
          { exportSource: async () => artifact },
        ]),
      ),
      tools: new Map<string, FixedPackExecution['tools'][string]>(
        guids.map((guid) => [guid, { schemaVersion: '1.0.0' as const, commands: [] }]),
      ),
      definitions: new Map(
        guids.map((guid) => [
          guid,
          {
            kind: 'publication' as const,
            publication: { scopeId, generation, digest, outputSetDigest },
          },
        ]),
      ),
    };
  };
  const executions = [
    projection('host', [backend, shared]),
    projection('frontend', [frontend, shared]),
  ];
  const source = createCatalogSource({ entries: rows });
  const capture = () =>
    captureAssetPublication(
      defined(rows[0]),
      rows,
      source,
      async () => new Response(JSON.stringify(publication.pack)),
      { executions },
    );
  return { capture, executions, rows, publication };
}

it('captures all realm attachments without conflating same program keys or evaluating code', async () => {
  const input = fixture();
  const fixed = (await input.capture()).unwrap();
  expect(fixed.pack).toEqual(input.publication.pack);
  expect(fixed.rows).toEqual(input.rows);
  expect(fixed.executions?.host?.programs.shared).not.toEqual(
    fixed.executions?.frontend?.programs.shared,
  );
  expect(Object.keys(fixed.executions?.host?.tools ?? {})).toEqual([backend, shared]);
  expect(Object.keys(fixed.executions?.frontend?.tools ?? {})).toEqual([frontend, shared]);
  expect(validateFixedPackPublication(JSON.parse(JSON.stringify(fixed))).ok).toBe(true);
  const snapshot = await createFixedRuntimePackSnapshot(fixed);
  const producer = new RuntimePackProducer({
    scopeId: 'restored',
    target: 'frontend',
    validate: async (state, fetcher) => validateAssetPublication(state.rows, fetcher),
  });
  try {
    // Backend bytes remain durable but do not require Node capabilities here.
    expect((await producer.restore(snapshot)).ok).toBe(true);
    expect(producer.rows()).toHaveLength(3);
    const saved = producer.snapshot();
    expect(
      Object.values(saved.closure?.recipes ?? {}).some(
        (recipe) => 'fixed' in recipe && recipe.fixed.executions?.host?.programs.shared,
      ),
    ).toBe(true);
  } finally {
    producer.dispose();
  }
});

it.each([
  'missing realm',
  'wrong realm',
  'extra target',
  'duplicate target',
  'changed evidence',
] as const)('rejects %s without silently reducing the publication', async (fault) => {
  const input = fixture();
  const first = defined(input.executions[0]);
  if (fault === 'missing realm') input.executions.splice(0, 1);
  if (fault === 'duplicate target') input.executions.push(first);
  if (fault === 'changed evidence')
    defined(first.definitions.get(backend)).publication.generation++;
  if (fault === 'wrong realm')
    first.tools.set(backend, {
      schemaVersion: '1.0.0',
      commands: [{ id: 'wrong', title: 'Wrong', summary: '', realm: 'frontend' }],
    });
  if (fault === 'extra target') first.target = 'other' as PluginBuildTarget;
  expect((await input.capture()).ok).toBe(false);
});

it('checks capabilities only for the selected fixed execution group before publishing', async () => {
  const fixed = (await fixture().capture()).unwrap();
  const snapshot = await createFixedRuntimePackSnapshot(fixed);
  for (const available of [false, true]) {
    const producer = new RuntimePackProducer({
      scopeId: 'host-restored',
      target: 'host',
      ...(available
        ? { imports: { 'node:fs': { identity: 'node-version', url: 'node:fs' } } }
        : {}),
      validate: async (state, fetcher) => validateAssetPublication(state.rows, fetcher),
    });
    try {
      expect((await producer.restore(snapshot)).ok).toBe(available);
      expect(producer.rows()).toHaveLength(available ? 3 : 0);
    } finally {
      producer.dispose();
    }
  }
});

import {
  GameProjectRootsSchema,
  loadGameProjectSync,
  PluginRealmSchema,
} from '@forgeax/engine/project';
import { defineFeature } from '../../lab/feature';

const GUIDS = {
  host: '11111111-1111-4111-8111-111111111111',
  frontend: '22222222-2222-4222-8222-222222222222',
  engine: '33333333-3333-4333-8333-333333333333',
  build: '44444444-4444-4444-8444-444444444444',
};

export default defineFeature({
  title: 'Plugin realm placement (roots)',
  catalog: 'Plugin realm placement',
  kind: 'headless',
  summary:
    'forge.json roots name at most one plugin asset GUID per realm: host (Node), frontend (browser), engine (World) and build (isolated build execution). The realm vocabulary is a closed enum shared with the tool runtime.',
  expect:
    'All checks pass: the four realms are exactly host/engine/build/frontend, each root key maps to one realm, unknown realms and unknown root keys are rejected.',
  run(checks) {
    checks.equal('closed realm vocabulary', [...PluginRealmSchema.options].sort(), [
      'build',
      'engine',
      'frontend',
      'host',
    ]);
    checks.ok('unknown realm rejected', !PluginRealmSchema.safeParse('worker').success);
    checks.equal(
      'root keys == realms',
      Object.keys(GameProjectRootsSchema.shape).sort(),
      [...PluginRealmSchema.options].sort(),
    );
    const project = loadGameProjectSync(() =>
      JSON.stringify({ id: 'fl', name: 'FL', schemaVersion: '3.0.0', roots: GUIDS }),
    );
    checks.ok('all four realms placed', project.ok);
    if (project.ok) {
      for (const realm of PluginRealmSchema.options) {
        checks.equal(`roots.${realm} keeps its GUID`, project.value.roots[realm], GUIDS[realm]);
      }
    }
    const partial = loadGameProjectSync(() =>
      JSON.stringify({
        id: 'fl',
        name: 'FL',
        schemaVersion: '3.0.0',
        roots: { engine: GUIDS.engine },
      }),
    );
    checks.ok('engine-only project valid', partial.ok && partial.value.roots.host === undefined);
    const worker = loadGameProjectSync(() =>
      JSON.stringify({
        id: 'fl',
        name: 'FL',
        schemaVersion: '3.0.0',
        roots: { worker: GUIDS.engine },
      }),
    );
    checks.equal(
      'unknown root realm -> forge-unknown-field',
      worker.ok ? 'ok' : worker.error.code,
      'forge-unknown-field',
    );
    const list = loadGameProjectSync(() =>
      JSON.stringify({
        id: 'fl',
        name: 'FL',
        schemaVersion: '3.0.0',
        roots: { engine: [GUIDS.engine] },
      }),
    );
    checks.equal(
      'one GUID per realm (array rejected)',
      list.ok ? 'ok' : list.error.code,
      'forge-guid-malformed',
    );
  },
});

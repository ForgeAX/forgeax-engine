import {
  FORGE_JSON,
  GameProjectSchema,
  loadGameProject,
  loadGameProjectSync,
} from '@forgeax/engine/project';
import { defineFeature } from '../../lab/feature';

const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const valid = { id: 'fl-game', name: 'FL Game', schemaVersion: '3.0.0', roots: { engine: GUID } };

export default defineFeature({
  title: 'forge.json manifest validation',
  catalog: '`forge.json` manifest',
  kind: 'headless',
  summary:
    'loadGameProject(read) / loadGameProjectSync(read) read forge.json through an injected reader and validate strict schema 3.0.0 identity plus root plugin asset GUIDs, returning closed GameProjectError codes.',
  expect:
    'All checks pass: a valid manifest loads; missing, bad JSON, wrong schemaVersion, unknown fields and non-canonical GUIDs each return their own code with expected/hint/detail.',
  async run(checks) {
    const load = (text: string) => loadGameProjectSync(() => text);
    const codeOf = (text: string) => {
      const r = load(text);
      return r.ok ? 'ok' : r.error.code;
    };
    checks.equal('reader receives FORGE_JSON', FORGE_JSON, 'forge.json');
    const ok = load(JSON.stringify(valid));
    checks.ok('valid manifest loads', ok.ok);
    if (ok.ok) checks.equal('parsed roots', ok.value.roots, { engine: GUID });
    const asyncOk = await loadGameProject(async () => JSON.stringify(valid));
    checks.ok('async loader agrees', asyncOk.ok);
    const missing = loadGameProjectSync(() => {
      throw new Error('ENOENT');
    });
    checks.equal(
      'reader throws -> forge-missing',
      missing.ok ? 'ok' : missing.error.code,
      'forge-missing',
    );
    const asyncMissing = await loadGameProject(() => Promise.reject(new Error('ENOENT')));
    checks.equal(
      'async reject -> forge-missing',
      asyncMissing.ok ? 'ok' : asyncMissing.error.code,
      'forge-missing',
    );
    checks.equal('bad JSON -> forge-parse-failed', codeOf('{ "id": '), 'forge-parse-failed');
    checks.equal(
      'schemaVersion 2 -> forge-schema-invalid',
      codeOf(JSON.stringify({ ...valid, schemaVersion: '2.0.0' })),
      'forge-schema-invalid',
    );
    checks.equal(
      'missing name -> forge-schema-invalid',
      codeOf(JSON.stringify({ ...valid, name: undefined })),
      'forge-schema-invalid',
    );
    checks.equal(
      'empty id -> forge-schema-invalid',
      codeOf(JSON.stringify({ ...valid, id: '' })),
      'forge-schema-invalid',
    );
    const unknown = load(JSON.stringify({ ...valid, scenes: [] }));
    checks.equal(
      'scenes[] -> forge-unknown-field',
      unknown.ok ? 'ok' : unknown.error.code,
      'forge-unknown-field',
    );
    if (!unknown.ok && unknown.error.code === 'forge-unknown-field') {
      checks.equal('detail names the field', unknown.error.detail.fieldNames, ['scenes']);
    }
    const upper = load(JSON.stringify({ ...valid, roots: { engine: GUID.toUpperCase() } }));
    checks.equal(
      'uppercase GUID -> forge-guid-malformed',
      upper.ok ? 'ok' : upper.error.code,
      'forge-guid-malformed',
    );
    if (!upper.ok && upper.error.code === 'forge-guid-malformed') {
      checks.equal('detail.field', upper.error.detail.field, 'roots.engine');
      checks.ok(
        'error carries expected + hint',
        upper.error.expected.length > 0 && upper.error.hint.length > 0,
      );
    }
    checks.equal(
      'non-UUID root -> forge-guid-malformed',
      codeOf(JSON.stringify({ ...valid, roots: { host: 'abc' } })),
      'forge-guid-malformed',
    );
    checks.equal('empty roots allowed', codeOf(JSON.stringify({ ...valid, roots: {} })), 'ok');
    checks.ok('GameProjectSchema is introspectable', GameProjectSchema.safeParse(valid).success);
  },
});

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  AssetPublicationEnvelope,
  CatalogEntry,
  RuntimeCatalogSnapshot,
} from '@forgeax/engine-types';
import { catalogOperationsFor } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type CompactCatalogWire, decodeCatalogWire, encodeCatalogWire } from '../catalog-wire.js';
import { createRuntimePackPublication } from '../runtime-publication.js';

function sourceRows(sourcePath: string, count: number): CatalogEntry[] {
  const { publication } = createRuntimePackPublication({
    pack: {
      assets: Array.from({ length: count }, (_, index) => ({
        guid: `${sourcePath}-${index}`,
        kind: 'mesh' as const,
        payload: { marker: index },
        refs: [],
      })),
    },
    scopeId: 'gta-wire-fixture',
    sourcePath,
    sourceRevision: 'source-revision',
    packageUrl: `/assets/${sourcePath}.pack.json`,
  });
  return publication.outputs.map((output, index) => ({
    guid: output.guid,
    packageUrl: `/assets/${sourcePath}.pack.json`,
    kind: output.kind,
    sourcePath,
    sourceKey: output.sourceKey,
    sourceIndex: index,
    refs: output.refs,
    relations: [],
    subject: 'imported-output',
    execution: 'cooked',
    lifecycle: 'current',
    publication,
  }));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing required fixture value');
  return value;
}

const rows = sourceRows('assets/market/market.pack.ts', 2);
const envelope = required(required(rows[0]).publication);
const snapshot = (entries: unknown) => ({
  schemaVersion: 'runtime-catalog-snapshot-v1' as const,
  scopeId: 'gta-wire-fixture',
  generation: 1,
  authority: 'authoritative' as const,
  entries,
  diagnostics: [],
});
const wireRoundTrip = (entries: readonly CatalogEntry[]) =>
  decodeCatalogWire(JSON.parse(JSON.stringify(encodeCatalogWire(entries)))).unwrap();
function compact(entries: readonly CatalogEntry[]): CompactCatalogWire {
  const encoded = encodeCatalogWire(entries);
  expect(Array.isArray(encoded)).toBe(false);
  return encoded as CompactCatalogWire;
}

function expectFailure(
  result: ReturnType<typeof decodeCatalogWire>,
  field?: string,
  index?: number,
) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected catalog admission failure');
  expect(result.error.code).toBe('asset-parse-failed');
  expect(result.error.expected.length).toBeGreaterThan(0);
  expect(result.error.hint.length).toBeGreaterThan(0);
  if (field !== undefined) expect(result.error.detail).toMatchObject({ field });
  if (index !== undefined) expect(result.error.detail).toMatchObject({ value: { index } });
}

describe('complete publication catalog transport', () => {
  it('encodes equal envelope objects under a bounded heap without retaining duplicate strings', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--experimental-strip-types',
      '--max-old-space-size=128',
      fileURLToPath(new URL('./catalog-wire-memory.fixture.mjs', import.meta.url)),
    ]);
    expect(JSON.parse(stdout)).toEqual({ rows: 4096, publications: 1, outputs: 512, shared: true });
  }, 30_000);
  const facts = { subject: 'internal-asset', execution: 'cooked', lifecycle: 'current' } as const;
  const projection = { ...facts, operations: catalogOperationsFor(facts) };

  it('shares complete projection values across JSON without merging row revisions or policy differences', () => {
    const input: CatalogEntry[] = rows.map((row, index) => ({
      ...row,
      projection: JSON.parse(JSON.stringify(projection)),
      revision: { digest: `revision-${index}`, observedAt: index, rootId: 'root' },
    }));
    input.push({
      ...required(input[0]),
      guid: 'reason-change',
      projection: {
        ...projection,
        operations: {
          ...projection.operations,
          save: { ...projection.operations.save, reason: 'different producer reason' },
        },
      },
    });
    input.push({
      ...required(input[0]),
      guid: 'lkg',
      projection: {
        ...projection,
        lastKnownGood: { packageUrl: '/prior.pack.json', receiptUrl: '/prior.receipt.json' },
      },
    });
    const before = JSON.stringify(input);
    const encoded = compact(input);
    expect(encoded.projections).toHaveLength(3);
    expect(encoded.entries[0]).toHaveProperty('projectionIndex', 0);
    expect(encoded.entries[0]).not.toHaveProperty('projection');
    const decoded = wireRoundTrip(input);
    expect(decoded).toEqual(input);
    expect(decoded[0]?.projection).toBe(decoded[1]?.projection);
    expect(decoded[0]?.projection).not.toBe(decoded[2]?.projection);
    expect(decoded[0]?.projection).not.toBe(decoded[3]?.projection);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('compacts repeated projections without publications and preserves producer extension fields', () => {
    const extended = { ...projection, producerDetail: { flags: ['a', 'b'] } };
    const input: CatalogEntry[] = rows.map(({ publication: _publication, ...row }) => ({
      ...row,
      projection: extended,
    }));
    const encoded = compact(input);
    expect(encoded.publications).toEqual([]);
    expect(encoded.projections).toHaveLength(1);
    expect(wireRoundTrip(input)).toEqual(input);
    expect(encodeCatalogWire(input.slice(0, 1))).toEqual(input.slice(0, 1));
  });

  it('rejects invalid projection tables and references without dropping or guessing producer facts', () => {
    const encoded = compact(rows.map((row) => ({ ...row, projection })));
    for (const projectionIndex of [undefined, null, '0', -1, 0.5, 1, Number.MAX_SAFE_INTEGER + 1]) {
      expectFailure(
        decodeCatalogWire({ ...encoded, entries: [{ ...encoded.entries[0], projectionIndex }] }),
        'entries[0].projectionIndex',
        0,
      );
    }
    expectFailure(decodeCatalogWire({ ...encoded, projections: undefined }), 'projections');
    expectFailure(decodeCatalogWire({ ...encoded, projections: [null] }), 'projections[0]', 0);
    expectFailure(
      decodeCatalogWire({ ...encoded, projections: new Array(1) }),
      'projections[0]',
      0,
    );
    expectFailure(
      decodeCatalogWire({
        ...encoded,
        entries: encoded.entries.map(({ projectionIndex: _index, ...row }) => row),
      }),
      'projections[0]',
      0,
    );
    expectFailure(
      decodeCatalogWire({ ...encoded, entries: [{ ...encoded.entries[0], projection }] }),
      'entries[0].projection',
      0,
    );
    expectFailure(
      decodeCatalogWire({ ...encoded, projections: [{ ...projection, operations: {} }] }),
      'projections[0].operations.preview',
      0,
    );
    expectFailure(
      decodeCatalogWire({
        ...encoded,
        projections: [{ ...projection, lastKnownGood: { receiptUrl: '/receipt.json' } }],
      }),
      'projections[0].lastKnownGood.packageUrl',
      0,
    );
    expect(() =>
      encodeCatalogWire([{ ...required(rows[0]), projectionIndex: 0 } as CatalogEntry]),
    ).toThrow(TypeError);
    expect(() =>
      encodeCatalogWire([{ ...required(rows[0]), projection: {} } as CatalogEntry]),
    ).toThrow(TypeError);
    expectFailure(
      decodeCatalogWire({ ...encoded, schemaVersion: 'pack-index-publications/1' }),
      'schemaVersion',
    );
  });

  it('compacts scoped rows while retaining the complete domain snapshot', () => {
    const input = snapshot(rows) as RuntimeCatalogSnapshot;
    const before = JSON.stringify(input);
    const encoded = encodeCatalogWire(input);
    expect(encoded).toEqual({ ...input, entries: compact(rows) });
    const parsed = JSON.parse(JSON.stringify(encoded));
    const decoded = decodeCatalogWire(parsed).unwrap();
    expect({ ...parsed, entries: decoded }).toEqual(input);
    expect(decoded[0]?.publication).toBe(decoded[1]?.publication);
    expect(JSON.stringify(input)).toBe(before);
    expect(encodeCatalogWire({ ...input, entries: rows.slice(0, 1) })).toEqual({
      ...input,
      entries: rows.slice(0, 1),
    });
  });

  it('rejects malformed scoped tables, stale authority and nested scopes', () => {
    const encoded = compact(rows);
    for (const entries of [
      snapshot(encoded),
      null,
      { ...encoded, entries: [{ ...encoded.entries[0], publicationIndex: 99 }] },
      { ...encoded, entries: [{ ...encoded.entries[0], publication: envelope }] },
      { ...encoded, entries: [] },
      { ...encoded, publications: [{ ...envelope, receipt: undefined }] },
      { ...encoded, publications: undefined },
    ]) {
      expectFailure(decodeCatalogWire(snapshot(entries)));
    }
    for (const change of [{ scopeId: null }, { generation: 1.5 }, { authority: 'degraded' }]) {
      expectFailure(decodeCatalogWire({ ...snapshot(encoded), ...change }));
    }
  });

  it('consumes authoritative scoped production rows without losing publication receipts', () => {
    const snapshot = {
      schemaVersion: 'runtime-catalog-snapshot-v1',
      scopeId: 'gta-wire-fixture',
      generation: 1,
      authority: 'authoritative',
      entries: rows,
      diagnostics: [],
    };
    const serialized = JSON.stringify(snapshot);
    expect(decodeCatalogWire(JSON.parse(serialized)).unwrap()).toEqual(rows);
    expect(decodeCatalogWire(snapshot).unwrap()).toBe(rows);
    expect(JSON.stringify(snapshot)).toBe(serialized);
    for (const invalid of [
      { ...snapshot, authority: 'degraded' },
      { ...snapshot, scopeId: 1 },
      { ...snapshot, generation: 1.5 },
      { ...snapshot, entries: null },
    ]) {
      expectFailure(decodeCatalogWire(invalid));
    }
  });

  it('round trips all fields through real JSON and preserves rows without a publication', () => {
    const legacyRow: CatalogEntry = {
      guid: 'legacy',
      kind: 'mesh',
      sourcePath: 'legacy.pack.json',
      packageUrl: '/legacy.pack.json',
      name: 'legacy mesh',
    };
    const input = [...rows, legacyRow];
    const before = JSON.stringify(input);
    const encoded = compact(input);
    expect(encoded.publications).toHaveLength(1);
    expect(encoded.entries[0]).not.toHaveProperty('publication');
    expect(encoded.entries[0]).toHaveProperty('publicationIndex', 0);
    expect(wireRoundTrip(input)).toEqual(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(decodeCatalogWire(input).unwrap()).toBe(input);
  });

  it('retains every sibling and complete receipt at the actual GTA 219/188 output sizes', () => {
    const input = [
      ...sourceRows('assets/characters/characters.pack.ts', 219),
      ...sourceRows('assets/buildings/buildings.pack.ts', 188),
    ];
    const encoded = compact(input);
    expect(encoded.publications.map((item) => item.outputs.length)).toEqual([219, 188]);
    expect(encoded.entries).toHaveLength(407);
    expect(JSON.stringify(encoded).length).toBeLessThan(JSON.stringify(input).length / 20);
    const decoded = wireRoundTrip(input);
    expect(decoded).toEqual(input);
    expect(required(decoded[0]).publication).toBe(required(decoded[218]).publication);
    expect(required(decoded[219]).publication).toBe(required(decoded[406]).publication);
    expect(required(decoded[0]).publication).not.toBe(required(decoded[219]).publication);
  });

  it.each([
    ['digest', { ...envelope, digest: 'different-digest' }],
    ['sourcePath', { ...envelope, sourcePath: 'different-source.pack.ts' }],
    [
      'outputs',
      { ...envelope, outputs: [{ ...required(envelope.outputs[0]), digest: 'different-output' }] },
    ],
    [
      'receipt',
      { ...envelope, receipt: { ...envelope.receipt, inputFingerprint: 'different-receipt' } },
    ],
  ] as const)('does not conflate a distinct %s within the same source publication', (_, other) => {
    const input = [
      ...rows,
      {
        ...required(rows[1]),
        guid: 'different-output-row',
        publication: other as AssetPublicationEnvelope,
      },
    ];
    expect(compact(input).publications).toHaveLength(2);
    expect(wireRoundTrip(input)).toEqual(input);
  });

  it('deduplicates independently parsed equal envelopes rather than only object aliases', () => {
    const input = JSON.parse(JSON.stringify(rows)) as CatalogEntry[];
    expect(required(input[0]).publication).not.toBe(required(input[1]).publication);
    expect(compact(input).publications).toHaveLength(1);
    expect(wireRoundTrip(input)).toEqual(input);
  });

  it.each([
    undefined,
    null,
    '0',
    -1,
    0.5,
    1,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid publicationIndex %s', (publicationIndex) => {
    const encoded = compact(rows);
    expectFailure(
      decodeCatalogWire({
        ...encoded,
        entries: [{ ...encoded.entries[0], publicationIndex }],
      }),
      'entries[0].publicationIndex',
      0,
    );
  });

  it.each([
    { schemaVersion: 'other', entries: [], publications: [] },
    { schemaVersion: 'pack-index-tables/1', entries: {}, publications: [] },
    { schemaVersion: 'pack-index-tables/1', entries: [], publications: {} },
    { schemaVersion: 'pack-index-tables/1', entries: [], publications: [null] },
    { schemaVersion: 'pack-index-tables/1', entries: [], publications: [{}] },
    { schemaVersion: 'pack-index-tables/1', entries: [null], publications: [] },
    { schemaVersion: 'pack-index-tables/1', entries: [], publications: [], extra: true },
  ])('rejects an unsupported or malformed compact document', (input) => {
    expectFailure(decodeCatalogWire(input));
  });

  it('rejects orphan tables, inline publication conflicts and truncated envelopes', () => {
    const encoded = compact(rows);
    expectFailure(decodeCatalogWire({ ...encoded, entries: [] }), 'publications[0]', 0);
    expectFailure(
      decodeCatalogWire({
        ...encoded,
        entries: [{ ...encoded.entries[0], publication: envelope }],
      }),
      'entries[0].publication',
      0,
    );
    expectFailure(
      decodeCatalogWire({
        ...encoded,
        publications: [{ ...envelope, receipt: undefined }],
      }),
      'publications[0].receipt',
      0,
    );
    expect(() =>
      encodeCatalogWire([{ ...required(rows[0]), publicationIndex: 0 } as CatalogEntry]),
    ).toThrow(TypeError);
  });

  it('keeps zero, single and unrelated publications on the legacy array wire', () => {
    for (const input of [[], rows.slice(0, 1), [...rows.slice(0, 1), ...sourceRows('other', 1)]]) {
      expect(encodeCatalogWire(input)).toBe(input);
      expect(wireRoundTrip(input)).toEqual(input);
    }
  });
  it('returns the specific first table field and index without throwing', () => {
    const encoded = compact(rows);
    expectFailure(
      decodeCatalogWire({
        ...encoded,
        publications: [
          { ...envelope, outputs: [{ ...required(envelope.outputs[0]), refs: null }] },
        ],
      }),
      'publications[0].outputs[0].refs',
      0,
    );
    expectFailure(
      decodeCatalogWire({ ...encoded, publications: new Array(1) }),
      'publications[0]',
      0,
    );
    expectFailure(decodeCatalogWire({ ...encoded, entries: new Array(1) }), 'entries[0]', 0);
  });
});

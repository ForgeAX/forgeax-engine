import {
  type AssetPublicationEnvelope,
  type AssetPublicationExternalEvidence,
  type AssetPublicationOutput,
  createAssetPublication,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { validatePublicationReferences } from '../internal/publication-references';

const guid = (index: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;
const digest = `sha256:${'1'.repeat(64)}`;
const output = (index: number, refs: readonly string[] = []): AssetPublicationOutput => ({
  guid: guid(index),
  sourceKey: `row/${index}`,
  kind: 'mesh',
  digest,
  refs,
});
function publication(
  outputs: readonly AssetPublicationOutput[],
  externalEvidence: readonly AssetPublicationExternalEvidence[] = [],
) {
  return createAssetPublication({
    sourcePath: 'large.pack.ts',
    sourceRevision: 'fixture',
    generation: 1,
    digest,
    packageUrl: '/large.pack.json',
    inputFingerprint: digest,
    outputs,
    externalEvidence,
  });
}
const validate = (root: string, current: AssetPublicationEnvelope) =>
  validatePublicationReferences(root, { publication: current }, () => ({ publication: current }));

describe('publication reference traversal', () => {
  it('does not index an entire large Pack for one leaf reference', () => {
    const rows = Array.from({ length: 256 }, (_, index) => output(index + 1));
    const current = publication(rows);
    let guidReads = 0;
    const measured = rows.map((row) => ({
      ...row,
      get guid() {
        guidReads++;
        return row.guid;
      },
    }));
    expect(validate(guid(3), { ...current, outputs: measured }).ok).toBe(true);
    expect(guidReads).toBe(3);
  });

  it('reads a shared output table linearly while visiting every deferred reference', () => {
    const count = 256,
      rows = Array.from({ length: count }, (_, index) => output(index + 1));
    rows[0] = output(
      1,
      rows.slice(1).map((row) => row.guid),
    );
    const current = publication(rows);
    let guidReads = 0;
    const measured = rows.map((row) => ({
      ...row,
      get guid() {
        guidReads++;
        return row.guid;
      },
    }));
    const seen = new Set<string>();
    const result = validatePublicationReferences(
      guid(1),
      { publication: { ...current, outputs: measured } },
      (key) => {
        seen.add(key);
        return { publication: { ...current, outputs: measured } };
      },
    );
    expect(result.ok).toBe(true);
    expect(seen.size).toBe(count - 1);
    expect(guidReads).toBeLessThanOrEqual(count * 2);
  });

  it('retains first-match, case-insensitive and cyclic reference semantics', () => {
    const missing = guid(99);
    const rows = [output(1, [guid(2).toUpperCase()]), output(2, [guid(1)]), output(2, [missing])];
    const current = publication(rows),
      visited: string[] = [];
    expect(
      validatePublicationReferences(guid(1).toUpperCase(), { publication: current }, (key) => {
        visited.push(key);
        return { publication: current };
      }).ok,
    ).toBe(true);
    expect(visited).not.toContain(missing);
    expect(visited.length).toBeLessThanOrEqual(3);
  });

  it.each([
    'digest',
    'generation',
  ] as const)('still rejects changed %s evidence on a deferred descendant', (field) => {
    const child = publication([output(3)]);
    const rows = [output(1, [guid(2)]), output(2)];
    const current = publication(rows);
    const descendant = publication(rows, [
      { guid: guid(3), usage: 'reference', [field]: field === 'digest' ? digest : 1 },
    ]);
    const changed =
      field === 'digest'
        ? { ...child, outputs: [{ ...output(3), digest: `sha256:${'2'.repeat(64)}` }] }
        : { ...child, generation: 2 };
    const result = validatePublicationReferences(guid(1), { publication: current }, (key) => ({
      publication: key === guid(3) ? changed : descendant,
    }));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'asset-dependency-failed', detail: { dependencyGuid: guid(3) } },
    });
  });

  it('does not retain an index across checks of mutable output tables', () => {
    const rows = [output(1), output(2)],
      current = publication(rows);
    expect(validate(guid(1), current).ok).toBe(true);
    const dependency = guid(3),
      stale = publication([output(3)], [{ guid: guid(4), usage: 'reference', generation: 1 }]);
    rows[0] = output(1, [dependency]);
    const result = validatePublicationReferences(guid(1), { publication: current }, (key) =>
      key === dependency ? { publication: stale } : undefined,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'asset-dependency-failed' } });
  });
});

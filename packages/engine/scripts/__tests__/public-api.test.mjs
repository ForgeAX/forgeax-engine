import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { comparePublicApi, duplicateExports, PLAN_ID_PATTERN } from '../public-api.mjs';
import { engineApiTiers } from '../public-facades.mjs';

/** Entry names to identities, with each name declared once unless overridden. */
function identitiesOf(entries, declarations = {}) {
  return Object.fromEntries(
    Object.entries(entries).map(([subpath, names]) => [
      subpath,
      Object.fromEntries(
        names.map((name) => {
          const bare = name.replace(/^type /, '');
          return [bare, declarations[`${subpath}#${bare}`] ?? `decl:${bare}`];
        }),
      ),
    ]),
  );
}

const baseline = {
  entries: { ecs: ['World', 'type Query'], scene: ['Transform'] },
  duplicates: {},
  planIds: { render: 2 },
};

describe('public API ratchet', () => {
  it('accepts an unchanged surface', () => {
    const scan = { ...baseline, duplicates: duplicateExports(identitiesOf(baseline.entries)) };
    expect(comparePublicApi(scan, baseline)).toEqual({ growth: [], violations: [], stale: [] });
  });

  it('reports a new export as growth that review must accept', () => {
    const entries = { ...baseline.entries, scene: ['Transform', 'worldInstantiateSceneRec'] };
    const result = comparePublicApi({ ...baseline, entries }, baseline);
    expect(result.growth).toEqual(['export scene worldInstantiateSceneRec']);
    expect(result.violations).toEqual([]);
  });

  it('rejects a second owner for an exported name', () => {
    const entries = { ...baseline.entries, scene: ['Transform', 'World'] };
    const scan = {
      entries,
      duplicates: duplicateExports(identitiesOf(entries)),
      planIds: baseline.planIds,
    };
    expect(scan.duplicates).toEqual({ World: ['ecs', 'scene'] });
    expect(comparePublicApi(scan, baseline).violations).toEqual([
      'duplicate World also exported by ecs, scene',
    ]);
  });

  it('treats one declaration re-exported as a type and a value as one owner question', () => {
    expect(duplicateExports(identitiesOf({ a: ['type Result'], b: ['Result'] }))).toEqual({
      Result: ['a', 'b'],
    });
  });

  it('keeps distinct declarations that share a name as separate owners', () => {
    const identities = identitiesOf(
      { render: ['DirectionalLight'], three: ['DirectionalLight'] },
      { 'three#DirectionalLight': 'decl:three/DirectionalLight' },
    );
    expect(duplicateExports(identities)).toEqual({});
  });

  it('rejects new plan-ID comments and asks to lock in removed ones', () => {
    const grown = comparePublicApi({ ...baseline, planIds: { render: 3 } }, baseline);
    expect(grown.violations).toEqual(['plan-id render 3 > 2']);
    const shrunk = comparePublicApi({ ...baseline, planIds: {} }, baseline);
    expect(shrunk.stale).toEqual(['plan-id render 0 < 2']);
  });

  it('asks to lock in removed exports', () => {
    const entries = { ...baseline.entries, ecs: ['World'] };
    expect(comparePublicApi({ ...baseline, entries }, baseline).stale).toEqual([
      'export ecs type Query',
    ]);
  });

  it('matches plan IDs but not ordinary words', () => {
    const text = 'feat-20260704 M2 / tweak-20260611 / feature-2026 / feat-2026070';
    expect(text.match(PLAN_ID_PATTERN)).toEqual(['feat-20260704', 'tweak-20260611']);
  });
});

describe('engine API tiers', () => {
  let root;
  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  async function tiersWith(source) {
    root = await mkdtemp(join(tmpdir(), 'engine-api-tiers-'));
    await mkdir(join(root, 'packages/engine'), { recursive: true });
    await writeFile(join(root, 'packages/engine/api-tiers.json'), JSON.stringify(source));
    return engineApiTiers(root, [{ directory: 'ecs' }, { directory: 'rhi' }]);
  }

  it('maps every public member to one tier', async () => {
    const tiers = await tiersWith({ game: ['ecs'], internal: ['rhi'] });
    expect([...tiers]).toEqual([
      ['ecs', 'game'],
      ['rhi', 'internal'],
    ]);
  });

  it('rejects an untiered member, an unknown tier, a duplicate and a stale entry', async () => {
    await expect(tiersWith({ game: ['ecs'] })).rejects.toThrow('engine-api-tier-missing: rhi');
    await expect(tiersWith({ game: ['ecs'], beta: ['rhi'] })).rejects.toThrow(
      'engine-api-tier-unknown: beta',
    );
    await expect(tiersWith({ game: ['ecs'], internal: ['rhi', 'ecs'] })).rejects.toThrow(
      'engine-api-tier-duplicate: ecs',
    );
    await expect(tiersWith({ game: ['ecs', 'npc'], internal: ['rhi'] })).rejects.toThrow(
      'engine-api-tier-stale: npc',
    );
  });
});

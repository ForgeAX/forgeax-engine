import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import falsificationManifest from '../../../cases/extended-lighting/falsification/manifest.json' with { type: 'json' };
import probeOracle from '../../../cases/extended-lighting/probe-oracle.json' with { type: 'json' };
import probe from '../../../cases/extended-lighting/probe.json' with { type: 'json' };
import recovery from '../../../cases/extended-lighting/recovery.json' with { type: 'json' };
import rectArea from '../../../cases/extended-lighting/rect-area.json' with { type: 'json' };
import spotModifiers from '../../../cases/extended-lighting/spot-modifiers.json' with { type: 'json' };
import {
  EXTENDED_LIGHTING_CASE_ROSTER,
  EXTENDED_LIGHTING_REQUIRED_CASE_IDS,
  findCarrierPlaceholderVerdicts,
} from '../case-roster';

const repoRoot = resolve(import.meta.dirname, '../../../../../../');
const sceneFixtures = [rectArea, spotModifiers, probe, recovery] as const;
const sceneFixtureById = new Map(sceneFixtures.map((fixture) => [fixture.caseId, fixture]));

describe('extended-lighting comparison case roster', () => {
  it('matches every required scene fixture, probe oracle, and falsification manifest entry', () => {
    expect(EXTENDED_LIGHTING_CASE_ROSTER.map((entry) => entry.caseId)).toEqual([
      'rect-area',
      'spot-modifiers',
      'probe',
      'recovery',
      'probe-oracle',
      'rect-area-reversed-front',
      'rect-area-zero-ltc',
      'probe-sky-contributor',
      'recovery-stale-generation',
    ]);
    expect(EXTENDED_LIGHTING_REQUIRED_CASE_IDS).toEqual(EXTENDED_LIGHTING_CASE_ROSTER.map((entry) => entry.caseId));
    expect(new Set(EXTENDED_LIGHTING_REQUIRED_CASE_IDS).size).toBe(EXTENDED_LIGHTING_REQUIRED_CASE_IDS.length);

    const sceneEntries = EXTENDED_LIGHTING_CASE_ROSTER.filter((entry) => entry.kind === 'scene');
    expect(sceneEntries.map((entry) => entry.caseId)).toEqual(sceneFixtures.map((fixture) => fixture.caseId));
    for (const entry of sceneEntries) {
      expect(entry.required).toBe(true);
      expect(entry.fixture).toEqual(sceneFixtureById.get(entry.caseId));
      expect(entry.fixturePath).toBe(`apps/parity/color-lighting/cases/extended-lighting/${entry.caseId}.json`);
      expect(entry.comparison.threeNativeSubset.length).toBeGreaterThan(0);
      expect(entry.comparison.independentOracleBoundary.length).toBeGreaterThan(0);
    }

    const oracleEntry = EXTENDED_LIGHTING_CASE_ROSTER.find((entry) => entry.caseId === 'probe-oracle');
    expect(oracleEntry).toMatchObject({ kind: 'probe-oracle', required: true, fixturePath: 'apps/parity/color-lighting/cases/extended-lighting/probe-oracle.json' });
    expect(oracleEntry && oracleEntry.fixture).toEqual(probeOracle);
    expect(oracleEntry && oracleEntry.comparison.threeNativeSubset).toContain('no native local volume');

    const falsifierEntries = EXTENDED_LIGHTING_CASE_ROSTER.filter((entry) => entry.kind === 'falsifier');
    expect(falsifierEntries.map((entry) => entry.caseId)).toEqual(falsificationManifest.cases.map((entry) => entry.caseId));
    expect(falsifierEntries.every((entry) => entry.required)).toBe(true);
    for (const entry of falsifierEntries) {
      const manifestEntry = falsificationManifest.cases.find((candidate) => candidate.caseId === entry.caseId);
      expect(manifestEntry).toBeDefined();
      expect(entry).toMatchObject({
        sourceCaseId: manifestEntry?.sourceCaseId,
        mutation: manifestEntry?.mutation,
        expected: manifestEntry?.expected,
      });
      expect(entry.comparison.threeNativeSubset.length).toBeGreaterThan(0);
      expect(entry.comparison.independentOracleBoundary.length).toBeGreaterThan(0);
    }
  });

  it('rejects unavailable and not-run placeholder verdicts in every required Browser/Dawn carrier source', () => {
    const carrierEntries = EXTENDED_LIGHTING_CASE_ROSTER.filter((entry) => entry.kind === 'scene');
    const violations = carrierEntries.flatMap((entry) =>
      (['browser', 'dawn'] as const).flatMap((backend) => {
        const sourcePath = resolve(repoRoot, entry.carrierSources[backend]);
        const source = readFileSync(sourcePath, 'utf8');
        return findCarrierPlaceholderVerdicts(source).map((line) => `${entry.caseId}/${backend}: ${line}`);
      }),
    );
    expect(violations).toEqual([]);
  });

  it('recognizes both placeholder spellings so the source gate cannot silently weaken', () => {
    expect(findCarrierPlaceholderVerdicts("const a = { status: 'unavailable' };\nconst b = { status: 'not-run' };")).toEqual([
      "const a = { status: 'unavailable' };",
      "const b = { status: 'not-run' };",
    ]);
  });
});

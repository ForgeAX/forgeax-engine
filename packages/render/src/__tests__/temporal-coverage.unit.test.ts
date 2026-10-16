import { describe, expect, it } from 'vitest';
import { classifySceneDataCoverage, scanSceneDataCoverage } from '../temporal/coverage';

describe('temporal contributor coverage', () => {
  it('partitions exact, reactive, and missing contributors', () => {
    const result = classifySceneDataCoverage({
      contributors: [
        { id: 'camera', kind: 'exact' },
        { id: 'world', kind: 'reactive' },
      ],
      requiredContributorIds: ['camera', 'world', 'skin'],
    });
    expect(result).toEqual({
      exactContributorIds: ['camera'],
      reactiveContributorIds: ['world'],
      missingContributorIds: ['skin'],
      omittedMissingContributorCount: 0,
      complete: false,
    });
  });

  it('bounds missing IDs at 32 and preserves omitted count', () => {
    const required = Array.from({ length: 40 }, (_, index) => `missing-${index}`);
    const result = scanSceneDataCoverage({
      schema: 'forgeax::scene-data::temporal-v1',
      lane: 'direct',
      producerId: 'forgeax::standard::scene-data',
      contributorIds: [],
      requiredContributorIds: required,
    });
    expect(result.complete).toBe(false);
    expect(result.missingContributorIds).toHaveLength(32);
    expect(result.omittedMissingContributorCount).toBe(8);
  });
});

import { describe, expect, it } from 'vitest';
import type {
  AssetPublicationEvidenceUsage,
  AssetPublicationExternalEvidence,
} from '../asset-producer';

describe('Asset publication dependency evidence', () => {
  it('keeps R/C/E usage as producer-owned facts', () => {
    const evidence: AssetPublicationExternalEvidence[] = [
      { guid: 'guid:reference', usage: 'reference' },
      { guid: 'guid:content', usage: 'content' },
      { guid: 'guid:both', usage: 'both' },
    ];
    const usages: AssetPublicationEvidenceUsage[] = evidence.map((entry) => entry.usage);
    expect(usages).toEqual(['reference', 'content', 'both']);
    expect(evidence.map((entry) => entry.guid)).toEqual([
      'guid:reference',
      'guid:content',
      'guid:both',
    ]);
  });
});

import { type DdcEntry, ddcOutputDigest } from '../entry-store.js';

export function ddcEntryFixture(
  content: Omit<DdcEntry, 'receipt'>,
  producer: string,
  inputFingerprint: string,
): DdcEntry {
  return {
    ...content,
    receipt: {
      guid: content.guid,
      key: content.key,
      producer,
      inputFingerprint,
      outputDigest: ddcOutputDigest(content),
    },
  };
}

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isValidAssetGuidString } from '../guid';

const ownerSource = readFileSync(new URL('../guid.ts', import.meta.url), 'utf8');
const scannerSource = readFileSync(new URL('../scanner.ts', import.meta.url), 'utf8');
const cliSource = readFileSync(new URL('../cli-asset.ts', import.meta.url), 'utf8');

describe('asset GUID validator owner', () => {
  it('keeps scanner and CLI validation on the GUID owner', () => {
    expect(isValidAssetGuidString('019e3969-1d48-7c3b-ac24-6d68f457065f')).toBe(true);
    expect(isValidAssetGuidString('not-a-guid')).toBe(false);
    expect(isValidAssetGuidString(undefined)).toBe(false);
    expect(ownerSource.match(/const UUID_RE = \/\^\[0-9a-f\]/g)).toHaveLength(1);
    expect(scannerSource).not.toMatch(/const UUID_RE =/);
    expect(cliSource).not.toMatch(/const UUID_RE =/);
    expect(scannerSource.match(/isValidAssetGuidString/g)).toHaveLength(4);
    expect(cliSource.match(/isValidAssetGuidString/g)).toHaveLength(3);
  });
});

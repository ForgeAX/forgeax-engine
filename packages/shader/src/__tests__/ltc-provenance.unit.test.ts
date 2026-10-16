import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  generateLtcTables,
  hashLtcTable,
  LTC_SOURCE_PROVENANCE,
  LTC_TABLE_HASHES,
  LTC_TABLE_HEIGHT,
  LTC_TABLE_WIDTH,
  LTC_TABLES,
} from '../ltc/tables';

function tableBytes(table: Uint16Array): Buffer {
  return Buffer.from(table.buffer, table.byteOffset, table.byteLength);
}

function expectSameTableBytes(left: Uint16Array, right: Uint16Array): void {
  expect(Buffer.compare(tableBytes(left), tableBytes(right))).toBe(0);
}

describe('LTC provenance and tracked data contract', () => {
  it('pins the fixed Three.js reference and two 64 by 64 rgba16float tables', () => {
    expect(LTC_SOURCE_PROVENANCE.source).toBe('Three.js');
    expect(LTC_SOURCE_PROVENANCE.revision).toBe('r184');
    expect(LTC_SOURCE_PROVENANCE.generator).toContain('deterministic');
    expect({ width: LTC_TABLE_WIDTH, height: LTC_TABLE_HEIGHT }).toEqual({ width: 64, height: 64 });
    expect(LTC_TABLES.lambert.byteLength).toBe(64 * 64 * 4 * 2);
    expect(LTC_TABLES.ggx.byteLength).toBe(64 * 64 * 4 * 2);
  });

  it('keeps generation deterministic and hashes the tracked outputs', () => {
    const first = generateLtcTables();
    const second = generateLtcTables();

    expectSameTableBytes(first.lambert, second.lambert);
    expectSameTableBytes(first.ggx, second.ggx);
    expectSameTableBytes(first.lambert, LTC_TABLES.lambert);
    expectSameTableBytes(first.ggx, LTC_TABLES.ggx);
    expect(hashLtcTable(first.lambert)).toBe(LTC_TABLE_HASHES.lambert);
    expect(hashLtcTable(first.ggx)).toBe(LTC_TABLE_HASHES.ggx);
    expect(LTC_TABLE_HASHES.lambert).toMatch(/^[a-f0-9]{64}$/);
    expect(LTC_TABLE_HASHES.ggx).toMatch(/^[a-f0-9]{64}$/);
  });
});

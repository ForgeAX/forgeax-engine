import { describe, expect, it } from 'vitest';
import { deriveAssetName } from '../src/deriveAssetName.js';

// AC-15: deriveAssetName pure function -- explicit authored names always win;
// package basename and empty string are deterministic fallbacks.

describe('deriveAssetName (AC-15)', () => {
  it('single asset package without storedName: returns basename(packagePath)', () => {
    expect(deriveAssetName('/assets/models/robot.pack.json', 1)).toBe('robot.pack.json');
    expect(deriveAssetName('/hero', 1)).toBe('hero');
  });

  it('single asset package with storedName: preserves the authored entry name', () => {
    expect(deriveAssetName('/assets/Materials.pack.json', 1, 'NewMaterial')).toBe('NewMaterial');
  });

  it('multi asset package with storedName: returns storedName', () => {
    expect(deriveAssetName('/assets/sponza.pack.json', 5, 'Body')).toBe('Body');
    expect(deriveAssetName('/assets/room.pack.json', 3, 'LightFixture')).toBe('LightFixture');
  });

  it('multi asset package without storedName (AC-15.1): falls back to basename(path)', () => {
    expect(deriveAssetName('/assets/sponza.pack.json', 5)).toBe('sponza.pack.json');
    expect(deriveAssetName('/assets/sponza.pack.json', 5, undefined)).toBe('sponza.pack.json');
  });

  it('null packagePath without storedName (AC-15.2): returns empty string', () => {
    expect(deriveAssetName(null, 1)).toBe('');
    expect(deriveAssetName(null, 5)).toBe('');
    expect(deriveAssetName(null, 1, undefined)).toBe('');
  });

  it('null packagePath with storedName: returns storedName', () => {
    expect(deriveAssetName(null, 1, 'BigCube')).toBe('BigCube');
  });

  it('never throws', () => {
    expect(() => deriveAssetName(null, 1)).not.toThrow();
    expect(() => deriveAssetName('/p', 1)).not.toThrow();
    expect(() => deriveAssetName('/p', 5, 'x')).not.toThrow();
    expect(() => deriveAssetName('/p', 5)).not.toThrow();
  });
});

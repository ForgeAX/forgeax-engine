import { derive, isMaterialProgramAbi } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createMaterialProgramArtifactReceipt,
  createStandardPbrArtifactReceipt,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '../material/artifact-types.js';

const BASE_VERTEX_INPUTS = [
  { semantic: 'position', location: 0, format: 'float32x3' },
  { semantic: 'normal', location: 1, format: 'float32x3' },
  { semantic: 'uv', location: 2, format: 'float32x2' },
  { semantic: 'tangent', location: 3, format: 'float32x4' },
] as const;

const SKIN_VERTEX_INPUTS = [
  { semantic: 'skinIndex', location: 4, format: 'uint16x4' },
  { semantic: 'skinWeight', location: 5, format: 'float32x4' },
] as const;

const COLOR_VERTEX_INPUT = { semantic: 'color', location: 13, format: 'float32x4' } as const;

const CASES = [
  {
    name: 'rigid uncolored',
    skinned: false,
    vertexColorAvailable: false,
    vertexInputs: BASE_VERTEX_INPUTS,
  },
  {
    name: 'rigid colored',
    skinned: false,
    vertexColorAvailable: true,
    vertexInputs: [...BASE_VERTEX_INPUTS, COLOR_VERTEX_INPUT],
  },
  {
    name: 'skinned uncolored',
    skinned: true,
    vertexColorAvailable: false,
    vertexInputs: [...BASE_VERTEX_INPUTS, ...SKIN_VERTEX_INPUTS],
  },
  {
    name: 'skinned colored',
    skinned: true,
    vertexColorAvailable: true,
    vertexInputs: [...BASE_VERTEX_INPUTS, ...SKIN_VERTEX_INPUTS, COLOR_VERTEX_INPUT],
  },
] as const;

describe('Standard PBR artifact receipt vertex ABI', () => {
  it('keeps generic vertex programs unbounded unless their producer certifies the contract', () => {
    const unknown = createMaterialProgramArtifactReceipt({
      schema: [],
      directEntry: 'vs_main',
      vertexInputs: [],
    });
    expect(unknown.positionBounds).toBeUndefined();
    expect(isMaterialProgramAbi(unknown)).toBe(true);
    expect(isMaterialProgramAbi({ ...unknown, positionBounds: 'arbitrary' })).toBe(false);
    const known = createMaterialProgramArtifactReceipt({
      schema: [],
      directEntry: 'vs_main',
      vertexInputs: [],
      positionBounds: 'standard-input',
    });
    expect(isMaterialProgramAbi(known)).toBe(true);
    expect(known.receiptIdentity).not.toBe(unknown.receiptIdentity);
  });
  it.each(CASES)('publishes the $name input sequence in location order', (testCase) => {
    const receipt = createStandardPbrArtifactReceipt(
      testCase.skinned,
      testCase.vertexColorAvailable,
    );

    expect(receipt.vertexInputs).toEqual(testCase.vertexInputs);
    expect(receipt.positionBounds).toBe('standard-input');
    expect(receipt.generation).toBe(5);
    expect(receipt.reflection.vertexInputs).toEqual(testCase.vertexInputs);
    expect(receipt.vertexInputs.map((input) => input.location)).toEqual(
      testCase.vertexInputs.map((input) => input.location),
    );
    expect(receipt.vertexInputs.some((input) => input.semantic === 'skinWeight')).toBe(
      testCase.skinned,
    );
  });

  it('shares material row and resource ABI across all rigid and skinned color variants', () => {
    const receipts = CASES.map((testCase) =>
      createStandardPbrArtifactReceipt(testCase.skinned, testCase.vertexColorAvailable),
    );
    const [baseline, ...variants] = receipts;
    if (baseline === undefined) throw new Error('PBR ABI cases must include a baseline');

    for (const receipt of variants) {
      expect(receipt.materialRow).toEqual(baseline.materialRow);
      expect(receipt.materialRow.addressUnitBytes).toBe(16);
      expect(receipt.resourceSlots).toEqual(baseline.resourceSlots);
      expect(receipt.reflection.resourceSlots).toEqual(baseline.reflection.resourceSlots);
      expect(receipt.uvSets).toEqual(baseline.uvSets);
      expect(receipt.alphaMask).toEqual(baseline.alphaMask);
    }
  });

  it('separates colored and uncolored identities while retaining rigid and skin compatibility', () => {
    const rigid = createStandardPbrArtifactReceipt(false, false);
    const rigidColor = createStandardPbrArtifactReceipt(false, true);
    const skin = createStandardPbrArtifactReceipt(true, false);
    const skinColor = createStandardPbrArtifactReceipt(true, true);

    expect(rigid.receiptIdentity).toBe(
      `standard-pbr/${derive(STANDARD_PIPELINE_PARAM_SCHEMA).layoutIdentity}/address-16/vertex-contract-5`,
    );
    expect(rigid.reflection.layoutIdentity).toBe(rigid.receiptIdentity);
    expect(skin.receiptIdentity).toBe(rigid.receiptIdentity);
    expect(skin.reflection.layoutIdentity).toBe(skin.receiptIdentity);
    expect(rigidColor.receiptIdentity).toBe(`${rigid.receiptIdentity}/vertex-color`);
    expect(rigidColor.reflection.layoutIdentity).toBe(rigidColor.receiptIdentity);
    expect(skinColor.receiptIdentity).toBe(rigidColor.receiptIdentity);
    expect(skinColor.reflection.layoutIdentity).toBe(skinColor.receiptIdentity);
    expect(new Set([rigid.receiptIdentity, rigidColor.receiptIdentity])).toHaveLength(2);
  });
});

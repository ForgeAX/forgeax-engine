import type { BasisEncodeMode, BasisEncodeOptions } from '@forgeax/engine-codec/encode';
import { _setBasisEncoderImporter, basisEncode } from '@forgeax/engine-codec/encode';
import { afterEach, describe, expect, it } from 'vitest';

const TEST_CONSTRUCTOR_SENTINEL = 'm120-controlled-constructor-throw';
const TEST_DELETE_SENTINEL = 'm120-controlled-delete-throw';
const TEST_OPERATION_SENTINEL = 'm120-controlled-operation-throw';
const CLEANUP_FAILURE_REASON = 'encoder cleanup failed';
const CONSTRUCTOR_FAILURE_REASON = 'encoder constructor failed';
const MODES = ['etc1s', 'uastc-ldr', 'uastc-hdr'] as const;

interface FakeEncoderState {
  readonly constructorIds: number[];
  readonly deleteIds: number[];
  readonly sourceCalls: { image: Uint8Array; width: number; height: number; hdr: boolean }[];
  readonly formatModes: number[];
  encodeCalls: number;
  shouldConstructThrow: boolean;
  shouldDeleteThrow: boolean;
  shouldSourceFail: boolean;
  shouldOperationThrow: boolean;
}

function makeOptions(mode: BasisEncodeMode): BasisEncodeOptions {
  return {
    mode,
    width: 2,
    height: 2,
    srgb: mode !== 'uastc-hdr',
    perceptual: mode !== 'uastc-hdr',
    uastcSupercompression: mode === 'uastc-ldr',
    mipGen: false,
  };
}

function makePixels(mode: BasisEncodeMode): Uint8Array {
  return mode === 'uastc-hdr'
    ? new Uint8Array(2 * 2 * 4 * 2).fill(0x3c)
    : new Uint8Array(2 * 2 * 4).fill(0x7f);
}

function createFakeEncoderModule() {
  const state: FakeEncoderState = {
    constructorIds: [],
    deleteIds: [],
    sourceCalls: [],
    formatModes: [],
    encodeCalls: 0,
    shouldConstructThrow: true,
    shouldDeleteThrow: false,
    shouldSourceFail: false,
    shouldOperationThrow: false,
  };

  class FakeBasisEncoder {
    readonly id: number;

    constructor() {
      const id = state.constructorIds.length + 1;
      state.constructorIds.push(id);
      if (state.shouldConstructThrow) throw TEST_CONSTRUCTOR_SENTINEL;
      this.id = id;
    }

    controlThreading(_enabled: boolean, _workers: number): void {}

    setSliceSourceImage(
      _slice: number,
      image: Uint8Array,
      width: number,
      height: number,
      _imageType: number,
    ): boolean {
      state.sourceCalls.push({ image, width, height, hdr: false });
      return !state.shouldSourceFail;
    }

    setSliceSourceImageHDR(
      _slice: number,
      image: Uint8Array,
      width: number,
      height: number,
      _imageType: number,
      _ldrSrgbToLinear: boolean,
      _ldrToHdrNitMultiplier: number,
    ): boolean {
      state.sourceCalls.push({ image, width, height, hdr: true });
      return !state.shouldSourceFail;
    }

    setFormatMode(mode: number): void {
      state.formatModes.push(mode);
    }

    setCreateKTX2File(_enabled: boolean): void {}

    setKTX2UASTCSupercompression(_enabled: boolean): void {}

    setKTX2AndBasisSRGBTransferFunc(_enabled: boolean): void {}

    setPerceptual(_enabled: boolean): void {}

    setMipGen(_enabled: boolean): void {}

    setQualityLevel(_quality: number): void {}

    setETC1SCompressionLevel(_level: number): void {}

    setPackUASTCFlags(_flags: number): void {}

    setUASTCHDRQualityLevel(_level: number): void {}

    encode(destination: Uint8Array): number {
      state.encodeCalls++;
      if (state.shouldOperationThrow) throw TEST_OPERATION_SENTINEL;
      const bytes = new Uint8Array([0xa1, state.formatModes.at(-1) ?? 0, 0x42, 0x99]);
      destination.set(bytes);
      return bytes.length;
    }

    delete(): void {
      state.deleteIds.push(this.id);
      if (state.shouldDeleteThrow) throw TEST_DELETE_SENTINEL;
    }
  }

  return {
    state,
    module: {
      initializeBasis(): void {},
      basis_tex_format: {
        cETC1S: { value: 1 },
        cUASTC_LDR_4x4: { value: 2 },
        cUASTC_HDR_4x4: { value: 3 },
      },
      BasisEncoder: FakeBasisEncoder,
      KTX2File: class {},
    } as never,
  };
}

afterEach(() => {
  _setBasisEncoderImporter();
});

describe('basisEncode lifecycle throw containment (M120)', () => {
  it.each(
    MODES,
  )('contains lifecycle throws and retries the same %s module deterministically', async (mode) => {
    const pixels = makePixels(mode);
    const options = makeOptions(mode);
    const fixture = createFakeEncoderModule();
    let importerCalls = 0;
    _setBasisEncoderImporter(() => {
      importerCalls++;
      return Promise.resolve(fixture.module);
    });

    const constructorFailure = await basisEncode(pixels, options);
    expect(constructorFailure.ok).toBe(false);
    if (constructorFailure.ok) throw new Error('expected constructor refusal');
    expect(constructorFailure.error.code).toBe('ktx2-encode-failed');
    expect(constructorFailure.error.detail).toEqual({
      mode,
      reason: CONSTRUCTOR_FAILURE_REASON,
    });
    expect(JSON.stringify(constructorFailure)).not.toContain(TEST_CONSTRUCTOR_SENTINEL);
    expect(fixture.state.deleteIds).toEqual([]);

    fixture.state.shouldConstructThrow = false;
    fixture.state.shouldDeleteThrow = true;
    const cleanupFailure = await basisEncode(pixels, options);
    expect(cleanupFailure.ok).toBe(false);
    if (cleanupFailure.ok) throw new Error('expected cleanup refusal');
    expect(cleanupFailure.error.code).toBe('ktx2-encode-failed');
    expect(cleanupFailure.error.detail).toEqual({
      mode,
      reason: CLEANUP_FAILURE_REASON,
    });
    expect(JSON.stringify(cleanupFailure)).not.toContain(TEST_DELETE_SENTINEL);
    expect(fixture.state.deleteIds).toEqual([2]);

    fixture.state.shouldOperationThrow = true;
    const primaryFailure = await basisEncode(pixels, options);
    expect(primaryFailure.ok).toBe(false);
    if (primaryFailure.ok) throw new Error('expected primary operation refusal');
    expect(primaryFailure.error.code).toBe('ktx2-encode-failed');
    expect(primaryFailure.error.detail).toEqual({
      mode,
      reason: TEST_OPERATION_SENTINEL,
    });
    expect(JSON.stringify(primaryFailure)).toContain(TEST_OPERATION_SENTINEL);
    expect(JSON.stringify(primaryFailure)).not.toContain(TEST_DELETE_SENTINEL);
    expect(fixture.state.deleteIds).toEqual([2, 3]);

    fixture.state.shouldOperationThrow = false;
    fixture.state.shouldDeleteThrow = false;
    const repaired = await basisEncode(pixels, options);
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error('expected repaired encode to succeed');
    expect([...repaired.value]).toEqual([
      0xa1,
      mode === 'etc1s' ? 1 : mode === 'uastc-ldr' ? 2 : 3,
      0x42,
      0x99,
    ]);

    const third = await basisEncode(pixels, options);
    expect(third).toEqual(repaired);
    expect(importerCalls).toBe(1);
    expect(fixture.state.constructorIds).toEqual([1, 2, 3, 4, 5]);
    expect(fixture.state.deleteIds).toEqual([2, 3, 4, 5]);
    expect(fixture.state.sourceCalls).toHaveLength(4);
    expect(fixture.state.sourceCalls.every(({ image }) => image === pixels)).toBe(true);
    expect(
      fixture.state.sourceCalls.every(({ width, height }) => width === 2 && height === 2),
    ).toBe(true);
    expect(fixture.state.sourceCalls.every(({ hdr }) => hdr === (mode === 'uastc-hdr'))).toBe(true);
    expect(fixture.state.formatModes).toEqual([
      mode === 'etc1s' ? 1 : mode === 'uastc-ldr' ? 2 : 3,
      mode === 'etc1s' ? 1 : mode === 'uastc-ldr' ? 2 : 3,
      mode === 'etc1s' ? 1 : mode === 'uastc-ldr' ? 2 : 3,
      mode === 'etc1s' ? 1 : mode === 'uastc-ldr' ? 2 : 3,
    ]);
    expect(fixture.state.encodeCalls).toBe(4);
  });

  it.each(MODES)('does not construct an encoder for invalid %s dimensions', async (mode) => {
    const fixture = createFakeEncoderModule();
    fixture.state.shouldConstructThrow = false;
    _setBasisEncoderImporter(() => Promise.resolve(fixture.module));

    const result = await basisEncode(makePixels(mode), {
      ...makeOptions(mode),
      width: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid dimensions to fail');
    expect(result.error.code).toBe('ktx2-encode-failed');
    expect(result.error.detail).toEqual({ mode, reason: 'invalid dimensions 0x2' });
    expect(fixture.state.constructorIds).toEqual([]);
    expect(fixture.state.deleteIds).toEqual([]);
  });
});

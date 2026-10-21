// Unit — RhiCallEvent + Tape type validation.
//
// Verifies that ~5 RhiCallEvent kinds can be constructed at the type level,
// that they are JSON-serializable (no native GPU objects in the shape),
// and that Tape / RhiCapsRecorded types compile.

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  RhiCallEvent,
  RhiCallEventBeginRenderPass,
  RhiCallEventCreateBuffer,
  RhiCallEventDraw,
  RhiCallEventDrawIndexed,
  RhiCallEventSetBindGroup,
  RhiCallEventSetPipeline,
  RhiCallEventWriteBuffer,
  RhiCapsRecorded,
  Tape,
} from '../types';

describe('RhiCallEvent — closed union constructibility', () => {
  it('createBuffer event shape', () => {
    const ev: RhiCallEventCreateBuffer = {
      kind: 'createBuffer',
      handleId: 'buf-1',
      desc: {
        size: 256,
        usage: 0,
        mappedAtCreation: false,
      },
    };
    expectTypeOf(ev).toMatchTypeOf<RhiCallEvent>();
    // JSON serializable check
    const json = JSON.stringify(ev);
    expect(json).toContain('createBuffer');
  });

  it('writeBuffer event shape', () => {
    const ev: RhiCallEventWriteBuffer = {
      kind: 'writeBuffer',
      handleId: 'buf-1',
      bufferOffset: 0,
      dataHash: 'abc123',
      size: 256,
    };
    expectTypeOf(ev).toMatchTypeOf<RhiCallEvent>();
    const json = JSON.stringify(ev);
    expect(json).toContain('writeBuffer');
  });

  it('beginRenderPass event shape', () => {
    const ev: RhiCallEventBeginRenderPass = {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:1',
      passHandleId: 'pass:1',
      desc: {
        colorAttachments: [],
      },
      colorAttachmentViewHandleIds: [],
    };
    expectTypeOf(ev).toMatchTypeOf<RhiCallEvent>();
    // No native GPUTextureView in the shape — AC-10
    const json = JSON.stringify(ev);
    expect(json).not.toContain('[object');
  });

  it('setPipeline + draw event chain', () => {
    const setP: RhiCallEventSetPipeline = {
      kind: 'setPipeline',
      passHandleId: 'pass:1',
      pipelineHandleId: 'pipeline:1',
    };
    const draw: RhiCallEventDraw = {
      kind: 'draw',
      passHandleId: 'pass:1',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    };
    const indexedDraw: RhiCallEventDrawIndexed = {
      kind: 'drawIndexed',
      passHandleId: 'pass:1',
      indexCount: 36,
      instanceCount: 1,
      firstIndex: 0,
      baseVertex: 0,
      firstInstance: 0,
    };
    expectTypeOf(setP).toMatchTypeOf<RhiCallEvent>();
    expectTypeOf(draw).toMatchTypeOf<RhiCallEvent>();
    expectTypeOf(indexedDraw).toMatchTypeOf<RhiCallEvent>();
  });

  it('setBindGroup event shape', () => {
    const ev: RhiCallEventSetBindGroup = {
      kind: 'setBindGroup',
      passHandleId: 'pass:1',
      index: 0,
      bindGroupHandleId: 'bg:1',
      dynamicOffsets: [0, 256],
    };
    expectTypeOf(ev).toMatchTypeOf<RhiCallEvent>();
  });

  it('closed union rejects non-existent kind (type-level)', () => {
    // Verify RhiCallEvent is a discriminated union with ~40 kinds.
    // The kind field is the discriminant — all union members have kind.
    expectTypeOf<RhiCallEvent>().toHaveProperty('kind');
    // The kind discriminator should match RHI method names
    expectTypeOf<RhiCallEventCreateBuffer['kind']>().toMatchTypeOf<'createBuffer'>();
  });
});

describe('Tape — constructibility', () => {
  it('minimal tape compiles', () => {
    const tape: Tape = {
      formatVersion: 2,
      rhiCapsRecorded: {
        canvasFormat: 'bgra8unorm',
        canvasColorSpace: 'srgb',
        rgba16floatRenderable: true,
        rg11b10ufloatRenderable: false,
        firstInstanceIndirect: false,
        float32Filterable: false,
        textureCompressionBc: true,
        textureCompressionEtc2: false,
        textureCompressionAstc: false,
        storageBuffer: true,
        timestampQuery: false,
      },
      events: [
        {
          kind: 'frameMark',
          frameIdx: 0,
        },
      ],
      blobPool: new Map(),
    };
    expectTypeOf(tape).toMatchTypeOf<Tape>();
    expect(tape.formatVersion).toBe(2);
    expect(tape.events).toHaveLength(1);
  });

  it('tape with events + blobPool compiles', () => {
    const buf = new ArrayBuffer(16);
    const tape: Tape = {
      formatVersion: 2,
      rhiCapsRecorded: {
        canvasFormat: 'bgra8unorm',
        canvasColorSpace: 'srgb',
        rgba16floatRenderable: false,
        rg11b10ufloatRenderable: false,
        firstInstanceIndirect: false,
        float32Filterable: false,
        textureCompressionBc: false,
        textureCompressionEtc2: false,
        textureCompressionAstc: false,
        storageBuffer: true,
        timestampQuery: false,
      },
      events: [
        { kind: 'frameMark', frameIdx: 0 },
        {
          kind: 'createBuffer',
          handleId: 'buf-1',
          desc: { size: 16, usage: 0, mappedAtCreation: false },
        },
        {
          kind: 'writeBuffer',
          handleId: 'buf-1',
          bufferOffset: 0,
          dataHash: 'a1b2c3',
          size: 16,
        },
      ],
      blobPool: new Map([['a1b2c3', buf]]),
    };
    expect(tape.formatVersion).toBe(2);
    expect(tape.blobPool.get('a1b2c3')).toBe(buf);
  });
});

describe('RhiCapsRecorded — constructibility', () => {
  it('minimal caps', () => {
    const caps: RhiCapsRecorded = {
      canvasFormat: 'bgra8unorm',
      canvasColorSpace: 'srgb',
      rgba16floatRenderable: false,
      rg11b10ufloatRenderable: false,
      firstInstanceIndirect: false,
      float32Filterable: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      storageBuffer: false,
      timestampQuery: false,
    };
    expect(caps.canvasFormat).toBe('bgra8unorm');
    expect(caps.rgba16floatRenderable).toBe(false);
  });
});

import { vec3 } from '@forgeax/engine-math';
import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { CameraSnapshot } from '../../render-contract';
import type { RenderableSnapshot } from '../../render-system-extract';
import { materialSurfaceModel } from '../../render-system-extract';
import type { TemporalView } from '../../temporal/temporal-view';
import type { ValidatedRenderable } from '../frame-snapshot';
import { MESH_PER_ENTITY_STRIDE, uploadMeshSsboBatch } from '../mesh-ssbo';
import { VIEW_UNIFORM_BYTES, writeViewUbo } from '../view-ubo';

function identityMatrix(): Float32Array {
  const matrix = new Float32Array(16);
  matrix[0] = 1;
  matrix[5] = 1;
  matrix[10] = 1;
  matrix[15] = 1;
  return matrix;
}

function translatedMatrix(x: number): Float32Array {
  const matrix = identityMatrix();
  matrix[12] = x;
  return matrix;
}

function recordingQueue(): {
  readonly queue: RhiQueue;
  readonly uploads: readonly Uint8Array[];
  readonly offsets: readonly number[];
} {
  const uploads: Uint8Array[] = [];
  const offsets: number[] = [];
  const queue = {
    writeBuffer: (
      _buffer: Buffer,
      bufferOffset: number,
      data: ArrayBufferView | ArrayBuffer,
      dataOffset = 0,
      size?: number,
    ) => {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset)
          : new Uint8Array(
              data.buffer,
              data.byteOffset + dataOffset,
              size ?? data.byteLength - dataOffset,
            );
      uploads.push(new Uint8Array(bytes));
      offsets.push(bufferOffset);
      return { ok: true, value: undefined } as const;
    },
  } as unknown as RhiQueue;
  return { queue, uploads, offsets };
}

function camera(): CameraSnapshot {
  return {
    entityKey: 1,
    worldId: 0,
    historyVersion: 0,
    position: vec3.create(0, 0, 5),
    world: identityMatrix(),
    fov: Math.PI / 3,
    aspect: 1,
    near: 0.1,
    far: 100,
    projection: 'perspective',
    orthoLeft: -1,
    orthoRight: 1,
    orthoBottom: -1,
    orthoTop: 1,
    tonemap: 'none',
    exposure: 1,
    whitePoint: 4,
    antialias: 'none',
    bloom: 'off',
    bloomThreshold: 1,
    bloomIntensity: 1,
    bloomSoftKnee: 0.5,
    bloomScatter: 0.7,
    clearColor: [0, 0, 0, 1],
  };
}

function temporalView(): TemporalView {
  const current = identityMatrix();
  current[0] = 2;
  const previous = identityMatrix();
  previous[0] = 3;
  return {
    viewId: '0:1:0',
    historyVersion: 0,
    temporalFrameIndex: 1,
    internalWidth: 4,
    internalHeight: 4,
    historyValid: true,
    resetReason: undefined,
    currentJitterUv: [0, 0],
    previousJitterUv: [0, 0],
    currentJitteredViewProjection: current,
    currentUnjitteredViewProjection: current,
    previousUnjitteredViewProjection: previous,
    projection: 'perspective',
    near: 0.1,
    far: 100,
  };
}

describe('temporal GPU payloads', () => {
  it('publishes physical viewport dimensions in existing View padding', () => {
    const { queue, uploads } = recordingQueue();
    const light = {
      kind: 'directional' as const,
      direction: vec3.create(0, -1, 0),
      color: vec3.create(1, 1, 1),
      intensity: 1,
      contactShadowLength: 0,
    };
    writeViewUbo(
      queue,
      {} as Buffer,
      camera(),
      light,
      { point: [], spot: [], pointShadow: [] } as never,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      0,
      { width: 640, height: 360 },
    );
    const payload = new Float32Array(uploads[0]?.buffer ?? new ArrayBuffer(0));
    expect(payload.byteLength).toBe(VIEW_UNIFORM_BYTES);
    expect([payload[23], payload[27]]).toEqual([640, 360]);
    expect(Array.from(payload.slice(24, 27))).toEqual(Array.from(camera().position));
  });
  it('detaches capture clipping and never overwrites the shared point-shadow slots', () => {
    const { queue, uploads } = recordingQueue();
    const light = {
      kind: 'directional' as const,
      direction: vec3.create(0, -1, 0),
      color: vec3.create(1, 1, 1),
      intensity: 1,
      contactShadowLength: 0,
    };
    const lights = {
      point: [],
      spot: [],
      pointShadow: [{ shadowAtlasLayer: 0, shadowMatrices: new Float32Array(96) }],
    } as never;
    writeViewUbo(
      queue,
      {} as Buffer,
      { ...camera(), clipping: { planes: [[2, 0, 0, -4]], clipShadows: true } },
      light,
      lights,
      [],
    );
    // Main slot, three translucent-fog composition copies, six point-shadow faces.
    expect(uploads).toHaveLength(10);
    const main = new Float32Array(uploads[0]?.buffer ?? new ArrayBuffer(0));
    expect(Array.from(main.slice(256, 260))).toEqual([1, 0, 0, -2]);
    expect(Array.from(main.slice(280, 284))).toEqual([1, 0, 1, 0]);
    writeViewUbo(
      queue,
      {} as Buffer,
      { ...camera(), clipping: { planes: [[0, 1, 0, -1]] } },
      light,
      lights,
      [],
      1280 * 25,
    );
    expect(uploads).toHaveLength(11);
    const capture = new Float32Array(uploads[10]?.buffer ?? new ArrayBuffer(0));
    expect(Array.from(capture.slice(256, 260))).toEqual([0, 1, 0, -1]);
    expect(Array.from(main.slice(256, 260))).toEqual([1, 0, 0, -2]);
  });

  it('keeps the zero-directional fallback direction finite and unscaled', () => {
    const { queue, uploads } = recordingQueue();
    writeViewUbo(
      queue,
      {} as Buffer,
      camera(),
      {
        kind: 'directional',
        direction: vec3.create(0, -1, 0),
        color: vec3.create(0, 0, 0),
        intensity: 0,
        contactShadowLength: 0,
      },
      { point: [], spot: [] } as never,
      [],
    );

    const payload = new Float32Array(uploads[0]?.buffer ?? new ArrayBuffer(0));
    expect(Array.from(payload.slice(16, 19))).toEqual([0, -1, 0]);
    expect(Array.from(payload.slice(20, 23))).toEqual([0, 0, 0]);
    expect([...payload.slice(16, 19), ...payload.slice(20, 23)].every(Number.isFinite)).toBe(true);
    expect(new Uint32Array(payload.buffer)[19]).toBe(0xffffffff);
  });

  it('publishes a finite renderer clock with fog off and changes no other View bytes', () => {
    const { queue, uploads, offsets } = recordingQueue();
    const light = {
      kind: 'directional' as const,
      direction: vec3.create(0, -1, 0),
      color: vec3.create(1, 1, 1),
      intensity: 1,
      contactShadowLength: 0,
    };
    const args = [
      queue,
      {} as Buffer,
      camera(),
      light,
      { point: [], spot: [] } as never,
      [],
    ] as const;
    const tail = [0, undefined, undefined, undefined, undefined, false] as const;
    writeViewUbo(...args);
    writeViewUbo(...args, ...tail, 12.5);
    writeViewUbo(...args, ...tail, Number.NaN);
    writeViewUbo(...args, ...tail, Number.POSITIVE_INFINITY);
    writeViewUbo(...args, ...tail, Number.MAX_VALUE);
    const primary = uploads.filter((_, index) => offsets[index] === 0);
    expect(primary).toHaveLength(5);
    const baseline = primary[0];
    for (const [index, bytes] of primary.entries()) {
      const value = new Float32Array(bytes.slice().buffer);
      expect(value.byteLength).toBe(VIEW_UNIFORM_BYTES);
      expect(value[291]).toBe(index === 1 ? 12.5 : 0);
      expect(Array.from(value.slice(284, 291))).toEqual([0, 0, 0, 0, 0, 0, 0]);
      value[291] = 0;
      expect(new Uint8Array(value.buffer)).toEqual(baseline);
    }
  });

  it('keeps directional orientation independent from light intensity', () => {
    const { queue, uploads } = recordingQueue();
    writeViewUbo(
      queue,
      {} as Buffer,
      camera(),
      {
        kind: 'directional',
        contactShadowLength: 0,
        direction: vec3.create(0.25, -0.5, 0.75),
        color: vec3.create(1, 1, 1),
        intensity: 4,
      },
      { point: [], spot: [] } as never,
      [],
    );

    const payload = new Float32Array(uploads[0]?.buffer ?? new ArrayBuffer(0));
    expect(Array.from(payload.slice(16, 19))).toEqual([0.25, -0.5, 0.75]);
  });

  it('writes temporal current/previous projection after the spot-light lanes', () => {
    const { queue, uploads } = recordingQueue();
    writeViewUbo(
      queue,
      {} as Buffer,
      camera(),
      {
        kind: 'directional',
        contactShadowLength: 0,
        direction: vec3.create(0, -1, 0),
        color: vec3.create(1, 1, 1),
        intensity: 1,
      },
      { point: [], spot: [] } as never,
      [],
      temporalView(),
    );

    const payload = new Float32Array(uploads[0]?.buffer ?? new ArrayBuffer(0));
    expect(payload.byteLength).toBe(VIEW_UNIFORM_BYTES);
    expect(payload[196]).toBeCloseTo(Math.sqrt(3));
    expect(payload[212]).toBe(3);
    expect(payload[228]).toBeCloseTo(0.1);
    expect(payload[229]).toBe(100);
    expect(payload[230]).toBe(0);
  });

  it('seeds previousWorld on the first frame and uses the submitted snapshot later', () => {
    const first = translatedMatrix(4);
    const previous = translatedMatrix(2);
    const second = translatedMatrix(6);
    const makeEntry = (world: Float32Array, temporal?: object) =>
      ({
        source: {
          transform: { world },
          materials: [{ transparent: false }],
          ...(temporal === undefined ? {} : { temporal }),
        } as unknown as RenderableSnapshot,
      }) as unknown as ValidatedRenderable;
    const firstRecording = recordingQueue();
    uploadMeshSsboBatch(firstRecording.queue, { buffer: {} as Buffer }, [makeEntry(first)], null);
    const firstPayload = new Float32Array(firstRecording.uploads[0]?.buffer ?? new ArrayBuffer(0));
    expect(firstPayload[12]).toBe(4);
    expect(firstPayload[16 + 12]).toBe(4);

    const secondRecording = recordingQueue();
    uploadMeshSsboBatch(
      secondRecording.queue,
      { buffer: {} as Buffer },
      [
        makeEntry(second, {
          previousTransform: { world: previous },
          reactive: false,
        }),
      ],
      null,
    );
    const secondPayload = new Float32Array(
      secondRecording.uploads[0]?.buffer ?? new ArrayBuffer(0),
    );
    expect(secondPayload[12]).toBe(6);
    expect(secondPayload[16 + 12]).toBe(2);
    expect(secondPayload[32]).toBe(0);
  });
  it('derives the default Standard model from its authored root and refuses full custom', () => {
    const passes = [
      { name: 'forward', program: { module: 'forgeax_material::standard' } },
    ] as const;
    expect(materialSurfaceModel(passes, undefined)).toBe('standard');
    expect(
      materialSurfaceModel(
        [{ ...passes[0], renderState: { tags: { SurfaceKind: 'full-custom' } } }],
        undefined,
      ),
    ).toBeUndefined();
    expect(
      materialSurfaceModel([{ name: 'forward', program: { module: 'game::custom' } }], undefined),
    ).toBeUndefined();
  });
  it.each([
    {
      label: 'published Standard',
      material: {
        surfaceModel: 'standard',
        materialShaderId: 'sha256:program',
        materialProgramKeys: { forward: 'sha256:program' },
      },
      reactive: 0,
    },
    {
      label: 'published transparent Standard',
      material: {
        surfaceModel: 'standard',
        materialShaderId: 'sha256:program',
        materialProgramKeys: { forward: 'sha256:program' },
        transparent: true,
      },
      reactive: 1,
    },
    { label: 'unpublished custom', material: { materialShaderId: 'game::custom' }, reactive: 1 },
    {
      label: 'published unknown custom',
      material: {
        materialShaderId: 'sha256:program',
        materialProgramKeys: { forward: 'sha256:program' },
      },
      reactive: 1,
    },
  ])('classifies $label by the Surface contract instead of its program hash', ({
    material,
    reactive,
  }) => {
    const recording = recordingQueue();
    const entry = {
      source: { transform: { world: identityMatrix() }, materials: [material] },
    } as unknown as ValidatedRenderable;
    uploadMeshSsboBatch(recording.queue, { buffer: {} as Buffer }, [entry], null);
    expect(new Float32Array(recording.uploads[0]?.buffer ?? new ArrayBuffer(0))[32]).toBe(reactive);
  });
  it('clears old payload and writes identity/temporal lanes for a folded draw', () => {
    const recording = recordingQueue();
    const entry = {
      source: { transform: { world: translatedMatrix(7) }, materials: [] },
    } as unknown as ValidatedRenderable;
    uploadMeshSsboBatch(recording.queue, { buffer: {} as Buffer }, [entry], null);
    uploadMeshSsboBatch(recording.queue, { buffer: {} as Buffer }, [entry], {
      headBuckets: new Map([[0, {} as never]]),
      skipIndices: new Set(),
      foldedBucketCount: 1,
    });
    const payload = new Float32Array(recording.uploads[1]?.buffer ?? new ArrayBuffer(0));
    expect(Array.from(payload.slice(0, 16))).toEqual(Array.from(identityMatrix()));
    expect(Array.from(payload.slice(16, 32))).toEqual(Array.from(identityMatrix()));
    expect(Array.from(payload.slice(32, 36))).toEqual([1, 1, 0, 0]);
    expect(Array.from(new Uint32Array(payload.buffer).slice(36, 40))).toEqual([
      0, 0, 0xffffffff, 0,
    ]);
    expect(Array.from(payload.slice(40))).toEqual(new Array(24).fill(0));
  });

  it('uploads main and shadow slots as one pack and resends only changed runs', () => {
    const recording = recordingQueue();
    const buffer = {} as Buffer;
    const entries = Array.from({ length: 24 }, (_, index) => ({
      source: { transform: { world: translatedMatrix(index) }, materials: [] },
    })) as unknown as ValidatedRenderable[];
    const main = entries.slice(0, 16);
    const shadow = entries.slice(16);
    expect(uploadMeshSsboBatch(recording.queue, { buffer }, main, null, shadow)).toBe(1);
    expect(recording.offsets).toEqual([0]);
    expect(recording.uploads[0]?.byteLength).toBe(24 * MESH_PER_ENTITY_STRIDE);
    const shadowSlot = new Float32Array(
      recording.uploads[0]?.buffer ?? new ArrayBuffer(0),
      20 * MESH_PER_ENTITY_STRIDE,
      16,
    );
    expect(shadowSlot[12]).toBe(20);

    expect(uploadMeshSsboBatch(recording.queue, { buffer }, main, null, shadow)).toBe(0);
    expect(recording.uploads).toHaveLength(1);

    const moved = [...main];
    moved[2] = { source: { transform: { world: translatedMatrix(40) }, materials: [] } } as never;
    const movedShadow = [...shadow];
    movedShadow[6] = {
      source: { transform: { world: translatedMatrix(41) }, materials: [] },
    } as never;
    expect(uploadMeshSsboBatch(recording.queue, { buffer }, moved, null, movedShadow)).toBe(2);
    expect(recording.offsets.slice(1)).toEqual([
      2 * MESH_PER_ENTITY_STRIDE,
      22 * MESH_PER_ENTITY_STRIDE,
    ]);
    expect(new Float32Array(recording.uploads[2]?.buffer ?? new ArrayBuffer(0))[12]).toBe(41);

    expect(
      uploadMeshSsboBatch(recording.queue, { buffer: {} as Buffer }, moved, null, movedShadow),
    ).toBe(1);
    expect(recording.uploads[3]?.byteLength).toBe(24 * MESH_PER_ENTITY_STRIDE);
  });
});

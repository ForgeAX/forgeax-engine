import type { Buffer, RenderPipeline } from '@forgeax/engine-rhi';
import { expect, it, vi } from 'vitest';
import { markPositionOnlyMeshPipeline, PassMeshVertexBindings } from '../mesh-vertex-streams';

it('preserves independent physical slots across full, position and replacement draws', () => {
  const setVertexBuffer = vi.fn();
  const bindings = new PassMeshVertexBindings({ setVertexBuffer });
  const a = {} as Buffer;
  const b = {} as Buffer;
  const narrow = {} as RenderPipeline;
  markPositionOnlyMeshPipeline(narrow);
  const streams = [
    { offset: 0, size: 48 },
    { offset: 48, size: 32 },
  ];
  bindings.bind(a, streams);
  bindings.bind(a, streams, narrow);
  bindings.bindSingle(b);
  bindings.bind(a, streams);
  bindings.bind(b, streams, narrow);
  bindings.bind(b, streams);
  bindings.bind(b, [
    { offset: 0, size: 24 },
    { offset: 24, size: 32 },
  ]);
  expect(setVertexBuffer.mock.calls).toEqual([
    [0, a, 0, 48],
    [1, a, 48, 32],
    [0, b],
    [0, a, 0, 48],
    [0, b, 0, 48],
    [1, b, 48, 32],
    [0, b, 0, 24],
    [1, b, 24, 32],
  ]);
});

it('compares physical ranges slot by slot, including edits on a reused range list', () => {
  const setVertexBuffer = vi.fn();
  const bindings = new PassMeshVertexBindings({ setVertexBuffer });
  const buffer = {} as Buffer;
  const narrow = {} as RenderPipeline;
  markPositionOnlyMeshPipeline(narrow);
  const streams = [
    { offset: 0, size: 24 },
    { offset: 24, size: 32 },
    { offset: 56, size: 48 },
  ];
  bindings.bind(buffer, streams);
  setVertexBuffer.mockClear();
  bindings.bind(
    buffer,
    streams.map((range) => ({ ...range })),
  );
  streams[1] = { offset: 32, size: 24 };
  bindings.bind(buffer, streams, narrow);
  expect(setVertexBuffer).not.toHaveBeenCalled();
  bindings.bind(buffer, streams);
  streams[2] = { offset: 56, size: 32 };
  bindings.bind(buffer, streams);
  expect(setVertexBuffer.mock.calls).toEqual([
    [1, buffer, 32, 24],
    [2, buffer, 56, 32],
  ]);
});

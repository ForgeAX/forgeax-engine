import { describe, expect, it } from 'vitest';
import { EVENT_SEMANTICS, eventKinds, isWorkEvent } from '../protocol/event-semantics';
import type { RhiCallEvent, Tape } from '../protocol/types';
import { validateTape } from '../protocol/validation';

function tape(events: readonly RhiCallEvent[]): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: events.length, blobCount: 0 },
    bootstrap: [],
    events,
    blobs: [],
  };
}

describe('event semantics coverage', () => {
  it('has one semantic entry for every closed event kind', () => {
    expect(Object.keys(EVENT_SEMANTICS).sort()).toEqual([...eventKinds].sort());
  });

  it('counts direct, indexed, indirect, and compute work without draw aliases', () => {
    expect(
      [
        'draw',
        'drawIndexed',
        'drawIndirect',
        'drawIndexedIndirect',
        'dispatchWorkgroups',
        'dispatchWorkgroupsIndirect',
      ].every((kind) => isWorkEvent(kind as never)),
    ).toBe(true);
    expect(isWorkEvent('beginRenderPass')).toBe(false);
  });

  it('reads nested copy endpoints and writes only the destination', () => {
    const copy: RhiCallEvent = {
      kind: 'copyBufferToTexture',
      cmdHandleId: 'encoder:1',
      source: { bufferHandleId: 'buffer:src' },
      destination: { textureHandleId: 'texture:dst' },
      copySize: { width: 1 },
    };
    expect(EVENT_SEMANTICS[copy.kind].read(copy)).toEqual(['buffer:src', 'texture:dst']);
    expect(EVENT_SEMANTICS[copy.kind].written(copy)).toEqual(['texture:dst']);
  });

  it('validates in-frame auto-layout pipelines and undeclared draw-state handles', () => {
    const shader: RhiCallEvent = {
      kind: 'createShaderModule',
      handleId: 'shader:1',
      wgslCode: '',
    };
    const pipeline: RhiCallEvent = {
      kind: 'createRenderPipeline',
      handleId: 'pipeline:1',
      layoutHandleId: 'layout:auto',
      vertexShaderModuleHandleId: 'shader:1',
      desc: { vertex: { entryPoint: 'main', buffers: [] } },
    };
    expect(validateTape(tape([shader, pipeline])).ok).toBe(true);
    const unbound = validateTape(
      tape([
        { kind: 'createCommandEncoder', cmdHandleId: 'encoder:1', desc: {} },
        {
          kind: 'beginRenderPass',
          cmdHandleId: 'encoder:1',
          passHandleId: 'pass:1',
          desc: { colorAttachments: [] },
          colorAttachmentViewHandleIds: [],
        },
        { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'pipeline:missing' },
      ]),
    );
    expect(unbound.ok).toBe(false);
  });
});

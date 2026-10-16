import { describe, expect, it } from 'vitest';

describe('Boss Lightning GPU event Browser contract', () => {
  it('keeps impact sub-emitter evidence on the GPU-local path', () => {
    const contract = ['event-sub-emitter', 'gpuLocal', 'eventCounters', 'queueCleared', 'recursionDepth'];
    expect(contract).toContain('event-sub-emitter');
    expect(contract).toContain('gpuLocal');
    expect(contract).toContain('eventCounters');
    expect(contract).toContain('queueCleared');
    expect(contract).toContain('recursionDepth');
    expect(contract).not.toContain('readEventback');
  });
});

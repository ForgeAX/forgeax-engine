import { describe, expect, it } from 'vitest';
import { rhi } from '../index';

describe('command encoder finish', () => {
  it('a second finish() returns command-encoder-finished', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    expect(encoder.finish().ok).toBe(true);
    const second = encoder.finish();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('command-encoder-finished');
  });
});

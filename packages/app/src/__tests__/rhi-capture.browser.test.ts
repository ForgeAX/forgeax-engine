/// <reference types="@webgpu/types" />

import { attachRecorder, decodeTape, type RecordableBackend } from '@forgeax/engine-rhi-debug';
import { describe, expect, it } from 'vitest';
import { createRhiCapture } from '../internal/rhi-capture';

const GPU_AVAILABLE = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
  label: string,
): T {
  if (result.ok) return result.value;
  const error = result.error as { readonly code?: unknown; readonly hint?: unknown };
  throw new Error(`${label}: ${String(error.code ?? 'unknown')} ${String(error.hint ?? '')}`);
}

describe.skipIf(!GPU_AVAILABLE)('App RHI capture capability in a real browser', () => {
  it('returns one digest-bearing artifact through the typed App capability', async () => {
    const backend = (await import('@forgeax/engine-rhi-webgpu')) as unknown as RecordableBackend;
    const attached = must(attachRecorder(backend), 'attachRecorder');
    const adapter = must(await attached.backend.rhi.requestAdapter(), 'requestAdapter');
    const device = must(await adapter.requestDevice(), 'requestDevice');
    const buffer = must(device.createBuffer({ size: 16, usage: 0x28 }), 'create buffer');

    must(device.queue.writeBuffer(buffer, 0, new Uint8Array(16)), 'seed buffer before capture');
    const capture = createRhiCapture(attached);
    const pending = capture.captureFrame();
    must(await attached.frameBoundary(), 'capture snapshot boundary');
    const encoder = must(device.createCommandEncoder({}), 'create command encoder');
    encoder.clearBuffer(buffer, 0, 16);
    const command = must(encoder.finish(), 'finish command encoder');
    must(device.queue.submit([command]), 'submit command buffer');
    await device.queue.onSubmittedWorkDone();
    must(await attached.frameBoundary(), 'capture recording boundary');

    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.hint);
    expect(result.value.kind).toBe('rhi-tape');
    expect(result.value.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const decoded = decodeTape(result.value.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.error.hint);
    expect(decoded.value.header.formatVersion).toBe(7);
    expect(decoded.value.events.some((event) => event.kind === 'clearBuffer')).toBe(true);
    await attached.dispose();
  }, 60_000);
});

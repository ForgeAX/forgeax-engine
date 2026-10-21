import type { VfxGpuEmitterProgram, VfxGpuTickIntent } from '@forgeax/engine-vfx';

export const VFX_EVENT_INPUT_BYTES = 32;
export const VFX_EVENT_BYTES = 32;

function channelFanOut(emitter: VfxGpuEmitterProgram, channel: string): number {
  return Math.max(
    1,
    ...(emitter.events ?? [])
      .filter((event) => event.channel === channel)
      .map((event) => event.fanOut),
  );
}

export function eventInputCapacity(emitter: VfxGpuEmitterProgram): number {
  return Math.max(
    1,
    (emitter.channels ?? []).reduce((total, channel) => total + channel.capacity, 0),
  );
}

export function eventCapacity(emitter: VfxGpuEmitterProgram): number {
  const capacity = (emitter.channels ?? []).reduce(
    (total, channel) => total + channel.capacity * channelFanOut(emitter, channel.id),
    0,
  );
  return Math.max(1, Math.min(emitter.capacity, capacity));
}

function channelKey(channel: string): number {
  let hash = 2166136261;
  for (const code of channel) {
    hash ^= code.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function encodeEventInputs(
  intent: Pick<VfxGpuTickIntent, 'emitter' | 'channelInputs'>,
): Uint8Array {
  const capacity = eventInputCapacity(intent.emitter);
  const data = new ArrayBuffer(capacity * VFX_EVENT_INPUT_BYTES);
  const bytes = new Uint8Array(data);
  bytes.fill(0xff);
  const view = new DataView(data);
  for (const [index, input] of intent.channelInputs.entries()) {
    if (index >= capacity) break;
    const offset = index * VFX_EVENT_INPUT_BYTES;
    view.setFloat32(offset, input.payload.position[0], true);
    view.setFloat32(offset + 4, input.payload.position[1], true);
    view.setFloat32(offset + 8, input.payload.position[2], true);
    view.setFloat32(offset + 16, input.payload.strength, true);
    view.setUint32(offset + 20, input.sequence, true);
    view.setUint32(offset + 24, channelKey(input.channel), true);
    view.setUint32(offset + 28, channelFanOut(intent.emitter, input.channel), true);
  }
  return bytes;
}

/**
 * Pack the fixed-tick inputs and GPU-produced events into one typed storage
 * resource. The managed event kernel uses the reflected input capacity as the
 * split point; this keeps channel/sub-emitter semantics while leaving one
 * storage binding available for Custom-enabled emitters.
 */
export function encodeEventBuffer(
  intent: Pick<VfxGpuTickIntent, 'emitter' | 'channelInputs'>,
): Uint8Array {
  const inputBytes = encodeEventInputs(intent);
  const outputBytes = eventCapacity(intent.emitter) * VFX_EVENT_BYTES;
  const data = new Uint8Array(inputBytes.byteLength + outputBytes);
  data.set(inputBytes);
  return data;
}

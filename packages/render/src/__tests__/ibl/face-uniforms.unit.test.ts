import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import {
  createFaceUniformsBuffer,
  createPrefilterUniformsBuffer,
  writeAllFaceUniforms,
  writeAllPrefilterUniforms,
  writeFaceUniforms,
  writePrefilterUniforms,
} from '../../device/gpu-residency';

async function createDevice() {
  const adapterResult = await new RhiNullAdapter().requestDevice();
  if (!adapterResult.ok) throw adapterResult.error;
  return adapterResult.value;
}

describe('IBL face uniform RHI contract', () => {
  it('allocates opaque buffers and writes all dynamic uniform slots', async () => {
    const device = await createDevice();
    const faceBuffer = createFaceUniformsBuffer(device);
    const prefilterBuffer = createPrefilterUniformsBuffer(device);

    expect(faceBuffer.ok).toBe(true);
    expect(prefilterBuffer.ok).toBe(true);
    if (!faceBuffer.ok || !prefilterBuffer.ok) return;

    expect(writeAllFaceUniforms(device, faceBuffer.value).ok).toBe(true);
    expect(writeAllPrefilterUniforms(device, prefilterBuffer.value).ok).toBe(true);
  });

  it('returns structured RHI errors for invalid uniform coordinates', async () => {
    const device = await createDevice();
    const bufferResult = createFaceUniformsBuffer(device);
    expect(bufferResult.ok).toBe(true);
    if (!bufferResult.ok) return;

    const badFace = writeFaceUniforms(device, bufferResult.value, 6, new Float32Array(16));
    const badMatrix = writeFaceUniforms(device, bufferResult.value, 0, new Float32Array(15));
    const badSubPass = writePrefilterUniforms(device, bufferResult.value, 30, 0.5, 128);
    const badMipCount = writePrefilterUniforms(device, bufferResult.value, 0, 0.5, 128, 0);

    expect(badFace).toMatchObject({ ok: false, error: { code: 'webgpu-runtime-error' } });
    expect(badMatrix).toMatchObject({ ok: false, error: { code: 'webgpu-runtime-error' } });
    expect(badSubPass).toMatchObject({ ok: false, error: { code: 'webgpu-runtime-error' } });
    expect(badMipCount).toMatchObject({ ok: false, error: { code: 'webgpu-runtime-error' } });
  });
});

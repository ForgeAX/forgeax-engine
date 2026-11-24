import { mkdir, writeFile } from 'node:fs/promises';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect, it } from 'vitest';
import { verifyCardContactCapture } from './card-contact-capture-gpu.fixture';

it('casts directional, point and spot shadows from actual canonical Card capture contact', async () => {
  const directory = process.env.FORGEAX_CARD_CONTACT_GPU;
  if (directory) await mkdir(directory, { recursive: true });
  const save = async (name: string, bytes: Uint8Array) => {
    if (directory) await writeFile(`${directory}/${name}`, bytes, { flush: true });
  };
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = device.nativeDevice().unwrap();
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  try {
    const result = await verifyCardContactCapture(device, webgpu.createShaderModule, save);
    await save(
      'summary.json',
      new TextEncoder().encode(JSON.stringify({ result, errors }, null, 2)),
    );
    expect(errors).toEqual([]);
  } finally {
    raw.destroy();
  }
}, 60000);

import { mkdir, writeFile } from 'node:fs/promises';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect, it } from 'vitest';
import {
  prepareCardIdentityFixture,
  verifyCardIdentity,
  verifyIdentityEdits,
  verifyIdentityMaterialCoverage,
  verifyIdentityNegativeControls,
} from './card-primitive-identity.fixture';

it('captures exact integer Card primitives with coherent material depth and untouched tiles', async () => {
  const fixture = await prepareCardIdentityFixture();
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory) await mkdir(directory, { recursive: true });
  const save = async (name: string, bytes: Uint8Array) => {
    if (directory)
      await writeFile(`${directory}/${name}${name.endsWith('.png') ? '' : '.bin'}`, bytes);
  };
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = device.nativeDevice().unwrap(),
    errors: string[] = [];
  assert(raw);
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    const actual = await verifyCardIdentity(device, webgpu.createShaderModule, fixture, save);
    await verifyIdentityNegativeControls(device, webgpu.createShaderModule, fixture, save);
    await verifyIdentityMaterialCoverage(device, webgpu.createShaderModule, fixture, save);
    const edits = await verifyIdentityEdits(device, webgpu.createShaderModule, fixture, save);
    await save(
      'summary',
      new TextEncoder().encode(
        JSON.stringify(
          {
            actual,
            edits,
            errors,
            scope:
              'Actual capture primitive identity only; no World visibility, physical shadow or whole GI acceptance.',
          },
          null,
          2,
        ),
      ),
    );
    expect(errors).toEqual([]);
  } finally {
    raw.destroy();
  }
}, 60000);

it('retains exact empty identity and coherent Card edits after material coverage', async () => {
  const fixture = await prepareCardIdentityFixture();
  const directory = process.env.FORGEAX_RAY_EVIDENCE;
  if (directory) await mkdir(directory, { recursive: true });
  const save = async (name: string, bytes: Uint8Array) => {
    if (directory)
      await writeFile(`${directory}/${name}${name.endsWith('.png') ? '' : '.bin'}`, bytes);
  };
  const device = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = device.nativeDevice().unwrap(),
    errors: string[] = [];
  assert(raw);
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    await verifyIdentityMaterialCoverage(device, webgpu.createShaderModule, fixture, save);
    const edits = await verifyIdentityEdits(device, webgpu.createShaderModule, fixture, save);
    await save(
      'summary',
      new TextEncoder().encode(
        JSON.stringify(
          {
            edits,
            errors,
            scope:
              'Exact empty identity, material coverage and edit isolation only; no World, physical shadow or whole GI acceptance.',
          },
          null,
          2,
        ),
      ),
    );
    expect(errors).toEqual([]);
  } finally {
    raw.destroy();
  }
}, 60000);

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it, vi } from 'vitest';
import { createSurfaceCapture } from '../../raytracing/surface-cards';
import {
  assessNumericPlanes,
  customCardSource,
  numericCardCases,
  numericCardFixture,
  numericReadback,
  numericTransform,
  numericView,
  saveNumericPlanes,
} from './custom-surface-cards.fixture';

it('qualifies static custom Card planes, mirrored context, updates and wrong-basis detection', async () => {
  const prepared = process.env.FORGEAX_CUSTOM_CARD_PREPARED;
  const preparedBytes = prepared ? await readFile(prepared) : undefined;
  const fixture: Awaited<ReturnType<typeof numericCardFixture>> = preparedBytes
    ? JSON.parse(preparedBytes.toString('utf8')).fixture
    : await numericCardFixture();
  const directory = process.env.FORGEAX_CUSTOM_CARD_EVIDENCE;
  if (directory) await mkdir(directory, { recursive: true });
  const recorder = attachRecorder(webgpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const errors: string[] = [];
  const native = device.nativeDevice().unwrap() as GPUDevice;
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const summaries: unknown[] = [];
  const projectionBuffers = new Set<unknown>();
  const create = device.createBuffer.bind(device);
  const writes = device.queue.writeBuffer.bind(device.queue);
  let wrongBasis = false;
  const createSpy = vi.spyOn(device, 'createBuffer').mockImplementation((desc) => {
    const buffer = create(desc);
    if (buffer.ok && desc.label === 'cards.projection') projectionBuffers.add(buffer.value);
    return buffer;
  });
  const writeSpy = vi
    .spyOn(device.queue, 'writeBuffer')
    .mockImplementation((buffer, offset, input, ...rest) => {
      if (!wrongBasis || !projectionBuffers.has(buffer))
        return writes(buffer, offset, input, ...rest);
      const bytes =
        input instanceof ArrayBuffer
          ? new Uint8Array(input).slice()
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
      const view = new DataView(bytes.buffer);
      for (let column = 0; column < 3; column++)
        for (let axis = 0; axis < 3; axis++)
          view.setFloat32(96 + column * 16 + axis * 4, Number(column === axis), true);
      return writes(buffer, offset, bytes, ...rest);
    });
  try {
    for (const c of numericCardCases) {
      const source = {
        ...fixture.source,
        instance: { ...fixture.source.instance, transform: numericTransform(c) },
      };
      const capture = (
        await createSurfaceCapture(device, recorder.backend.createShaderModule, [source], {
          kind: 'cards',
          resolution: 32,
        })
      ).unwrap();
      try {
        expect(capture.width).toBe(32);
        expect(capture.height).toBe(32);
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const planes = await numericReadback(device, capture);
        (await recorder.frameBoundary()).unwrap();
        const tape = (await pending).unwrap().bytes;
        const assessment = assessNumericPlanes(planes, c);
        summaries.push({
          name: c.name,
          ...assessment,
          tapeSha256: createHash('sha256').update(tape).digest('hex'),
        });
        await saveNumericPlanes(directory, c.name, planes, c);
        if (directory) await writeFile(join(directory, `${c.name}.rhitape`), tape);
        expect(assessment.invalid).toBe(0);
        expect(assessment.maximumError).toBeLessThanOrEqual(assessment.tolerance);
        const view = (
          await createSurfaceCapture(device, recorder.backend.createShaderModule, [source], {
            kind: 'view',
            resolution: 32,
            projection: numericView(c),
          })
        ).unwrap();
        try {
          const paired = await numericReadback(device, view);
          const assessment = assessNumericPlanes(paired, c);
          summaries.push({ name: `${c.name}-paired-raster-adapter`, ...assessment });
          expect(assessment.invalid).toBe(0);
          expect(assessment.maximumError).toBeLessThanOrEqual(assessment.tolerance);
          for (let i = 0; i < 4; i++) expect(paired[i]).toEqual(planes[i]);
        } finally {
          view.dispose();
        }
      } finally {
        capture.dispose();
      }
    }
    const c = {
      name: 'updated-mirrored',
      rotated: true,
      sx: -4,
      sy: 6,
      sz: 8,
      tx: -2,
      ty: 9,
      tz: 5,
    };
    const original = numericCardCases[2];
    const source = {
      ...fixture.source,
      instance: { ...fixture.source.instance, transform: numericTransform(original) },
    };
    const changed = (
      await createSurfaceCapture(device, recorder.backend.createShaderModule, [source], {
        kind: 'cards',
        resolution: 32,
      })
    ).unwrap();
    try {
      changed.retransform(7, numericTransform(c)).unwrap();
      const planes = await numericReadback(device, changed);
      const assessment = assessNumericPlanes(planes, c);
      summaries.push({ name: c.name, ...assessment });
      await saveNumericPlanes(directory, c.name, planes, c);
      expect(assessment.invalid).toBe(0);
      expect(assessment.maximumError).toBeLessThanOrEqual(assessment.tolerance);
    } finally {
      changed.dispose();
    }
    wrongBasis = true;
    const negative = (
      await createSurfaceCapture(
        device,
        recorder.backend.createShaderModule,
        [
          {
            ...fixture.source,
            instance: { ...fixture.source.instance, transform: numericTransform(original) },
          },
        ],
        { kind: 'cards', resolution: 32 },
      )
    ).unwrap();
    try {
      const planes = await numericReadback(device, negative);
      const assessment = assessNumericPlanes(planes, original);
      summaries.push({ name: 'negative-identity-basis', ...assessment });
      await saveNumericPlanes(directory, 'negative-identity-basis', planes, original);
      expect(assessment.maximumError).toBeGreaterThan(0.05);
    } finally {
      negative.dispose();
    }
    expect(errors).toEqual([]);
  } finally {
    writeSpy.mockRestore();
    createSpy.mockRestore();
    if (directory) {
      const fixtureBytes = await readFile(
        new URL('./custom-surface-cards.fixture.ts', import.meta.url),
      );
      const testBytes = await readFile(
        new URL('./custom-surface-cards.dawn.test.ts', import.meta.url),
      );
      await writeFile(
        join(directory, 'assessment.json'),
        JSON.stringify(
          {
            status: 'STATIC_CUSTOM_CARD_SUBDOMAIN',
            adapter: native.adapterInfo,
            sourceSha256: createHash('sha256').update(customCardSource).digest('hex'),
            fixtureSha256: createHash('sha256').update(fixtureBytes).digest('hex'),
            testSha256: createHash('sha256').update(testBytes).digest('hex'),
            programSha256: createHash('sha256').update(fixture.program.wgsl).digest('hex'),
            sourceClosureDigest: fixture.program.sourceClosureDigest,
            preparedSha256: preparedBytes
              ? createHash('sha256').update(preparedBytes).digest('hex')
              : undefined,
            summaries,
            errors,
            limits: [
              'Authored +Z face only',
              'Paired raster adapter is not the main Standard pass',
              'No textures, dynamic context, alpha or upstream GI qualification',
            ],
          },
          null,
          2,
        ),
      );
    }
    (await recorder.dispose()).unwrap();
  }
}, 90_000);

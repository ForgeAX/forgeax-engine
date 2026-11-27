import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { createSurfaceCapture } from '../../raytracing/surface-cards';
import { helperCardSource, staticClosureFixture } from './card-static-closure.fixture';
import {
  assessNumericPlanes,
  customCardSource,
  numericReadback,
  saveNumericPlanes,
} from './custom-surface-cards.fixture';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

it('renders an unreachable view/time helper with unchanged independently checked Card planes', async () => {
  const prepared = process.env.FORGEAX_CARD_CLOSURE_PREPARED;
  const preparedBytes = prepared ? await readFile(prepared) : undefined;
  const fixture: Awaited<ReturnType<typeof staticClosureFixture>> = preparedBytes
    ? JSON.parse(preparedBytes.toString('utf8')).fixture
    : await staticClosureFixture();
  const directory = process.env.FORGEAX_CARD_CLOSURE_EVIDENCE;
  if (directory) await mkdir(directory, { recursive: true });
  const recorder = attachRecorder(webgpu).unwrap();
  const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  const native = device.nativeDevice().unwrap() as GPUDevice;
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const summaries: unknown[] = [];
  let baseline: readonly Uint8Array[] | undefined;
  try {
    for (const [label, source] of [
      ['baseline', fixture.baseline],
      ['unreachable-helper', fixture.candidate],
    ] as const) {
      const capture = (
        await createSurfaceCapture(device, recorder.backend.createShaderModule, [source], {
          kind: 'cards',
          resolution: 32,
        })
      ).unwrap();
      try {
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const planes = await numericReadback(device, capture);
        (await recorder.frameBoundary()).unwrap();
        const tape = (await pending).unwrap().bytes;
        const assessment = assessNumericPlanes(planes, fixture.context);
        summaries.push({
          label,
          ...assessment,
          planeSha256: planes.map(sha),
          tapeSha256: sha(tape),
        });
        await saveNumericPlanes(directory, label, planes, fixture.context);
        if (directory) await writeFile(join(directory, `${label}.rhitape`), tape);
        expect(assessment.invalid).toBe(0);
        expect(assessment.maximumError).toBeLessThanOrEqual(assessment.tolerance);
        if (baseline === undefined) baseline = planes;
        else for (const [index, plane] of planes.entries()) expect(plane).toEqual(baseline[index]);
      } finally {
        capture.dispose();
      }
    }
    expect(errors).toEqual([]);
  } finally {
    if (directory)
      await writeFile(
        join(directory, 'assessment.json'),
        JSON.stringify(
          {
            status: 'STATIC_CARD_REACHABLE_CLOSURE_SUBDOMAIN',
            adapter: native.adapterInfo,
            baselineSourceSha256: sha(customCardSource),
            helperSourceSha256: sha(helperCardSource),
            baselineProgramSha256: sha(fixture.baselineProgram.wgsl),
            helperProgramSha256: sha(fixture.candidateProgram.wgsl),
            baselineClosure: fixture.baselineProgram.sourceClosureDigest,
            helperClosure: fixture.candidateProgram.sourceClosureDigest,
            preparedSha256: preparedBytes ? sha(preparedBytes) : undefined,
            fixtureSha256: sha(
              await readFile(new URL('./card-static-closure.fixture.ts', import.meta.url)),
            ),
            testSha256: sha(
              await readFile(new URL('./card-static-closure.dawn.test.ts', import.meta.url)),
            ),
            summaries,
            errors,
            limits: [
              'Authored +Z face only',
              'No textures, dynamic inputs, alpha or upstream GI qualification',
              'No performance measurement',
            ],
          },
          null,
          2,
        ),
      );
    (await recorder.dispose()).unwrap();
  }
}, 90_000);

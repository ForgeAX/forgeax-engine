import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { CARD_PLANES, createSurfaceCapture } from '../../raytracing/surface-cards';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { decodeNormal, half, readCardPlanes, sdfCubeInstance } from './sdf-cards.fixture';

/** Open/single-sided, thin/two-sided and MASK all use the shared material capture. */
export async function verifyCardCoverage(fixture: SdfCardsFixture) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const recorded = device as typeof device & { readonly _realDevice: typeof device };
  const raw = webgpu._internal_getRawDevice(recorded._realDevice),
    errors: string[] = [];
  assert(raw, 'the recorder must expose its real test-owned device');
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  try {
    const texture = device
      .createTexture({
        size: { width: 2, height: 1 },
        format: 'rgba8unorm',
        usage: 6,
        textureBindingViewDimension: '2d',
      })
      .unwrap();
    device.queue
      .writeTexture(
        { texture },
        new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255]),
        { bytesPerRow: 8 },
        { width: 2, height: 1 },
      )
      .unwrap();
    const view = device.createTextureView(texture, {}).unwrap(),
      sampler = device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' }).unwrap();
    const resolve = () => ok({ view, sampler });
    const [two, masked] = fixture.sheet.materials;
    assert(two && masked);
    const sheet = {
      ...sdfCubeInstance,
      positions: fixture.sheet.positions,
      indices: fixture.sheet.indices,
      uvSets: [[0, 0, 1, 0, 0, 1, 1, 1]],
    };
    const single = {
      instance: { ...sheet, instanceId: 1 },
      layout: fixture.sheet.one,
      sections: [
        { indexOffset: 0, indexCount: sheet.indices.length, material: { id: 0, ...fixture.card } },
      ],
    };
    const sources = [
      single,
      {
        instance: { ...sheet, instanceId: 2 },
        layout: fixture.sheet.two,
        sections: [
          { indexOffset: 0, indexCount: sheet.indices.length, material: { id: 0, ...two } },
        ],
      },
      {
        instance: { ...sheet, instanceId: 3 },
        layout: fixture.sheet.two,
        sections: [
          {
            indexOffset: 0,
            indexCount: sheet.indices.length,
            material: { id: 0, ...masked },
            textureContentKey: 'half-cutout:1',
          },
        ],
      },
      {
        instance: sdfCubeInstance,
        layout: fixture.layout,
        sections: [
          {
            indexOffset: 0,
            indexCount: sdfCubeInstance.indices.length,
            material: { id: 0, ...fixture.card },
          },
        ],
      },
    ];
    // A sidedness change must rebuild the geometry representation before capture.
    expect(
      (
        await createSurfaceCapture(
          device,
          recorder.backend.createShaderModule,
          [{ ...single, layout: fixture.sheet.two }],
          { kind: 'cards', resolution: 16 },
          resolve,
        )
      ).ok,
    ).toBe(false);
    const cards = (
      await createSurfaceCapture(
        device,
        recorder.backend.createShaderModule,
        sources,
        { kind: 'cards', resolution: 16 },
        resolve,
      )
    ).unwrap();
    expect(cards.entries.map((e) => e.projections.length)).toEqual([1, 2, 2, 6]);
    expect([cards.width, cards.height]).toEqual([64, 48]);
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    cards.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    const tapeBytes = (await capture).unwrap().bytes;
    const planes = await readCardPlanes(device, cards);
    const validity = planes[3],
      normals = planes[1],
      albedo = planes[0];
    assert(validity && normals && albedo);
    // A material cache records the geometric proxy; the same material's exact
    // view must still cut out its transparent half. Neither path edits the asset.
    const viewCounts: number[] = [];
    const exactViews: { tape: Uint8Array; planes: Uint8Array[] }[] = [];
    const maskedSource = sources[2];
    const maskedEntry = cards.entries.find((e) => e.instanceId === 3);
    assert(maskedSource && maskedEntry);
    for (const projection of maskedEntry.projections) {
      const captureView = (
        await createSurfaceCapture(
          device,
          recorder.backend.createShaderModule,
          [maskedSource],
          { kind: 'view', resolution: 16, projection },
          resolve,
        )
      ).unwrap();
      try {
        const viewCapture = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const commands = device.createCommandEncoder({}).unwrap();
        captureView.record(commands).unwrap();
        device.queue.submit([commands.finish().unwrap()]).unwrap();
        await device.queue.onSubmittedWorkDone();
        (await recorder.frameBoundary()).unwrap();
        const viewTape = (await viewCapture).unwrap().bytes;
        const viewPlanes = await readCardPlanes(device, captureView);
        exactViews.push({ tape: viewTape, planes: viewPlanes });
        const viewValidity = viewPlanes[3],
          viewAlbedo = viewPlanes[0];
        assert(viewValidity && viewAlbedo);
        let covered = 0;
        for (let y = 0; y < 16; y++)
          for (let x = 0; x < 16; x++) {
            const positionX =
              projection.origin[0] +
              (projection.u[0] * projection.width * (x + 0.5)) / 16 +
              (projection.v[0] * projection.height * (y + 0.5)) / 16;
            const expected = positionX < 0 ? 0 : 1;
            expect(half(viewValidity, (y * 16 + x) * 8 + 6)).toBe(expected);
            expect(half(viewAlbedo, (y * 16 + x) * 8)).toBeCloseTo(expected * 0.8, 3);
            covered += expected;
          }
        viewCounts.push(covered);
      } finally {
        captureView.dispose();
      }
    }
    expect(viewCounts).toEqual([128, 128]);
    const counts: number[] = [];
    let tile = 0;
    for (const entry of cards.entries)
      for (const projection of entry.projections) {
        let valid = 0;
        for (let y = 0; y < 16; y++)
          for (let x = 0; x < 16; x++) {
            const offset =
              ((Math.floor(tile / 4) * 16 + y) * cards.width + (tile % 4) * 16 + x) * 8;
            expect(half(validity, offset + 6)).toBe(1);
            valid++;
            expect(half(albedo, offset)).toBeCloseTo(0.8, 3);
            for (const pair of [0, 4]) {
              const n = decodeNormal(
                half(normals, offset + pair),
                half(normals, offset + pair + 2),
              );
              for (let axis = 0; axis < 3; axis++)
                expect(n[axis]).toBeCloseTo(projection.n[axis] ?? NaN, 3);
            }
          }
        counts.push(valid);
        tile++;
      }
    expect(counts).toEqual(Array(11).fill(256));
    for (let y = 32; y < 48; y++)
      for (let x = 48; x < 64; x++) expect(half(validity, (y * 64 + x) * 8 + 6)).toBe(0);
    cards.dispose();
    device.destroyTexture(texture);
    (await recorder.dispose()).unwrap();
    const tape = decodeTape(tapeBytes).unwrap(),
      model = buildFrameModel(tape);
    expect(model.works.length).toBe(11);
    const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const freshRaw = webgpu._internal_getRawDevice(fresh);
    assert(freshRaw, 'replay must own a new native device');
    freshRaw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      for (const i of CARD_PLANES.keys()) {
        const resource = model.works[10]?.attachments?.colorViewHandleIds[i];
        assert(resource);
        const bytes = (await replay.readResourceAtWork(resource, 10)).unwrap().bytes;
        expect(bytes).toEqual(planes[i]);
      }
    } finally {
      (await replay.dispose()).unwrap();
      freshRaw.destroy();
    }
    for (const exact of exactViews) {
      const viewTape = decodeTape(exact.tape).unwrap();
      const viewModel = buildFrameModel(viewTape);
      expect(viewModel.works).toHaveLength(1);
      const replayDevice = (
        await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()
      ).unwrap();
      const replayRaw = webgpu._internal_getRawDevice(replayDevice);
      assert(replayRaw);
      replayRaw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
      const viewReplay = (
        await openReplay(viewTape, {
          device: replayDevice,
          createShaderModule: webgpu.createShaderModule,
        })
      ).unwrap();
      try {
        for (const i of CARD_PLANES.keys()) {
          const resource = viewModel.works[0]?.attachments?.colorViewHandleIds[i];
          assert(resource);
          expect((await viewReplay.readResourceAtWork(resource, 0)).unwrap().bytes).toEqual(
            exact.planes[i],
          );
        }
      } finally {
        (await viewReplay.dispose()).unwrap();
        replayRaw.destroy();
      }
    }
    expect(errors).toEqual([]);
    return { tape: tapeBytes, counts, viewCounts, exactViews, planes };
  } finally {
    raw.destroy();
  }
}

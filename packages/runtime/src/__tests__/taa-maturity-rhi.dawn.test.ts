import { existsSync, readFileSync } from 'node:fs';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { error, json, ROOT, save, scene } from './taa-maturity.fixture';

it.skipIf(process.env.TAA_MATURITY !== 'capture')(
  'inspects reduced-scale thin-line history and coverage in RHI Debug',
  { timeout: 240_000, retry: 0 },
  async () => {
    const recorder = attachRecorder(webgpu).unwrap();
    const carrier = await scene(256, 192, { rhi: recorder.backend.rhi });
    const facts = [];
    try {
      carrier.mode(0.5);
      for (let i = 0; i < 180; i++) await carrier.draw();
      for (let phase = 0; phase < 8; phase++) {
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const { receipt } = await carrier.draw(true);
        (await recorder.frameBoundary()).unwrap();
        const capture = (await pending).unwrap();
        save(`thin-line-${phase}.rhitape`, capture.bytes);
        const tape = decodeTape(capture.bytes).unwrap();
        const model = buildFrameModel(tape);
        const taa = model.works.find((w) =>
          w.pipeline.shaders.some((s) => s.source?.includes('struct TaaResolveParams')),
        );
        if (!taa) throw new Error('missing TAA resolve');
        const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
        const device = (
          await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
        ).unwrap();
        const replay = (
          await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
        ).unwrap();
        try {
          const events = [...tape.bootstrap.map((r) => r.create), ...tape.events];
          const reads = [];
          for (const binding of taa.bindings.filter((b) => [0, 6, 9, 11].includes(b.binding))) {
            const view = events.find(
              (e) => e.kind === 'createTextureView' && e.resultHandleId === binding.resourceId,
            );
            if (view?.kind !== 'createTextureView' || typeof view.sourceHandleId !== 'string')
              throw new Error('missing texture view');
            const read = (
              await replay.readResourceAtWork(view.sourceHandleId, taa.workIndex)
            ).unwrap();
            save(`thin-line-${phase}-binding-${binding.binding}.raw`, read.bytes);
            reads.push({
              binding: binding.binding,
              resourceId: view.sourceHandleId,
              format: read.format,
              width: read.width,
              height: read.height,
              provenance: read.provenance,
            });
          }
          const output = (await replay.inspectWork(taa.workIndex, ['pixels'])).unwrap().attachment;
          if (!output) throw new Error('missing TAA color replay');
          save(`thin-line-${phase}-resolved.raw`, output.bytes);
          const final = model.works
            .filter((w) => (w.attachments?.colorViewHandleIds.length ?? 0) > 0)
            .at(-1);
          if (!final) throw new Error('missing final work');
          const normalize = (bytes: Uint8Array, format: string | undefined) => {
            if (format === undefined) throw new Error('missing output format');
            const rgba = bytes.slice();
            if (format.startsWith('bgra'))
              for (let i = 0; i < rgba.length; i += 4)
                [rgba[i], rgba[i + 2]] = [rgba[i + 2] ?? 0, rgba[i] ?? 0];
            return rgba;
          };
          const finalPixels = (await replay.inspectWork(final.workIndex, ['pixels'])).unwrap()
            .attachment;
          if (!finalPixels) throw new Error('missing replay output');
          const live = await carrier.display(receipt);
          const finalError = error(live, normalize(finalPixels.bytes, finalPixels.format));
          expect(
            finalError.maximum,
            'fresh-device replay matches the completed frame',
          ).toBeLessThanOrEqual(0.05);
          save(`thin-line-${phase}-live.rgba`, live);
          const missingSeeds = model.unseededResources.map((resource) => {
            const aliases = events.flatMap((e) =>
              e.kind === 'createTextureView' &&
              e.sourceHandleId === resource.resourceId &&
              typeof e.resultHandleId === 'string'
                ? [e.resultHandleId]
                : [],
            );
            const consumers = model.resources
              .filter((r) => r.resourceId === resource.resourceId || aliases.includes(r.resourceId))
              .flatMap((r) => r.consumers);
            const firstRead = consumers
              .filter((c) => c.access === 'read')
              .map((c) => c.eventIndex)
              .sort((a, b) => a - b)[0];
            // FrameModel reports attachment references as reads. Use the
            // recorded clear operations themselves as initialization evidence.
            const clears = tape.events.flatMap((event, index) => {
              if (event.kind !== 'beginRenderPass') return [];
              const color = event.colorAttachmentViewHandleIds.some(
                (id, slot) =>
                  aliases.includes(id ?? '') &&
                  Array.from(event.desc.colorAttachments)[slot]?.loadOp === 'clear',
              );
              const depth =
                aliases.includes(event.depthStencilViewHandleId ?? '') &&
                event.desc.depthStencilAttachment?.depthLoadOp === 'clear';
              return color || depth ? [index] : [];
            });
            const firstWrite = [
              ...clears,
              ...consumers.filter((c) => c.access === 'write').map((c) => c.eventIndex),
            ].sort((a, b) => a - b)[0];
            if (firstRead !== undefined)
              expect(
                firstWrite ?? Infinity,
                `unseeded ${resource.resourceId} must be initialized before reading`,
              ).toBeLessThanOrEqual(firstRead);
            return {
              ...resource,
              firstRead,
              firstWrite,
              disposition: firstRead === undefined ? 'not-read' : 'written-before-read',
            };
          });
          let falsifierError: ReturnType<typeof error> | undefined;
          if (phase === 0) {
            const producer = model.passes.find((p) =>
              JSON.stringify(tape.events[p.beginEventIndex]).includes('standard-scene-coverage'),
            );
            if (!producer) throw new Error('missing output geometry producer');
            const removed = new Set(
              model.works
                .filter((w) => w.passIndex === producer.passIndex)
                .map((w) => w.eventIndex),
            );
            const corrupted = encodeTape({
              ...tape,
              events: tape.events.map((event, index) =>
                removed.has(index) && event.kind === 'drawIndexed'
                  ? { ...event, indexCount: 0 }
                  : event,
              ),
            }).unwrap();
            save('thin-line-missing-output-geometry.falsifier.rhitape', corrupted);
            const negativeAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
            const negativeDevice = (
              await negativeAdapter.requestDevice(
                replayDeviceRequest(tape, negativeAdapter.features, negativeAdapter.limits),
              )
            ).unwrap();
            const negative = (
              await openReplay(decodeTape(corrupted).unwrap(), {
                device: negativeDevice,
                createShaderModule: webgpu.createShaderModule,
              })
            ).unwrap();
            try {
              const changed = (await negative.inspectWork(final.workIndex, ['pixels'])).unwrap()
                .attachment;
              if (!changed) throw new Error('missing falsifier output');
              const pixels = normalize(changed.bytes, changed.format);
              save('thin-line-missing-output-geometry.falsifier.rgba', pixels);
              falsifierError = error(live, pixels);
              expect(
                falsifierError.maximum,
                'removing actual geometry evidence must change the picture',
              ).toBeGreaterThan(0.05);
            } finally {
              (await negative.dispose()).unwrap();
              webgpu._internal_getRawDevice(negativeDevice)?.destroy();
            }
          }
          // An archived failing tape is optional input for before/after
          // publication, never a hidden dependency of the production gate.
          const beforePath = `${ROOT}/coverage-before/thin-line-0.rhitape`;
          if (phase === 0 && existsSync(beforePath)) {
            const beforeTape = decodeTape(new Uint8Array(readFileSync(beforePath))).unwrap();
            const beforeModel = buildFrameModel(beforeTape);
            const beforeOutput = beforeModel.works
              .filter((w) => (w.attachments?.colorViewHandleIds.length ?? 0) > 0)
              .at(-1);
            if (!beforeOutput) throw new Error('archived failing tape has no output');
            const beforeAdapter = (await webgpu.rhi.requestAdapter()).unwrap();
            const beforeDevice = (
              await beforeAdapter.requestDevice(
                replayDeviceRequest(beforeTape, beforeAdapter.features, beforeAdapter.limits),
              )
            ).unwrap();
            const beforeReplay = (
              await openReplay(beforeTape, {
                device: beforeDevice,
                createShaderModule: webgpu.createShaderModule,
              })
            ).unwrap();
            try {
              const beforeImage = (
                await beforeReplay.inspectWork(beforeOutput.workIndex, ['pixels'])
              ).unwrap().attachment;
              if (!beforeImage) throw new Error('missing archived output');
              save('thin-line-before-final.rgba', normalize(beforeImage.bytes, beforeImage.format));
              json('thin-line-before-replay.json', {
                workIndex: beforeOutput.workIndex,
                format: beforeImage.format,
                width: beforeImage.width,
                height: beforeImage.height,
              });
            } finally {
              (await beforeReplay.dispose()).unwrap();
              webgpu._internal_getRawDevice(beforeDevice)?.destroy();
            }
          }
          // Unseeded frame-local targets are legal only when their recorded
          // producer writes before consumption; history inputs must be seeded.
          for (const read of reads.filter((r) => r.binding === 9))
            expect(model.unseededResources.some((r) => r.resourceId === read.resourceId)).toBe(
              false,
            );
          facts.push({
            phase,
            digest: capture.digest,
            workIndex: taa.workIndex,
            reads,
            output: { format: output.format, width: output.width, height: output.height },
            finalError,
            falsifierError,
            unseededResources: missingSeeds,
          });
          json('thin-line-rhi.json', facts);
        } finally {
          (await replay.dispose()).unwrap();
          webgpu._internal_getRawDevice(device)?.destroy();
        }
      }
    } finally {
      await carrier.dispose();
      (await recorder.dispose()).unwrap();
    }
  },
);

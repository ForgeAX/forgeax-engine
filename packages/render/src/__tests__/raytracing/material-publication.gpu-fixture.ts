import {
  AssetRegistry,
  createMaterialLoader,
  HANDLE_CUBE,
  RuntimeMaterialValue,
} from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { derive } from '@forgeax/engine-types';
import { assert, expect } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { packMaterialProgramRow } from '../../material-row';
import { renderPublicationTransfers } from '../../publication/contract';
import { installPublicationPrograms } from '../../publication/programs';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import { createSubmittedRayPathTracer } from '../../raytracing/path-tracer';
import type { RayPublicationFixture } from './path-tracer.commands';
import { plane, readBuffer } from './path-tracer.fixture';

/** Real cooked publication and World values feed the shared Surface compute entry. */
export async function verifyPublishedRayMaterial(
  fixture: RayPublicationFixture,
  saveCapture?: (bytes: Uint8Array) => Promise<void>,
) {
  const material = fixture.material;
  assert(material.name === 'emission');
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const received = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const record = validateCookedMaterialRecord(
    JSON.parse(material.cookedPublication.record),
  ).unwrap();
  const ready = await createMaterialLoader({
    loadPublication: async () => ({
      guid: material.name,
      record,
      artifacts: Object.fromEntries(
        Object.entries(material.cookedPublication.artifacts).map(([path, bytes]) => [
          path,
          { bytes: new TextEncoder().encode(bytes) },
        ]),
      ),
    }),
  }).load({ guid: material.name, specializationKey: record.specializationKey ?? '' });
  assert(ready.status === 'Ready', JSON.stringify(ready));
  assets.catalog(material.name, material.asset).unwrap();
  assets.recordMaterialReadiness(material.name, ready);
  const world = new World();
  const handle = world.internSharedRef('MaterialAsset', material.asset);
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [handle] } },
    )
    .unwrap();
  const valueEntity = world
    .spawn({
      component: RuntimeMaterialValue,
      data: {
        asset: handle,
        parameter: 'emissiveIntensity',
        kind: 0,
        value: [2],
      },
    })
    .unwrap();
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = gpu._internal_getRawDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const identity = { source: 'published-ray-material', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, device.caps);
  const receiver = new RenderPublicationReceiver(identity);
  const outputs: Uint8Array[] = [];
  const rows: Uint8Array[] = [];
  const transportOutputs: Uint8Array[] = [];
  const preparationFences: {
    capturedGeneration: number;
    currentGeneration: number;
    code: string;
  }[] = [];
  const facts: {
    intensity: number;
    revision: number;
    program: string;
    publicationCpuMs: number;
  }[] = [];
  try {
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    for (const intensity of [2, 0, 4, 8]) {
      world.set(valueEntity, RuntimeMaterialValue, { value: [intensity] }).unwrap();
      world.update(1 / 60).unwrap();
      const start = performance.now();
      const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.packet),
      });
      candidate.accept();
      installPublicationPrograms(received, packet.programs);
      const accepted = receiver.accept(packet).unwrap();
      const snapshot = accepted.frame.renderables[0]?.material;
      assert(snapshot?.materialSurfacePrograms?.['ray-hit']);
      expect(snapshot.materialSurfacePrograms?.['ray-hit'].programKey).toBe(
        material.publication.program,
      );
      const shader = received.shaderRegistry
        .findMaterialArtifact(snapshot.materialSurfacePrograms?.['ray-hit'].programKey)
        .unwrap();
      expect(shader.source).toBe(material.program.wgsl);
      const layout = derive(shader.paramSchema);
      expect(layout.resourceBindings).toHaveLength(0);
      const row = packMaterialProgramRow(
        shader.paramSchema,
        snapshot,
        Math.max(16, layout.totalBytes),
      );
      assert(row);
      rows.push(new Uint8Array(row));
      facts.push({
        intensity,
        revision: packet.revision,
        program: snapshot.materialSurfacePrograms?.['ray-hit'].programKey,
        publicationCpuMs: performance.now() - start,
      });
      const request: Parameters<typeof createSubmittedRayPathTracer>[2] = {
        generationFence: {
          capturedGeneration: packet.revision,
          currentGeneration: () => receiver.acceptedRevision,
        },
        kernel: fixture.kernel,
        scene: buildRaySurfaceScene([plane()]).unwrap(),
        materials: [{ id: 0, snapshot }],
        shaders: received.shaderRegistry,
        lights: [],
        settings: {
          width: 1,
          height: 1,
          maxBounces: 1,
          seed: 47,
          environment: [0, 0, 0],
          maxDistance: 120,
          rays: [
            {
              origin: [0, 0, 2],
              direction: [0, 0, -1],
              coneWidth: 0.02,
              coneSpread: 0.1,
              active: true,
            },
          ],
        },
      };
      for (const [invalid, code] of [
        [{ ...snapshot, materialSurfacePrograms: undefined }, 'ray-reference-invalid'],
        [
          { ...snapshot, paramSnapshot: { ...snapshot.paramSnapshot, alphaHash: 1 } },
          'ray-material-unsupported',
        ],
        [
          {
            ...snapshot,
            paramSnapshot: { ...snapshot.paramSnapshot, emissiveIntensity: Infinity },
          },
          'ray-material-unsupported',
        ],
      ] as const) {
        const rejected = await createSubmittedRayPathTracer(
          device,
          recorder.backend.createShaderModule,
          {
            ...request,
            materials: [{ id: 0, snapshot: invalid }],
          },
        );
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) expect(rejected.error.code).toBe(code);
      }
      const tracer = (
        await createSubmittedRayPathTracer(device, recorder.backend.createShaderModule, request)
      ).unwrap();
      try {
        const encoder = device.createCommandEncoder({}).unwrap();
        tracer.recordSample(encoder).unwrap();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        const result = await readBuffer(device, tracer.buffers.surfaces, 96);
        outputs.push(result);
        const floats = new Float32Array(result.buffer, result.byteOffset, 24);
        expect(new Uint32Array(result.buffer, result.byteOffset, 24)[16]).toBe(1);
        expect(Array.from(floats.slice(8, 11))).toEqual([intensity, intensity / 2, intensity / 4]);
        expect(Array.from(floats.slice(0, 3))).toEqual([0, 0, 0]);
        expect(floats[7]).toBeCloseTo(snapshot.roughness, 6);
        const transport = await readBuffer(device, tracer.buffers.accumulation, 80);
        transportOutputs.push(transport);
        expect(Array.from(new Float32Array(transport.buffer).slice(0, 3))).toEqual([
          intensity,
          intensity / 2,
          intensity / 4,
        ]);
        const words = new Uint32Array(transport.buffer);
        expect(words[3]).toBe(1);
        expect(words[7]).toBe(0);
      } finally {
        tracer.dispose();
      }
      const transfers = renderPublicationTransfers(packet);
      publisher
        .recycle(packet.revision, structuredClone(transfers, { transfer: transfers }))
        .unwrap();
      if (intensity === 4) {
        let changed = false;
        const stale = await createSubmittedRayPathTracer(
          device,
          async (device, descriptor) => {
            if (!changed) {
              changed = true;
              // A real next publication arrives while the old GPU program is awaiting creation.
              world.set(valueEntity, RuntimeMaterialValue, { value: [8] }).unwrap();
              const next = publisher.prepare(world.getResource(Time).elapsed).unwrap();
              const nextPacket = structuredClone(next.packet, {
                transfer: renderPublicationTransfers(next.packet),
              });
              next.accept();
              installPublicationPrograms(received, nextPacket.programs);
              receiver.accept(nextPacket).unwrap();
              const transfers = renderPublicationTransfers(nextPacket);
              publisher
                .recycle(nextPacket.revision, structuredClone(transfers, { transfer: transfers }))
                .unwrap();
            }
            return recorder.backend.createShaderModule(device, descriptor);
          },
          request,
        );
        // Keep the red reproduction bounded even if the old implementation accepts it.
        if (stale.ok) stale.value.dispose();
        expect(stale.ok, 'superseded material preparation must not be published').toBe(false);
        if (!stale.ok) {
          expect(stale.error.code).toBe('ray-reference-stale');
          let compiledAgain = false;
          const obsolete = await createSubmittedRayPathTracer(
            device,
            async (device, descriptor) => {
              compiledAgain = true;
              return recorder.backend.createShaderModule(device, descriptor);
            },
            request,
          );
          if (obsolete.ok) obsolete.value.dispose();
          expect(obsolete.ok).toBe(false);
          expect(compiledAgain).toBe(false);
          preparationFences.push({
            capturedGeneration: packet.revision,
            currentGeneration: receiver.acceptedRevision,
            code: stale.error.code,
          });
        }
      }
    }
    (await recorder.frameBoundary()).unwrap();
    const bytes = (await capture).unwrap().bytes;
    await saveCapture?.(bytes);
    raw.destroy();
    const tape = decodeTape(bytes).unwrap(),
      model = buildFrameModel(tape);
    const consumedBuffers = new Set(
      model.works.flatMap((work) =>
        work.bindings
          .filter((binding) => binding.resourceKind === 'buffer')
          .map((binding) => binding.resourceId),
      ),
    );
    const rejectedBuffers = model.resources.filter((resource) => {
      const create = resource.descriptor;
      const desc =
        typeof create === 'object' && create !== null && 'desc' in create ? create.desc : undefined;
      return (
        resource.kind === 'buffer' &&
        typeof desc === 'object' &&
        desc !== null &&
        'label' in desc &&
        (String(desc.label).startsWith('ray-path.') || desc.label === 'surface.material') &&
        !consumedBuffers.has(resource.resourceId)
      );
    });
    expect(rejectedBuffers).toHaveLength(13);
    expect(
      rejectedBuffers
        .filter((resource) => resource.destroyEventIndex === null)
        .map(({ resourceId, descriptor, lifecycle }) => ({ resourceId, descriptor, lifecycle })),
    ).toEqual([]);
    const works = model.works.filter((work) =>
      work.pipeline.shaders.some((shader) => shader.entryPoint === 'cs_surface'),
    );
    expect(works).toHaveLength(4);
    const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const freshRaw = gpu._internal_getRawDevice(fresh);
    assert(freshRaw);
    freshRaw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
    ).unwrap();
    try {
      for (const [index, work] of works.entries()) {
        const output = work.bindings.find(
          (binding) => binding.groupIndex === 0 && binding.binding === 1,
        );
        const uniform = work.bindings.find(
          (binding) => binding.groupIndex === 1 && binding.binding === 0,
        );
        assert(output?.resourceId && uniform?.resourceId);
        expect(
          (await replay.readResourceAtWork(output.resourceId, work.workIndex)).unwrap().bytes,
        ).toEqual(outputs[index]);
        expect(
          (await replay.readResourceAtWork(uniform.resourceId, work.workIndex)).unwrap().bytes,
        ).toEqual(rows[index]);
      }
      const accumulation = model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'accumulate'),
      );
      expect(accumulation).toHaveLength(4);
      for (const [index, work] of accumulation.entries()) {
        const output = work.bindings.find(
          (binding) => binding.groupIndex === 0 && binding.binding === 6,
        );
        assert(output?.resourceId);
        expect(
          (await replay.readResourceAtWork(output.resourceId, work.workIndex)).unwrap().bytes,
        ).toEqual(transportOutputs[index]);
      }
    } finally {
      (await replay.dispose()).unwrap();
      freshRaw.destroy();
    }
    expect(errors).toEqual([]);
    return {
      bytes,
      outputs,
      rows,
      transportOutputs,
      facts,
      preparationFences: {
        rejected: preparationFences,
        rejectedBuffers: rejectedBuffers.map(
          ({ resourceId, createEventIndex, destroyEventIndex }) => ({
            resourceId,
            createEventIndex,
            destroyEventIndex,
          }),
        ),
      },
    };
  } finally {
    publisher.dispose();
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
}

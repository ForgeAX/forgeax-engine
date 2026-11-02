import { World } from '@forgeax/engine-ecs';
import type { RendererLegacyHostAdapter } from '@forgeax/engine-render/internal/construct-renderer';
import type { Buffer, BufferDescriptor, MappedBuffer } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { STANDARD_CLUSTER_TEST_REFLECTION } from '../../../render/src/__tests__/cluster-test-abi';
import { renderLifecycleManifestUrl } from '../../../render/src/__tests__/shader-manifest-fixture';
import {
  addTypedOutputTransformPass,
  addTypedScenePass,
  createRenderPipelineTarget,
  importRenderPipelineSurface,
} from '../../../render/src/authoring';
import { Camera, perspective } from '../../../render/src/components/camera';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import type { RenderPipeline } from '../../../render/src/render-pipeline';
import {
  captureForwardGtaoTarget,
  type ForwardGtaoCaptureHost,
} from './helpers/forward-gtao-capture';

const GPU_TEXTURE_USAGE_COPY_SRC = 0x01;

const clusterReflection = {
  ...STANDARD_CLUSTER_TEST_REFLECTION,
  boundGlobals: STANDARD_CLUSTER_TEST_REFLECTION.boundGlobals.map((global) => ({
    ...global,
    ...(global.resourceKind === 'storage-buffer'
      ? { span: global.elementStride ?? global.span }
      : {}),
    elementType: global.resourceKind === 'storage-buffer' ? 'LightData' : 'struct',
  })),
};

function clusterReadyManifestUrl(): string {
  const source = renderLifecycleManifestUrl();
  const manifest = JSON.parse(decodeURIComponent(source.slice(source.indexOf(',') + 1)));
  const standard = manifest.materialShaders.find(
    (entry: { readonly identifier: string }) =>
      entry.identifier === 'forgeax::default-standard-pbr',
  );
  if (standard === undefined) throw new Error('runtime lifecycle manifest has no Standard PBR row');
  standard.receipt = createStandardPbrArtifactReceipt(false, false);
  standard.reflection = structuredClone(clusterReflection);
  for (const variant of standard.variants) {
    variant.hash = 'cafe1234';
    variant.sourceDigest = 'a'.repeat(64);
    variant.compilerProfile = {
      id: 'forgeax-material-wgsl-v1',
      language: 'wgsl',
      profileVersion: '1',
      adapterVersion: '1',
      compilerVersion: '1',
      nagaVersion: '30.0.1',
    };
    variant.receipt = createStandardPbrArtifactReceipt(
      false,
      variant.defines.VERTEX_COLOR_AVAILABLE === true,
    );
    variant.reflection = structuredClone(clusterReflection);
  }
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

const capturePipeline: RenderPipeline = {
  build({ graph, observationCaptureDomains }, topology) {
    const raw = createRenderPipelineTarget(graph, 'ssao-raw', {
      format: 'rgba8unorm',
      size: 'surface',
      usage: GPU_TEXTURE_USAGE_COPY_SRC,
      domain: 'linear-hdr',
    });
    if (!raw.ok) return raw;
    const depth = createRenderPipelineTarget(graph, 'capture-depth', {
      format: 'depth32float-stencil8',
      size: 'surface',
    });
    if (!depth.ok) return depth;
    const scene = addTypedScenePass(graph, {
      name: 'capture-scene',
      color: raw.value,
      depth: depth.value,
      selector: { LightMode: ['Forward'] },
    });
    if (!scene.ok) return scene;
    const surface = importRenderPipelineSurface(graph, topology);
    if (!surface.ok) return surface;
    return addTypedOutputTransformPass(graph, raw.value, surface.value.storage, {
      outputOnly: true,
      observationCaptureDomains,
    });
  },
};

function canvas(): HTMLCanvasElement {
  return { width: 32, height: 32, getContext: () => null } as unknown as HTMLCanvasElement;
}

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

it('prepares final-display observation before a generation-bound target copy', async () => {
  const constructed = await constructRendererHost(
    canvas(),
    { rhi, pipeline: capturePipeline },
    { shaderManifestUrl: clusterReadyManifestUrl() },
  );
  expect(constructed.ok).toBe(true);
  if (!constructed.ok) return;
  const renderer = constructed.value.renderer;
  const rendererErrors: unknown[] = [];
  const unsubscribe = renderer.subscribe((event) => {
    if (event.kind === 'error') rendererErrors.push(event.error);
  });
  const debugHost = constructed.value.debugDrawHost as unknown as ForwardGtaoCaptureHost &
    Pick<RendererLegacyHostAdapter, 'setClusterWorkObservationForConformance'>;
  debugHost.setClusterWorkObservationForConformance(true);
  const originalCreateBuffer = debugHost.device.createBuffer.bind(debugHost.device);
  const createReadbackBuffer = vi
    .spyOn(debugHost.device, 'createBuffer')
    .mockImplementation((descriptor: BufferDescriptor) => {
      const created = originalCreateBuffer(descriptor);
      if (!created.ok || !descriptor.label?.startsWith('forward-gtao.')) return created;
      if (descriptor.size === undefined) {
        throw new Error('Forward GTAO structural readback descriptor has no byte size');
      }
      const readbackSize = descriptor.size;

      // RhiNull records real copy commands but has no GPU bytes to map. This shim validates
      // capture ordering and identity only; it does not provide pixel or AO evidence.
      const readback = created.value as Buffer & Partial<MappedBuffer>;
      Object.defineProperties(readback, {
        mapState: { configurable: true, get: () => 'mapped' },
        getMappedRange: {
          configurable: true,
          value: () => ok(new ArrayBuffer(readbackSize)),
        },
        unmap: { configurable: true, value: () => undefined },
        mapAsync: {
          configurable: true,
          value: async () => ok(readback as MappedBuffer),
        },
      });
      return created;
    });

  const world = new World();
  registerPropagateTransforms(world);
  const lease = value(renderer.attach(world));
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 4], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1 }) },
  );
  const input = { leases: [lease], camera: { lease }, environment: { lease } };
  const finalDisplayPassReceipts: number[] = [];
  const draw = async () => {
    if (renderer.requestObservation === undefined) {
      throw new Error('Renderer does not support final-display observation requests');
    }
    value(renderer.requestObservation(['final-display']));
    value(world.update(1 / 60));
    const drawn = renderer.draw(input);
    if (!drawn.ok) {
      throw new Error(
        `Renderer draw failed: ${drawn.error.message}; errors=${JSON.stringify(rendererErrors.map(describeFailure))}; inspection=${JSON.stringify(renderer.inspect())}`,
        { cause: drawn.error },
      );
    }
    const receipt = drawn.value;
    if (receipt.presentation === 'ready') {
      expect(renderer.inspect().perFramePassNames).toContain('final-display-observation');
      finalDisplayPassReceipts.push(receipt.frameId);
    }
    if (rendererErrors.length > 0) {
      throw new Error(
        `Renderer emitted errors: ${JSON.stringify(rendererErrors.map(describeFailure))}`,
      );
    }
    return {
      frameId: receipt.frameId,
      deviceGeneration: receipt.deviceGeneration,
      presentation: receipt.presentation,
      completed: receipt.completed,
    };
  };

  try {
    const captured = await captureForwardGtaoTarget(debugHost, 'ssao-raw', draw);
    expect(captured.preparation.recordFrameNumber + 1).toBe(captured.targetRecordFrameNumber);
    expect(captured.preparation.deviceGeneration).toBe(captured.deviceGeneration);
    expect(captured.preparation.graphGeneration).toBe(captured.graphGeneration);
    expect(captured.preparation.textureIdentity).toBe(captured.textureIdentity);
    expect(captured.preparation.descriptor).toEqual({
      format: captured.format,
      size: { width: captured.width, height: captured.height },
      usage: captured.usage,
      sample: captured.sample,
    });
    expect(captured.bytes.byteLength).toBe(
      captured.width * captured.height * captured.bytesPerTexel,
    );
    if (captured.frameTrace.graphGeneration === undefined) {
      throw new Error(
        `capture trace lacks graph generation: ${JSON.stringify(captured.frameTrace)}`,
      );
    }
    expect(captured.frameTrace.recordFrameNumber).toBe(captured.targetRecordFrameNumber);
    expect(captured.frameTrace.receipt?.publicReceiptFrameId).toBe(captured.publicReceiptFrameId);
    expect(captured.frameTrace.graphTargetCopy).toMatchObject({
      targetName: 'ssao-raw',
      recordFrameNumber: captured.targetRecordFrameNumber,
      expectedIdentity: {
        graphGeneration: captured.graphGeneration,
        recordFrameNumber: captured.targetRecordFrameNumber,
        textureIdentity: captured.textureIdentity,
      },
      actualIdentity: {
        graphGeneration: captured.graphGeneration,
        recordFrameNumber: captured.targetRecordFrameNumber,
        textureIdentity: captured.textureIdentity,
      },
      encoded: true,
    });
    expect(finalDisplayPassReceipts).toEqual([
      captured.preparation.publicReceiptFrameId,
      captured.publicReceiptFrameId,
    ]);
  } finally {
    unsubscribe();
    createReadbackBuffer.mockRestore();
    value(await renderer.dispose());
  }
});

function describeFailure(failure: unknown): unknown {
  if (!(failure instanceof Error)) return failure;
  const detail = failure as Error & {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
    readonly cause?: unknown;
  };
  return {
    name: failure.name,
    message: failure.message,
    code: detail.code,
    expected: detail.expected,
    hint: detail.hint,
    detail: detail.detail,
    cause: detail.cause instanceof Error ? describeFailure(detail.cause) : detail.cause,
  };
}

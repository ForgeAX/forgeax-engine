import type { Buffer, RhiDevice, TextureView } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import type { RenderTargetHost } from '../assembly/render-target-host';
import type { RenderTargetEnvironmentSource } from '../components/render-target-environment';
import type { DeviceScope } from '../device/device-scope';
import {
  createFaceUniformsBuffer,
  createPrefilterUniformsBuffer,
  writeAllFaceUniforms,
  writeAllPrefilterUniforms,
} from '../device/gpu-residency';
import type { RenderError } from '../errors/render';
import {
  RenderTargetDescriptorInvalidError,
  RenderTargetOperationFailedError,
} from '../errors/render';
import {
  CUBEMAP_FACE_VERTICES,
  createIblPipelines,
  type IblShaderModuleFactory,
  PREFILTER_SIZE,
  runIblPrecompute,
} from '../ibl/IblPipelineCache';
import type { FrameReceipt, RenderResult } from '../render-contract';
import type { RenderTarget } from './contracts';
import type { RenderTargetPhysical } from './physical';

export interface RenderTargetEnvironmentLease {
  readonly source: RenderTargetEnvironmentSource;
  release(): RenderResult<void, RenderError>;
}

interface EnvironmentViews {
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  readonly skySh: Buffer;
  readonly prefilter: TextureView;
}
const sources = new WeakMap<RenderTargetEnvironmentSource, EnvironmentViews>();
export function resolveTargetEnvironment(
  source: RenderTargetEnvironmentSource,
  device: RhiDevice,
): EnvironmentViews | undefined {
  const views = sources.get(source);
  return views?.device === device && views.scope.isAlive() ? views : undefined;
}

/** Filter one current cube and register its completed environment with the Renderer. */
export async function prepareTargetEnvironment(input: {
  readonly target: RenderTarget;
  readonly faces: readonly FrameReceipt[] | undefined;
  readonly targets: Pick<RenderTargetHost, 'environmentTarget'>;
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  readonly factory: IblShaderModuleFactory | undefined;
  readonly environments: Set<RenderTargetEnvironmentLease>;
}): Promise<RenderResult<RenderTargetEnvironmentLease, RenderError>> {
  const { target, faces, targets, device, scope, factory, environments } = input;
  const cube = targets.environmentTarget(target, faces);
  if (
    cube === undefined ||
    cube.physical.descriptor.format !== 'rgba16float' ||
    cube.physical.device !== device ||
    cube.physical.generation !== scope.generation ||
    factory === undefined
  )
    return err(
      new RenderTargetDescriptorInvalidError({
        field: 'environment',
        value: target,
        expected: 'six current mip-0 HDR cube faces and native IBL shader factory',
      }),
    );
  const current = () => {
    const next = targets.environmentTarget(target, faces);
    return next?.physical === cube.physical && next.revision === cube.revision;
  };
  const filtered = await filterTargetEnvironment({
    physical: cube.physical,
    scope,
    factory,
    current,
  });
  if (!filtered.ok) return filtered;
  if (faces !== undefined) {
    // The IBL fence covers the earlier face writes. Check their renderer receipts
    // together for failures or invalidation, without fencing between face submissions.
    const outcomes = await Promise.all(faces.map((face) => face.completed));
    const failure = outcomes.find((outcome) => !outcome.ok);
    if (failure !== undefined && !failure.ok) {
      filtered.value.release();
      return failure;
    }
  }
  if (!current() || !scope.isAlive()) {
    filtered.value.release();
    return err(
      new RenderTargetOperationFailedError({
        operation: 'source',
        stage: 'submit',
        generation: cube.physical.generation,
        cause: 'superseded-target-environment',
        recovery: 'retain-last-known-good',
      }),
    );
  }
  const environment: RenderTargetEnvironmentLease = {
    source: filtered.value.source,
    release() {
      environments.delete(environment);
      return filtered.value.release();
    },
  };
  environments.add(environment);
  return ok(environment);
}

/** Snapshot the accepted cube on the GPU, then reuse the native irradiance/PMREM kernels. */
export async function filterTargetEnvironment(input: {
  readonly physical: RenderTargetPhysical;
  readonly scope: DeviceScope;
  readonly factory: IblShaderModuleFactory;
  readonly current: () => boolean;
}): Promise<RenderResult<RenderTargetEnvironmentLease, RenderError>> {
  const { physical, scope: parent, factory, current } = input;
  const device = physical.device;
  const scope = parent.createChild('target-environment');
  const fail = (cause: unknown): RenderResult<never, RenderError> => {
    void device.queue.onSubmittedWorkDone().then(
      () => scope.dispose(),
      () => scope.dispose(),
    );
    return err(
      new RenderTargetOperationFailedError({
        operation: 'source',
        stage: 'allocation',
        generation: physical.generation,
        cause,
        recovery: 'retry',
      }),
    );
  };
  const get = <T>(value: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!value.ok) throw value.error;
    return value.value;
  };
  try {
    const texture = get(
      device.createTexture({
        label: 'target-environment-snapshot',
        size: {
          width: physical.descriptor.width,
          height: physical.descriptor.height,
          depthOrArrayLayers: 6,
        },
        dimension: '2d',
        format: physical.descriptor.format,
        mipLevelCount: 1,
        sampleCount: 1,
        usage: 0x01 | 0x02 | 0x04,
        textureBindingViewDimension: 'cube',
      }),
    );
    scope._adopt('texture', texture, (value) => {
      device.destroyTexture(value);
    });
    const cube = get(device.createTextureView(texture, { dimension: 'cube', arrayLayerCount: 6 }));
    const encoder = get(device.createCommandEncoder({ label: 'target-environment-snapshot' }));
    encoder.copyTextureToTexture(
      { texture: physical.resolveTexture ?? physical.texture },
      { texture },
      {
        width: physical.descriptor.width,
        height: physical.descriptor.height,
        depthOrArrayLayers: 6,
      },
    );
    get(device.queue.submit([get(encoder.finish())]));
    const face = get(createFaceUniformsBuffer(device)),
      prefilter = get(createPrefilterUniformsBuffer(device));
    scope._adopt('buffer', face, (value) => {
      device.destroyBuffer(value);
    });
    scope._adopt('buffer', prefilter, (value) => {
      device.destroyBuffer(value);
    });
    get(writeAllFaceUniforms(device, face));
    get(writeAllPrefilterUniforms(device, prefilter, PREFILTER_SIZE, 'camera'));
    const vertices = get(
      device.createBuffer({
        label: 'target-environment-vertices',
        size: CUBEMAP_FACE_VERTICES.byteLength,
        usage: 0x20 | 0x08,
      }),
    );
    scope._adopt('buffer', vertices, (value) => {
      device.destroyBuffer(value);
    });
    get(device.queue.writeBuffer(vertices, 0, CUBEMAP_FACE_VERTICES));
    get(await createIblPipelines(parent, device, factory, 'rgba16float'));
    if (!current() || !parent.isAlive()) return fail('superseded-target-environment');
    const output = get(
      await runIblPrecompute({
        scope,
        pipelineScope: parent,
        device,
        cubeView: cube,
        cubeFaceViews: [],
        faceUniformsBuffer: face,
        prefilterUniformsBuffer: prefilter,
        cubeVertexBuffer: vertices,
      }),
    );
    if (!current() || !parent.isAlive()) return fail('superseded-target-environment');
    const source: RenderTargetEnvironmentSource = Object.freeze({
      kind: 'render-target-environment',
    });
    sources.set(source, {
      device,
      scope,
      skySh: output.skySh,
      prefilter: output.prefilterView,
    });
    let released = false;
    return ok({
      source,
      release() {
        if (released) return ok(undefined);
        released = true;
        sources.delete(source);
        void device.queue.onSubmittedWorkDone().then(
          () => scope.dispose(),
          () => scope.dispose(),
        );
        return ok(undefined);
      },
    });
  } catch (cause) {
    return fail(cause);
  }
}

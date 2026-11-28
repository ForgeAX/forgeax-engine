import {
  type Buffer,
  type RhiCommandEncoder,
  type RhiDevice,
  RhiError,
  type Texture,
  type TextureView,
} from '@forgeax/engine-rhi';
import type { DeviceScope } from '../device/device-scope';
import { writeAllPrefilterUniforms } from '../device/gpu-residency';
import type { AtmosphereParameters } from '../extract/environment';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { IBL_UNIFORM_SLOT_STRIDE } from '../ibl/IblPipelineCache';
import { pmremExtent, pmremLevelCount } from '../ibl/pmrem';
import { SKY_SH_BYTES } from '../ibl/sky-sh';
import type { RenderFrameState } from '../record/frame-snapshot';
import {
  ATMOSPHERE_PREFILTER_SIZE,
  ATMOSPHERE_SKY_FACES,
} from '../record/gpu-pass-timing/sky-pass-names';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import { recordContext } from '../world/view-record-context';
import type { SelectedEnvironmentFrame } from './frame';

type Runtime = { readonly device: RhiDevice; readonly deviceScope: DeviceScope };
interface MediumTables {
  parameters: AtmosphereParameters;
  revision: number;
  submittedRevision?: number;
  recordedEncoder?: RhiCommandEncoder | undefined;
  references: number;
  readonly scope: DeviceScope;
  readonly transmittance: Texture;
  readonly multipleScattering: Texture;
  readonly ue5Transmittance: Texture;
  readonly ue5MultipleScattering: Texture;
  ue5RecordedEncoder?: RhiCommandEncoder | undefined;
  ue5SubmittedKey?: string | undefined;
}
/** A capture pins physical inputs; newer display frames cannot overwrite them. */
export interface AtmosphereStorage {
  /** Pin this exact generation without changing the current display selection. */
  retain(): AtmosphereLease;
  environment: SelectedEnvironmentFrame;
  readonly sky: Texture;
  readonly skySh: Buffer;
  readonly prefilter: Texture;
  readonly prefilterView: TextureView;
  readonly prefilterScratch: Texture;
  readonly captureSky: Texture;
  readonly distantSkyLight: Texture;
  readonly ue5CaptureSky: Texture;
  readonly distantSkyBuffer: Buffer;
  readonly ue5Transmittance: Texture;
  readonly ue5MultipleScattering: Texture;
  ue5RecordedMediumEncoder?: RhiCommandEncoder | undefined;
  ue5SubmittedMedium?: string | undefined;
  ue5SubmittedDistant?: string | undefined;
  readonly params: Buffer;
  readonly vertices: Buffer;
  readonly iblParams: Buffer;
  readonly transmittance: Texture;
  readonly multipleScattering: Texture;
  recordedEncoder?: RhiCommandEncoder | undefined;
  recordedMediumEncoder?: RhiCommandEncoder | undefined;
  submittedSignature?: string | undefined;
  readonly mediumRevision: number;
  submittedMedium?: number | undefined;
}
interface Generation extends AtmosphereStorage {
  pins: number;
  readonly scope: DeviceScope;
  medium: MediumTables;
}
interface Owner {
  current: Generation | undefined;
  readonly scope: DeviceScope;
  readonly vertices: Buffer;
  readonly iblParams: Buffer;
}
const owners = new WeakMap<DeviceScope, Owner>();
/** Observe existing display storage without selecting, allocating or retaining it. */
export function currentAtmosphereStorage(runtime: Runtime): AtmosphereStorage | undefined {
  return owners.get(recordContext(runtime).deviceScope)?.current;
}
/** A captured old generation remains usable only while its actual lease keeps it alive. */
export function atmosphereStoragePinned(storage: AtmosphereStorage): boolean {
  const generation = storage as Generation;
  return generation.pins > 0 && generation.scope.isAlive();
}
function buffer(
  runtime: Runtime,
  scope: DeviceScope,
  label: string,
  size: number,
  usage: number,
): Buffer {
  const value = runtime.device.createBuffer({ label, size, usage }).unwrap();
  scope._adopt('buffer', value, (value) => {
    runtime.device.destroyBuffer(value).unwrap();
  });
  return value;
}
function texture(
  runtime: Runtime,
  scope: DeviceScope,
  label: string,
  width: number,
  height: number,
  layers = 1,
  mips = 1,
  usage = 0x14,
  format: 'rgba16float' | 'rg11b10ufloat' = 'rgba16float',
): Texture {
  const value = runtime.device
    .createTexture({
      label,
      format,
      size: { width, height, depthOrArrayLayers: layers },
      mipLevelCount: mips,
      usage: runtime.device.caps.storageTexture ? usage : usage & ~0x08,
      textureBindingViewDimension: undefined,
    })
    .unwrap();
  scope._adopt('texture', value, (value) => {
    runtime.device.destroyTexture(value).unwrap();
  });
  return value;
}
function sameCoefficients(a: readonly [number, number, number], b: typeof a): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Only the optical properties read by the medium tables affect their physical contents. */
function sameAtmosphereMedium(a: AtmosphereParameters, b: AtmosphereParameters): boolean {
  return (
    a.planetRadius === b.planetRadius &&
    a.atmosphereHeight === b.atmosphereHeight &&
    a.rayleighScaleHeight === b.rayleighScaleHeight &&
    a.mieScattering === b.mieScattering &&
    a.mieAbsorption === b.mieAbsorption &&
    a.mieScaleHeight === b.mieScaleHeight &&
    a.mieAnisotropy === b.mieAnisotropy &&
    a.absorptionPeakHeight === b.absorptionPeakHeight &&
    a.absorptionHalfWidth === b.absorptionHalfWidth &&
    a.transmittanceMinLightElevationDegrees === b.transmittanceMinLightElevationDegrees &&
    sameCoefficients(a.rayleighScattering, b.rayleighScattering) &&
    sameCoefficients(a.absorption, b.absorption) &&
    sameCoefficients(a.groundAlbedo, b.groundAlbedo)
  );
}

function retire(runtime: Runtime, generation: Generation): void {
  if (generation.scope.state !== 'active') return;
  generation.scope.beginRetire();
  const release = () => {
    generation.scope.retire();
    if (--generation.medium.references === 0) generation.medium.scope.retire();
  };
  void runtime.device.queue.onSubmittedWorkDone().then(release, release);
}
/** Immutable vertex/roughness payloads for every Atmosphere generation on this device. */
function createOwner(runtime: Runtime): Owner {
  const scope = recordContext(runtime).deviceScope.createChild('atmosphere');
  try {
    const triangles = new Float32Array(ATMOSPHERE_SKY_FACES * 9);
    for (let face = 0; face < ATMOSPHERE_SKY_FACES; face++) {
      const faceId = face + 1;
      triangles.set([-1, -1, faceId, 3, -1, faceId, -1, 3, faceId], face * 9);
    }
    const vertices = buffer(runtime, scope, 'atmosphere-face-vertices', triangles.byteLength, 0x28);
    runtime.device.queue.writeBuffer(vertices, 0, triangles).unwrap();
    const iblParams = buffer(
      runtime,
      scope,
      'atmosphere-ibl-params',
      pmremLevelCount(ATMOSPHERE_PREFILTER_SIZE) * ATMOSPHERE_SKY_FACES * IBL_UNIFORM_SLOT_STRIDE,
      0x48,
    );
    writeAllPrefilterUniforms(runtime.device, iblParams, ATMOSPHERE_PREFILTER_SIZE).unwrap();
    return { current: undefined, scope, vertices, iblParams };
  } catch (error) {
    scope.retire();
    throw error;
  }
}

function select(runtime: Runtime, environment: SelectedEnvironmentFrame): Generation {
  if (environment.source.kind !== 'atmosphere')
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'selected atmosphere source',
      hint: 'rebuild the graph after environment selection changes',
    });
  let owner = owners.get(recordContext(runtime).deviceScope);
  if (owner === undefined) {
    owner = createOwner(runtime);
    owners.set(recordContext(runtime).deviceScope, owner);
  }
  const previous = owner.current;
  if (previous?.environment.environmentSignature === environment.environmentSignature)
    return previous;
  const parameters = environment.source.atmosphere;
  let medium = previous?.medium;
  if (medium !== undefined && !sameAtmosphereMedium(medium.parameters, parameters)) {
    if (previous?.pins === 0 && medium.references === 1) {
      medium.parameters = parameters;
      medium.revision += 1;
      delete medium.recordedEncoder;
      delete medium.ue5RecordedEncoder;
      delete medium.ue5SubmittedKey;
    } else {
      medium = undefined;
    }
  }
  if (medium === undefined) {
    const scope = owner.scope.createChild('medium');
    try {
      let transmittance: Texture | undefined;
      let multipleScattering: Texture | undefined;
      let ue5Transmittance: Texture | undefined;
      let ue5MultipleScattering: Texture | undefined;
      medium = {
        parameters,
        revision: 0,
        references: 0,
        scope,
        get transmittance() {
          transmittance ??= texture(
            runtime,
            scope,
            'atmosphere-transmittance',
            256,
            64,
            1,
            1,
            0x1c,
          );
          return transmittance;
        },
        get multipleScattering() {
          multipleScattering ??= texture(
            runtime,
            scope,
            'atmosphere-multiple-scattering',
            32,
            32,
            1,
            1,
            0x1c,
          );
          return multipleScattering;
        },
        get ue5Transmittance() {
          ue5Transmittance ??= texture(
            runtime,
            scope,
            'atmosphere-ue5-transmittance',
            256,
            64,
            1,
            1,
            0x15,
            'rg11b10ufloat',
          );
          return ue5Transmittance;
        },
        get ue5MultipleScattering() {
          ue5MultipleScattering ??= texture(
            runtime,
            scope,
            'atmosphere-ue5-multiple-scattering',
            32,
            32,
            1,
            1,
            0x15,
            'rg11b10ufloat',
          );
          return ue5MultipleScattering;
        },
      };
    } catch (error) {
      scope.retire();
      throw error;
    }
  }
  if (previous !== undefined && previous.pins === 0 && previous.medium === medium) {
    previous.environment = environment;
    delete previous.recordedEncoder;
    return previous;
  }
  const scope = owner.scope.createChild('sky');
  let created: Generation;
  let captureSky: Texture | undefined;
  let ue5CaptureSky: Texture | undefined;
  let distantSkyLight: Texture | undefined;
  let distantSkyBuffer: Buffer | undefined;
  try {
    const size = pmremExtent(ATMOSPHERE_PREFILTER_SIZE);
    const prefilter = texture(
      runtime,
      scope,
      'atmosphere-prefilter',
      size.width,
      size.height,
      1,
      1,
      0x17,
    );
    const prefilterView = runtime.device.createTextureView(prefilter, { dimension: '2d' }).unwrap();
    created = {
      environment,
      retain: () => lease(runtime, created),
      pins: 0,
      scope,
      medium,
      sky: texture(runtime, scope, 'atmosphere-sky', 128, 128, 6),
      skySh: buffer(
        runtime,
        scope,
        'atmosphere-sky-sh',
        SKY_SH_BYTES,
        GPU_BUFFER_USAGE_COPY_DST |
          GPU_BUFFER_USAGE_UNIFORM |
          (runtime.device.caps.storageBuffer ? GPU_BUFFER_USAGE_STORAGE : 0),
      ),
      prefilter,
      prefilterView,
      prefilterScratch: texture(
        runtime,
        scope,
        'atmosphere-prefilter-scratch',
        pmremExtent(ATMOSPHERE_PREFILTER_SIZE).width,
        pmremExtent(ATMOSPHERE_PREFILTER_SIZE).height,
        1,
        1,
        0x17,
      ),
      get captureSky() {
        captureSky ??= texture(runtime, scope, 'atmosphere-capture-sky', 192, 208, 1, 1, 0x1c);
        return captureSky;
      },
      get ue5CaptureSky() {
        ue5CaptureSky ??= texture(
          runtime,
          scope,
          'atmosphere-ue5-capture-sky',
          192,
          104,
          1,
          1,
          0x15,
          'rg11b10ufloat',
        );
        return ue5CaptureSky;
      },
      get distantSkyLight() {
        distantSkyLight ??= texture(
          runtime,
          scope,
          'atmosphere-distant-sky-light',
          1,
          1,
          1,
          1,
          0x1c,
        );
        return distantSkyLight;
      },
      get distantSkyBuffer() {
        distantSkyBuffer ??= buffer(
          runtime,
          scope,
          'atmosphere-ue5-distant-sky-light',
          16,
          GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_SRC,
        );
        return distantSkyBuffer;
      },
      get ue5Transmittance() {
        return this.medium.ue5Transmittance;
      },
      get ue5MultipleScattering() {
        return this.medium.ue5MultipleScattering;
      },
      get ue5RecordedMediumEncoder() {
        return this.medium.ue5RecordedEncoder;
      },
      set ue5RecordedMediumEncoder(value) {
        this.medium.ue5RecordedEncoder = value;
      },
      get ue5SubmittedMedium() {
        return this.medium.ue5SubmittedKey;
      },
      set ue5SubmittedMedium(value) {
        this.medium.ue5SubmittedKey = value;
      },
      params: buffer(runtime, scope, 'atmosphere-params', VIEW_UNIFORM_BYTES, 0x48),
      vertices: owner.vertices,
      iblParams: owner.iblParams,
      get transmittance() {
        return this.medium.transmittance;
      },
      get multipleScattering() {
        return this.medium.multipleScattering;
      },
      get recordedMediumEncoder() {
        return this.medium.recordedEncoder;
      },
      set recordedMediumEncoder(value) {
        this.medium.recordedEncoder = value;
      },
      get mediumRevision() {
        return this.medium.revision;
      },
      get submittedMedium() {
        return this.medium.submittedRevision;
      },
      set submittedMedium(value) {
        if (value === undefined) delete this.medium.submittedRevision;
        else this.medium.submittedRevision = value;
      },
    };
  } catch (error) {
    scope.retire();
    if (medium.references === 0) medium.scope.retire();
    throw error;
  }
  medium.references++;
  owner.current = created;
  if (previous !== undefined && previous.pins === 0) retire(runtime, previous);
  return created;
}
export function prepareAtmosphereStorage(
  runtime: Runtime,
  environment: SelectedEnvironmentFrame,
): AtmosphereStorage {
  return select(runtime, environment);
}

export function atmosphereStorage(frame: RenderPipelineFrame): AtmosphereStorage {
  const context = frame as _InternalRenderPipelineContext;
  if (context.capturedAtmosphere !== undefined) return context.capturedAtmosphere;
  const environment = context.frameState.environmentFrame;
  if (environment === undefined)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'validated atmosphere frame',
      hint: 'select the environment before recording',
    });
  return select(context.runtime, environment);
}
export function atmosphereMediumDirty(frame: RenderPipelineFrame): boolean {
  const storage = atmosphereStorage(frame);
  return (
    storage.submittedMedium !== storage.mediumRevision &&
    storage.recordedMediumEncoder !== frame.encoder
  );
}

export function stageAtmosphereMedium(frame: RenderPipelineFrame): void {
  const storage = atmosphereStorage(frame);
  const revision = storage.mediumRevision;
  storage.recordedMediumEncoder = frame.encoder;
  stageAtmospherePublish((frame as _InternalRenderPipelineContext).frameState, () => {
    storage.submittedMedium = revision;
  });
}

export interface AtmosphereLease {
  readonly storage: AtmosphereStorage;
  release(): void;
}
export function retainAtmosphere(
  runtime: Runtime,
  environment: SelectedEnvironmentFrame,
): AtmosphereLease {
  if (environment.source.kind === 'atmosphere' && environment.source.atmosphere.backgroundOnly)
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'full Atmosphere for environment, cube and planar captures',
      hint: 'backgroundOnly supplies display sky only; remove captures or select full Atmosphere on a capable device',
    });
  return select(runtime, environment).retain();
}
function lease(runtime: Runtime, storage: Generation): AtmosphereLease {
  storage.pins++;
  let released = false;
  return {
    storage,
    release() {
      if (released) return;
      released = true;
      storage.pins--;
      if (storage.pins === 0 && owners.get(recordContext(runtime).deviceScope)?.current !== storage)
        retire(runtime, storage);
    },
  };
}

/** Stop retaining display storage when its owner is removed; pinned captures finish. */
export function releaseAtmosphere(runtime: Runtime): void {
  const owner = owners.get(recordContext(runtime).deviceScope);
  const previous = owner?.current;
  if (owner === undefined || previous === undefined) return;
  owner.current = undefined;
  if (previous.pins === 0) retire(runtime, previous);
}

type AtmospherePublishState = Pick<RenderFrameState, 'pendingAtmospherePublish'>;

/** Defer an atmosphere storage publication until this frame's queue submit is accepted. */
export function stageAtmospherePublish(state: AtmospherePublishState, publish: () => void): void {
  const previous = state.pendingAtmospherePublish;
  state.pendingAtmospherePublish =
    previous === undefined
      ? publish
      : () => {
          previous();
          publish();
        };
}

/** Run staged publications only after an accepted submit; every other outcome drops them. */
export function settleAtmospherePublish(state: AtmospherePublishState, submitted: boolean): void {
  const publish = state.pendingAtmospherePublish;
  state.pendingAtmospherePublish = undefined;
  if (submitted) publish?.();
}

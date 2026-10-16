import {
  type Buffer,
  type RhiCommandEncoder,
  type RhiDevice,
  RhiError,
  type Texture,
} from '@forgeax/engine-rhi';
import type { DeviceScope } from '../device/device-scope';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { VIEW_UNIFORM_BYTES } from '../record/view-ubo';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { SelectedEnvironmentFrame } from './frame';

type Runtime = { readonly device: RhiDevice; readonly deviceScope: DeviceScope };
interface MediumTables {
  key: string;
  submittedKey?: string;
  recordedEncoder?: RhiCommandEncoder | undefined;
  references: number;
  readonly scope: DeviceScope;
  readonly transmittance: Texture;
  readonly multipleScattering: Texture;
}
/** A capture pins physical inputs; newer display frames cannot overwrite them. */
export interface AtmosphereStorage {
  /** Pin this exact generation without changing the current display selection. */
  retain(): AtmosphereLease;
  environment: SelectedEnvironmentFrame;
  readonly sky: Texture;
  readonly irradiance: Texture;
  readonly prefilter: Texture;
  readonly captureSky: Texture;
  readonly distantSkyLight: Texture;
  readonly params: Buffer;
  readonly vertices: Buffer;
  readonly iblParams: Buffer;
  readonly transmittance: Texture;
  readonly multipleScattering: Texture;
  recordedEncoder?: RhiCommandEncoder | undefined;
  recordedMediumEncoder?: RhiCommandEncoder | undefined;
  submittedSignature?: string | undefined;
  submittedMedium?: string | undefined;
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
): Texture {
  const value = runtime.device
    .createTexture({
      label,
      format: 'rgba16float',
      size: { width, height, depthOrArrayLayers: layers },
      mipLevelCount: mips,
      usage,
      textureBindingViewDimension: undefined,
    })
    .unwrap();
  scope._adopt('texture', value, (value) => {
    runtime.device.destroyTexture(value).unwrap();
  });
  return value;
}
export function atmosphereMediumKey(environment: SelectedEnvironmentFrame): string {
  if (environment.source.kind !== 'atmosphere') return '';
  const {
    capturePosition: _capture,
    groundOrigin: _origin,
    aerialPerspectiveStart: _start,
    aerialPerspectiveDistanceScale: _scale,
    sunAngularRadius: _sun,
    multipleScattering: _multiple,
    ...medium
  } = environment.source.atmosphere;
  return JSON.stringify(medium);
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
function select(runtime: Runtime, environment: SelectedEnvironmentFrame): Generation {
  if (environment.source.kind !== 'atmosphere')
    throw new RhiError({
      code: 'rhi-not-available',
      expected: 'selected atmosphere source',
      hint: 'rebuild the graph after environment selection changes',
    });
  let owner = owners.get(runtime.deviceScope);
  if (owner === undefined) {
    const scope = runtime.deviceScope.createChild('atmosphere');
    try {
      owner = {
        current: undefined,
        scope,
        vertices: buffer(runtime, scope, 'atmosphere-face-vertices', 216, 0x28),
        iblParams: buffer(runtime, scope, 'atmosphere-ibl-params', VIEW_UNIFORM_BYTES, 0x48),
      };
    } catch (error) {
      scope.retire();
      throw error;
    }
    owners.set(runtime.deviceScope, owner);
  }
  const previous = owner.current;
  if (previous?.environment.environmentSignature === environment.environmentSignature)
    return previous;
  const key = atmosphereMediumKey(environment);
  let medium = previous?.medium;
  if (
    medium !== undefined &&
    medium.key !== key &&
    previous?.pins === 0 &&
    medium.references === 1
  ) {
    medium.key = key;
    delete medium.submittedKey;
    delete medium.recordedEncoder;
  }
  if (medium === undefined || medium.key !== key) {
    const scope = owner.scope.createChild('medium');
    try {
      medium = {
        key,
        references: 0,
        scope,
        transmittance: texture(runtime, scope, 'atmosphere-transmittance', 256, 64, 1, 1, 0x0c),
        multipleScattering: texture(
          runtime,
          scope,
          'atmosphere-multiple-scattering',
          32,
          32,
          1,
          1,
          0x0c,
        ),
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
  try {
    created = {
      environment,
      retain: () => lease(runtime, created),
      pins: 0,
      scope,
      medium,
      sky: texture(runtime, scope, 'atmosphere-sky', 128, 128, 6),
      irradiance: texture(runtime, scope, 'atmosphere-irradiance', 16, 16, 6),
      prefilter: texture(runtime, scope, 'atmosphere-prefilter', 64, 64, 6, 5),
      captureSky: texture(runtime, scope, 'atmosphere-capture-sky', 192, 208, 1, 1, 0x0c),
      distantSkyLight: texture(runtime, scope, 'atmosphere-distant-sky-light', 1, 1, 1, 1, 0x0c),
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
      get submittedMedium() {
        return this.medium.submittedKey;
      },
      set submittedMedium(value) {
        if (value === undefined) delete this.medium.submittedKey;
        else this.medium.submittedKey = value;
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
export interface AtmosphereLease {
  readonly storage: AtmosphereStorage;
  release(): void;
}
export function retainAtmosphere(
  runtime: Runtime,
  environment: SelectedEnvironmentFrame,
): AtmosphereLease {
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
      if (storage.pins === 0 && owners.get(runtime.deviceScope)?.current !== storage)
        retire(runtime, storage);
    },
  };
}

/** Stop retaining display storage when its owner is removed; pinned captures finish. */
export function releaseAtmosphere(runtime: Runtime): void {
  const owner = owners.get(runtime.deviceScope);
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

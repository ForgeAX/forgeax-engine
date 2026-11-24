// @ts-check
import { World } from '@forgeax/engine-ecs';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';

/** @typedef {NonNullable<ReturnType<import('@forgeax/engine-render').Renderer['inspect']>['diffuseGi']>} NativeGiInspection */
/** @typedef {Extract<NativeGiInspection, {gather: 'irradiance-field'}>} NativeGiFieldInspection */
/** @typedef {Extract<NativeGiInspection, {gather: 'screen-probe'}>} NativeGiScreenInspection */
/**
 * @param {NativeGiInspection | undefined} state
 * @returns {{state: NativeGiInspection['state'] | 'off', submittedFrames: number, failed: boolean, generation: number | null, fieldGeneration: number | null, fieldAcceleration: NonNullable<NativeGiFieldInspection['acceleration']> | null, fieldState?: NativeGiFieldInspection['state'] | undefined, traversal?: NativeGiFieldInspection['traversal'], traversalFallback?: NativeGiFieldInspection['traversalFallback'], softwareWorld?: NativeGiScreenInspection['softwareWorld']}}
 */
export function inspectNativeSponzaGi(state) {
  if (state === undefined) return { state: 'off', submittedFrames: 0, failed: false,
    generation: null, fieldGeneration: null, fieldAcceleration: null };
  const field = 'gather' in state ?
    state.gather === 'screen-probe' ? state.field :
      state.gather === 'irradiance-field' ? state : undefined : undefined;
  return {
    state: state.state,
    submittedFrames: state.submittedFrames,
    failed: state.state === 'failed',
    generation: state.generation ?? null,
    fieldGeneration: field?.generation ?? null,
    fieldAcceleration: field?.acceleration ?? null,
    fieldState: field?.state,
    traversal: field?.traversal,
    traversalFallback: field?.traversalFallback,
    softwareWorld: 'gather' in state && state.gather === 'screen-probe' ? state.softwareWorld : undefined,
  };
}

/**
 * Read the renderer-owned configuration only after a frame has been driven.
 * Native Renderer configures its borrowed Surface lazily during draw setup.
 *
 * @param {{ getConfiguration(): GPUCanvasConfiguration | null; supportedTextureUsages?: number | undefined; supportedAlphaModes?: readonly GPUCanvasAlphaMode[] | undefined } | null | undefined} context
 * @param {{ readonly info?: GPUAdapterInfo }} adapterRequest
 * @param {number} frameId
 * @param {{ width: number; height: number; scaleFactor: number; visible: boolean } | undefined} extent
 */
export function captureNativeSurfaceAfterFrame(context, adapterRequest, frameId, extent) {
  const configuration = context?.getConfiguration();
  if (configuration == null || context == null) return undefined;

  const device = configuration.device;
  const adapterInfo = device.adapterInfo;
  if (adapterInfo === undefined)
    throw new Error('native Renderer device did not expose adapter identity');

  const identityFields = /** @type {const} */ (['vendor', 'device', 'architecture']);
  const mismatchedIdentity = identityFields.filter((field) =>
    adapterRequest.info?.[field] && adapterInfo[field] && adapterRequest.info[field] !== adapterInfo[field]);
  if (mismatchedIdentity.length > 0)
    throw new Error(`Renderer device differs from Surface-compatible adapter request: ${mismatchedIdentity.join(', ')}`);

  return {
    configuredFrameId: frameId,
    rendererDevice: {
      info: adapterInfo,
      features: [...device.features].sort(),
    },
    surface: {
      format: configuration.format,
      usage: configuration.usage,
      viewFormats: [...(configuration.viewFormats ?? [])],
      alphaMode: configuration.alphaMode,
      colorSpace: configuration.colorSpace,
      extent: extent === undefined ? undefined : {
        width: extent.width,
        height: extent.height,
        scaleFactor: extent.scaleFactor,
      },
      supportedTextureUsages: context.supportedTextureUsages,
      supportedAlphaModes: [...(context.supportedAlphaModes ?? [])],
    },
  };
}

/**
 * A completed receipt may still be blocked while the real Surface is prepared.
 * Once presentation claims readiness, missing Surface configuration is fatal.
 *
 * @param {string} presentation
 * @param {boolean} surfaceConfigured
 */
export function evaluateNativeSurfacePresentation(presentation, surfaceConfigured) {
  return {
    ready: presentation === 'ready' && surfaceConfigured,
    invalid: presentation === 'ready' && !surfaceConfigured,
  };
}

/** @param {Awaited<ReturnType<typeof constructRuntimeRendererHost>>} created
 *  @param {unknown[]} errors
 */
export function assembleNativeSponzaRendererHost(created, errors = []) {
  if (created.ok === false) throw new Error(`native Renderer bootstrap failed: ${JSON.stringify(created.error)}`);

  const { renderer, assets } = created.value;
  renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });

  return { renderer, assets, world: new World({ assets }), errors };
}

/**
 * Assemble the ordinary Runtime Renderer and its single host asset owner for
 * an already-created native Surface.
 *
 * @param {Parameters<typeof constructRuntimeRendererHost>[0]} canvas
 * @param {NonNullable<Parameters<typeof constructRuntimeRendererHost>[1]>} options
 * @param {NonNullable<Parameters<typeof constructRuntimeRendererHost>[2]>} bundler
 * @param {unknown[]} errors
 */
export async function createNativeSponzaRendererHost(canvas, options, bundler, errors = []) {
  return assembleNativeSponzaRendererHost(
    await constructRuntimeRendererHost(canvas, options, bundler),
    errors,
  );
}

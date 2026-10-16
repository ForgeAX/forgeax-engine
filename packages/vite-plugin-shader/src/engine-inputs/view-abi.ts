/**
 * Typed transport description for the shared View uniform block.
 *
 * This is metadata only: it names the shader module and binding plus the
 * stable byte offsets consumed by the Host upload path. It never contains a
 * GPU buffer, texture view, or device handle.
 */
export interface ViewAbiField {
  readonly name: string;
  readonly offsetBytes: number;
  readonly sizeBytes: number;
}

export interface ViewAbi {
  readonly moduleId: 'forgeax_view::common';
  readonly group: 0;
  readonly binding: 0;
  readonly byteLength: 1280;
  readonly fields: readonly ViewAbiField[];
}

export const VIEW_ABI: ViewAbi = Object.freeze({
  moduleId: 'forgeax_view::common',
  group: 0,
  binding: 0,
  byteLength: 1280,
  fields: Object.freeze([
    { name: 'worldViewProj', offsetBytes: 0, sizeBytes: 64 },
    { name: 'inverseViewProj', offsetBytes: 176, sizeBytes: 64 },
    { name: 'spotLightViewProj', offsetBytes: 528, sizeBytes: 256 },
    { name: 'temporalCurrentViewProj', offsetBytes: 784, sizeBytes: 64 },
    { name: 'temporalPreviousViewProj', offsetBytes: 848, sizeBytes: 64 },
    { name: 'temporalProjection', offsetBytes: 912, sizeBytes: 16 },
    { name: 'temporalPreviousCameraPos', offsetBytes: 928, sizeBytes: 16 },
    { name: 'ssrParams', offsetBytes: 944, sizeBytes: 16 },
    { name: 'cloudShadowProjection', offsetBytes: 960, sizeBytes: 64 },
    { name: 'clippingPlanes', offsetBytes: 1024, sizeBytes: 96 },
    { name: 'clippingControl', offsetBytes: 1120, sizeBytes: 16 },
    { name: 'fogColorDensity', offsetBytes: 1136, sizeBytes: 16 },
    { name: 'fogHeightOpacity', offsetBytes: 1152, sizeBytes: 16 },
    { name: 'atmosphere', offsetBytes: 1168, sizeBytes: 96 },
    { name: 'atmosphereControl', offsetBytes: 1264, sizeBytes: 16 },
  ]),
});

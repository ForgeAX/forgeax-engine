// @forgeax/engine-render - single-sided rectangular area-light authoring facts.

import { defineComponent } from '@forgeax/engine-ecs';
import { LIGHTING_CHANNELS_DEFAULT } from './lighting-channels';

/**
 * Single-sided rectangular area light. Transform supplies the center and
 * world orientation; width and height remain authored emitter dimensions.
 *
 * `sourceTexture` optionally paints the emitter with an uncompressed 2D
 * TextureAsset of any size (Unreal `SourceTexture`): RGBA8 / BGRA8 (sRGB or
 * linear), R8 grayscale, or RGBA16F / RGBA32F clipped to [0, 1]. The light's
 * local +X maps to u, local +Y to v = 0 (image top), RGB multiplies
 * `color * intensity` and alpha is ignored.
 * Diffuse reads a wide prefiltered level; specular sharpens with roughness,
 * so glossy receivers reflect the image. Requires the extended-lighting
 * topology; without it the emitter stays uniform.
 */
export const RectAreaLight = defineComponent('RectAreaLight', {
  // f64 preserves invalid author inputs until render validation (no u32 wrapping).
  lightingChannels: { type: 'f64', default: LIGHTING_CHANNELS_DEFAULT },
  color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  intensity: { type: 'f32', default: 1 },
  width: { type: 'f32', default: 10 },
  height: { type: 'f32', default: 10 },
  range: { type: 'f32', default: Number.POSITIVE_INFINITY },
  sourceTexture: { type: 'shared<TextureAsset>' },
  // Center-direction photometry modulates the existing finite-area LTC light.
  iesProfile: { type: 'shared<IesProfileAsset>' },
});

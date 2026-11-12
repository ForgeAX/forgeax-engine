import type { Buffer, RhiQueue } from '@forgeax/engine-rhi';
import type { ViewLights } from '../world/render-lights';

export const SHADOW_CASTER_SLOT_STRIDE = 256;
export const SHADOW_CASTER_BUFFER_SIZE = SHADOW_CASTER_SLOT_STRIDE * 8;

export function directionalShadowCasterOffset(cascadeIndex: number): number {
  return SHADOW_CASTER_SLOT_STRIDE * cascadeIndex;
}

export function spotShadowCasterOffset(tile: number): number {
  return SHADOW_CASTER_SLOT_STRIDE * (4 + tile);
}

const DIRECTIONAL_HEADERS = [0, 1].map((clampNear) => {
  const words = new Uint32Array((SHADOW_CASTER_SLOT_STRIDE * 3 + 16) / 4);
  for (let cascade = 0; cascade < 4; cascade++) {
    const offset = directionalShadowCasterOffset(cascade) / 4;
    words[offset] = cascade;
    words[offset + 2] = clampNear;
  }
  return words;
});

/** Fixed caster headers belong to each buffer, including view/recovery replacements. */
export function initializeShadowCasterUniforms(queue: RhiQueue, buffer: Buffer): Buffer {
  const words = new Uint32Array(SHADOW_CASTER_BUFFER_SIZE / 4);
  for (let cascade = 0; cascade < 4; cascade++)
    words[directionalShadowCasterOffset(cascade) / 4] = cascade;
  for (let tile = 0; tile < 4; tile++) words[spotShadowCasterOffset(tile) / 4 + 1] = 1;
  const initialized = queue.writeBuffer(buffer, 0, words);
  if (!initialized.ok) throw initialized.error;
  return buffer;
}

/** Project the current CSM clipping policy and spot matrices into the caster slots. */
export function writeShadowCasterUniforms(
  queue: RhiQueue,
  buffer: Buffer,
  lights: ViewLights,
): void {
  if (lights.directionalCsmConfig !== undefined) {
    const clampNear = lights.directionalCsmConfig.shadowViewProjection === undefined;
    const headers = DIRECTIONAL_HEADERS[clampNear ? 1 : 0];
    if (headers === undefined) throw new Error('Missing directional caster headers');
    const uploaded = queue.writeBuffer(buffer, 0, headers);
    if (!uploaded.ok) throw uploaded.error;
  }
  for (const snapshot of lights.spot) {
    const tile = snapshot.shadowAtlasTile;
    if (tile < 0 || tile >= 4 || snapshot.lightViewProj === undefined) continue;
    const matrix = queue.writeBuffer(
      buffer,
      spotShadowCasterOffset(tile) + 16,
      snapshot.lightViewProj,
    );
    if (!matrix.ok) throw matrix.error;
  }
}

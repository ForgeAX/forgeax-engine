import { err, ok, type Result } from '@forgeax/engine-types';
import { type VolumeError, VolumeOwnerConflictError } from '../errors/render';
import {
  MAX_VOLUMETRIC_FOG_OWNERS,
  type ValidatedVolumetricFog,
  type VolumetricFogAuthoring,
  validateVolumetricFog,
} from './component';

export type VolumetricFogExtract =
  | { readonly status: 'off' }
  | { readonly status: 'available'; readonly fogs: readonly ValidatedVolumetricFog[] };

export function extractVolumetricFog(
  inputs: readonly VolumetricFogAuthoring[],
): Result<VolumetricFogExtract, VolumeError> {
  if (inputs.length === 0) return ok({ status: 'off' });
  if (inputs.length > MAX_VOLUMETRIC_FOG_OWNERS)
    return err(new VolumeOwnerConflictError(inputs.length));
  const fogs: ValidatedVolumetricFog[] = [];
  for (const input of inputs) {
    const validated = validateVolumetricFog(input);
    if (!validated.ok) return validated;
    fogs.push(validated.value);
  }
  return ok({ status: 'available', fogs });
}

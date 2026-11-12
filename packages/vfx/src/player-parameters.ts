import { err, ok, type Result } from '@forgeax/engine-types';
import { type VfxReflectedField, type VfxValue, vfxValueMatches } from './effect-contract.js';

/** Why a `ParticleEffectPlayer.parameters` text is not valid for an effect. */
export interface VfxPlayerParametersError {
  readonly expected: string;
  /** The offending parameter; absent when the text itself is not a JSON object. */
  readonly parameter?: string;
  readonly actual?: unknown;
  /** Every parameter name the effect declares. */
  readonly validNames: readonly string[];
}

/**
 * Parse and validate a Player `parameters` JSON text against an effect's
 * declared parameter fields. Shared by the runtime and by offline checks
 * (`forgeax project check`) so both report the same errors.
 */
export function validateVfxPlayerParameters(
  text: string,
  fields: readonly Pick<VfxReflectedField, 'name' | 'type'>[],
): Result<Readonly<Record<string, VfxValue>>, VfxPlayerParametersError> {
  const validNames = fields.map((field) => field.name);
  if (text === '') return ok({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err({ expected: 'ParticleEffectPlayer.parameters to be a JSON object', validNames });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return err({
      expected: 'ParticleEffectPlayer.parameters to be a JSON object',
      actual: parsed,
      validNames,
    });
  const overrides = parsed as Record<string, unknown>;
  for (const [name, value] of Object.entries(overrides)) {
    const field = fields.find((candidate) => candidate.name === name);
    if (field === undefined)
      return err({
        expected: `a parameter declared by the effect (${validNames.join(', ') || 'none'})`,
        parameter: name,
        validNames,
      });
    if (!vfxValueMatches(field.type, value))
      return err({
        expected: `a finite ${field.type} value for parameter ${name}`,
        parameter: name,
        actual: value,
        validNames,
      });
  }
  return ok(overrides as Record<string, VfxValue>);
}

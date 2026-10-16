import type {
  MaterialParticleInput,
  MaterialParticleInputType,
  MaterialParticleInputVisibility,
  Result,
} from '@forgeax/engine-types';
import { compileFailed, err, ok, type ShaderError } from '../errors.js';

const INPUT_LINE =
  /^\s*\/\/\s*forgeax(?::vfx|-vfx)-particle-input\s+([A-Za-z_]\w*)\s*:\s*(f32|vec2<f32>|vec3<f32>|vec4<f32>)\s+(vertex|fragment|vertex-fragment)(?:\s+lane=(\d+))?\s*$/;
const MARKER = /forgeax(?::vfx|-vfx)-particle-input/;

function particleInputError(reason: string, line?: number): ShaderError {
  return compileFailed({
    message: `material particle input declaration is invalid: ${reason}`,
    hint: 'declare at most four unique forgeax-vfx-particle-input lanes and recook the material',
    ...(line === undefined ? {} : { lineNum: line }),
    reason,
  });
}

/**
 * Read explicit material/VFX bridge declarations from composed WGSL.
 *
 * The declaration is intentionally a comment so it does not introduce a
 * runtime shader ABI by itself:
 *
 * `// forgeax-vfx-particle-input heat: f32 fragment lane=0`
 *
 * The cooked artifact carries the typed result. VFX source then refers to the
 * artifact name, never to a fixed `DynamicMaterialParameter0..3` table.
 */
export function parseMaterialParticleInputs(
  source: string,
): Result<readonly MaterialParticleInput[], ShaderError> {
  const inputs: MaterialParticleInput[] = [];
  const names = new Set<string>();
  const lanes = new Set<number>();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!MARKER.test(line)) continue;
    const match = INPUT_LINE.exec(line);
    if (match === null) return err(particleInputError('malformed declaration', index + 1));
    const name = match[1];
    const type = match[2] as MaterialParticleInputType | undefined;
    const visibility = match[3] as MaterialParticleInputVisibility | undefined;
    const explicitLane = match[4] === undefined ? undefined : Number(match[4]);
    if (name === undefined || type === undefined || visibility === undefined) {
      return err(particleInputError('missing name, type, or visibility', index + 1));
    }
    const lane = explicitLane ?? inputs.length;
    if (lane < 0 || lane >= 4 || !Number.isInteger(lane)) {
      return err(particleInputError(`lane ${lane} is outside the four-lane budget`, index + 1));
    }
    if (names.has(name)) return err(particleInputError(`duplicate input '${name}'`, index + 1));
    if (lanes.has(lane)) return err(particleInputError(`duplicate lane ${lane}`, index + 1));
    names.add(name);
    lanes.add(lane);
    inputs.push({ name, type, visibility, lane });
  }
  return ok(Object.freeze(inputs));
}

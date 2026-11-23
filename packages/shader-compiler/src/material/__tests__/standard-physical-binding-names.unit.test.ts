import {
  STANDARD_PHYSICAL_BINDING_START,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
} from '@forgeax/engine-shader';
import { STANDARD_MATERIAL_PARAM_SCHEMA } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { generateParameterModule } from '../cook.js';

// Imported specular and other physical maps must use the same fixed slots as
// the renderer, including when the root chooses only one physical layer.
it.each([
  false,
  true,
])('generates the physical pairs without changing reserved offsets (sparse=%s)', (sparse) => {
  const fields = sparse ? ['specularTexture'] : [...STANDARD_PHYSICAL_TEXTURE_FIELDS];
  const schema = STANDARD_MATERIAL_PARAM_SCHEMA.filter(
    (entry) => !sparse || entry.name === 'roughness' || fields.includes(entry.name),
  );
  const generated = generateParameterModule(schema, { standardTextureDefines: true });
  for (const [index, field] of STANDARD_PHYSICAL_TEXTURE_FIELDS.entries()) {
    const binding = STANDARD_PHYSICAL_BINDING_START + index * 2;
    if (fields.includes(field)) {
      expect(generated).toContain(`@group(1) @binding(${binding}) var ${field}_sampler : sampler;`);
      expect(generated).toContain(
        `@group(1) @binding(${binding + 1}) var ${field} : texture_2d<f32>;`,
      );
    } else {
      expect(generated).not.toContain(`var ${field}`);
    }
  }
});

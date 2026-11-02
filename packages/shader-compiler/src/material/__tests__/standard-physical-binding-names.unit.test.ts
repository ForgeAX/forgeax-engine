import { readFileSync } from 'node:fs';
import {
  STANDARD_PHYSICAL_BINDING_START,
  STANDARD_PHYSICAL_TEXTURE_FIELDS,
} from '@forgeax/engine-shader';
import { STANDARD_MATERIAL_PARAM_SCHEMA } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { lowerStandardPhysicalBindings } from '../lower-standard-contract.js';

const TEMPLATES = ['default-standard-pbr.wgsl', 'default-standard-pbr-skin.wgsl'] as const;

function template(name: string): string {
  return readFileSync(new URL(`../../../../shader/src/${name}`, import.meta.url), 'utf8');
}

// Regression: a KHR_materials_specular texture (glTF car body) produced
// `@group(1) @binding(42) var specularTextureSampler` while the derived
// layout placed that sampler at 48 + 2 * 8. Every physical pair the template
// declares must land on the derived layout slots, sampler included.
describe('Standard physical texture pairs follow the derived layout', () => {
  for (const name of TEMPLATES) {
    it(`${name} remaps every physical sampler and texture`, () => {
      const lowered = lowerStandardPhysicalBindings(
        template(name),
        STANDARD_MATERIAL_PARAM_SCHEMA,
        true,
      );
      for (const [index, field] of STANDARD_PHYSICAL_TEXTURE_FIELDS.entries()) {
        const pair = new RegExp(
          `@group\\(1\\) @binding\\((\\d+)\\) var (\\w+) : sampler;\\s*` +
            `@group\\(1\\) @binding\\((\\d+)\\) var ${field} :`,
          'u',
        ).exec(lowered);
        expect(pair, field).not.toBeNull();
        expect([field, Number(pair?.[1])]).toEqual([
          field,
          STANDARD_PHYSICAL_BINDING_START + index * 2,
        ]);
        expect([field, Number(pair?.[3])]).toEqual([
          field,
          STANDARD_PHYSICAL_BINDING_START + 1 + index * 2,
        ]);
      }
    });
  }
});

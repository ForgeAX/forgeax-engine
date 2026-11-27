import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import {
  readMaterialTemplateSources,
  validateMaterialTemplatePublication,
} from '@forgeax/engine-pack/material-cook';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { withClipping } from '@forgeax/engine-types';
import { MeshPhysicalMaterial } from 'three/src/Three.Core.js';
import { projectMaterial, TEXTURE_SLOTS } from '../material';

import type { PhysicalTextureSlot } from './materials';

export async function cookPhysicalRecords(
  textureSets: readonly (readonly PhysicalTextureSlot[])[],
) {
  const cooker = createMaterialPackCooker([], { profile: 'webgpu-storage' });
  const records = [];
  const seen = new Set<string>();
  for (const slots of textureSets) {
    const parameters = [
      ...new Set(
        slots.map((slot) => {
          const parameter = TEXTURE_SLOTS[slot];
          if (parameter === undefined || slot === ('matcap' as PhysicalTextureSlot))
            throw new Error(`Unknown Physical texture slot: ${slot}`);
          return parameter;
        }),
      ),
    ].sort();
    if (parameters.includes('normalTexture') && parameters.includes('bumpTexture'))
      parameters.splice(parameters.indexOf('bumpTexture'), 1);
    const key = parameters.join('-');
    if (seen.has(key)) continue;
    seen.add(key);
    const cooked = await cooker.cook({
      guid: `forgeax-three-physical${key ? `-${key}` : ''}`,
      source: physicalSource(parameters),
    });
    if (
      cooked.payload === null ||
      typeof cooked.payload !== 'object' ||
      !('cooked' in cooked.payload)
    )
      throw new Error('Native Cook did not publish a material record');
    records.push(validateCookedMaterialRecord(cooked.payload.cooked).unwrap());
  }
  return records;
}

function physicalSource(
  parameters: readonly string[],
  placeholder = 'forgeax-three-build-placeholder',
) {
  return withClipping(
    projectMaterial(
      new MeshPhysicalMaterial(),
      Object.fromEntries(parameters.map((parameter) => [parameter, { texture: placeholder }])),
    ).unwrap(),
    { planes: [] },
  );
}

/** The built-in texture shapes share one verified WGSL closure. */
export async function publishPhysicalTemplates() {
  const cooker = createMaterialPackCooker([]);
  const templates = await Promise.all(
    [[], ['baseColorTexture']].map(async (slots, index) => {
      const draft = await cooker.cook({
        guid: `d870824b-928f-401a-8d77-a83a92ec0fe${index}`,
        source: physicalSource(slots, 'd870824b-928f-401a-8d77-a83a92ec0fef'),
        publication: 'templates',
      });
      const publication = validateMaterialTemplatePublication(
        (draft.payload as { template: unknown }).template,
      ).unwrap();
      const artifact = publication.sourceArtifact;
      const bytes = draft.artifacts[artifact.path]?.bytes;
      if (bytes === undefined) throw new Error('Missing Physical template source');
      readMaterialTemplateSources(bytes, artifact.digest).unwrap();
      return { key: slots.join('-'), publication, bytes };
    }),
  );
  const [first] = templates;
  if (first === undefined) throw new Error('Missing stock Physical template');
  if (
    templates.some(
      ({ publication }) =>
        publication.sourceArtifact.digest !== first.publication.sourceArtifact.digest,
    )
  )
    throw new Error('Built-in Physical shapes must share their source closure');
  return {
    sources: new TextDecoder().decode(first.bytes),
    recipes: Object.fromEntries(templates.map(({ key, publication }) => [key, publication])),
  };
}

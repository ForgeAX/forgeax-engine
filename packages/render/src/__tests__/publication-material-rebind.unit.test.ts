import { expect, it } from 'vitest';
import { MaterialResource } from '../material-resource';
import {
  publicationMaterialSchemaRebinder,
  rebindPublicationMaterialSchemas,
} from '../publication/programs';
import { defaultMaterialSnapshot } from '../render-system-extract';

const entryPoints = Object.freeze({ vertex: 'vs_main', fragment: 'fs_main' });
const artifact = { paramSchema: undefined, program: { entryPoints } };
const registry = {
  findMaterialArtifact: () => ({ ok: true, value: artifact }),
  materialArtifact: () => artifact,
} as never;

const material = {
  ...defaultMaterialSnapshot(7),
  materialShaderId: 'game::surface',
  passes: [{ name: 'forward', program: { module: 'game::surface' } }],
  materialProgramKeys: { forward: 'game::surface' },
};

it('keeps a re-published material identity when its program reads are unchanged', () => {
  const first = publicationMaterialSchemaRebinder(registry)(material);
  expect(first).not.toBe(material);
  expect(first.materialEntryPoints).toEqual({ forward: entryPoints });
  // Every publication creates a new rebinder; an already bound snapshot is stable.
  expect(publicationMaterialSchemaRebinder(registry)(first)).toBe(first);

  const resource = new MaterialResource(first);
  rebindPublicationMaterialSchemas(registry, { materialUpdates: [resource] } as never);
  expect(resource.snapshot).toBe(first);
});

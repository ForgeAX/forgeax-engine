import { expect, it } from 'vitest';
import { materialProgramInputs } from '../material-program-inputs';
import { MaterialResource } from '../material-resource';
import {
  publicationMaterialSchemaRebinder,
  rebindPublicationMaterialSchemas,
} from '../publication/programs';
import { defaultMaterialSnapshot } from '../render-system-extract';
import {
  requireWaterBodyBakedSources,
  waterMaterialNeedsSourceSnapshot,
  waterMaterialReadsBakedSource,
} from '../water/material-admission';

const entryPoints = Object.freeze([
  { name: 'vs_main', stage: 'vertex' as const, bindings: Object.freeze([]) },
  { name: 'fs_main', stage: 'fragment' as const, bindings: Object.freeze([]) },
]);
const artifact = { paramSchema: undefined, program: { entryPoints } };
const registry = {
  materialParamSchemaProjection: () => undefined,
  isSourceBackedMaterialArtifact: () => false,
  findMaterialArtifact: () => ({ ok: true, value: artifact }),
  materialArtifact: () => artifact,
};

const material = {
  ...defaultMaterialSnapshot(7),
  materialShaderId: 'game::surface',
  passes: [{ name: 'forward', program: { module: 'game::surface' } }],
  materialProgramKeys: { forward: 'game::surface' },
};

it('keeps a re-published material identity when its program reads are unchanged', () => {
  const first = publicationMaterialSchemaRebinder(registry as never)(material);
  expect(first).not.toBe(material);
  expect(first.materialProgramInputs).toEqual({ forward: { entryPoints } });
  // Every publication creates a new rebinder; an already bound snapshot is stable.
  expect(publicationMaterialSchemaRebinder(registry as never)(first)).toBe(first);

  const resource = new MaterialResource(first);
  rebindPublicationMaterialSchemas(registry as never, { materialUpdates: [resource] } as never);
  expect(resource.snapshot).toBe(first);
});

it('pairs compiled input reads with the matching certificate across clone and rebind', () => {
  const reads = Object.freeze([
    { name: 'fs_main', stage: 'fragment' as const, bindings: [{ group: 2, binding: 24 }] },
  ]);
  const systemInputs = Object.freeze({ water: 'water-frame/3' as const });
  const certifiedArtifact = {
    ...artifact,
    program: { entryPoints: reads },
    receipt: { systemInputs, entryPoints: [] },
  };
  const certifiedRegistry = { ...registry, materialArtifact: () => certifiedArtifact } as never;
  const first = publicationMaterialSchemaRebinder(certifiedRegistry)(material);
  expect(first.materialProgramInputs?.forward).toEqual({ entryPoints: reads, systemInputs });
  expect(waterMaterialReadsBakedSource(first.materialProgramInputs?.forward)).toBe(true);
  const copy = structuredClone(first);
  const rebound = publicationMaterialSchemaRebinder(certifiedRegistry)(copy);
  expect(rebound.materialProgramInputs?.forward?.entryPoints).toBe(reads);
  expect(rebound.materialProgramInputs?.forward?.systemInputs).toBe(systemInputs);
  expect(publicationMaterialSchemaRebinder(certifiedRegistry)(rebound)).toBe(rebound);
  const ordinary = publicationMaterialSchemaRebinder({
    ...registry,
    materialArtifact: () => ({ ...artifact, program: { entryPoints: reads } }),
  } as never)(rebound);
  expect(ordinary.materialProgramInputs?.forward).toEqual({ entryPoints: reads });
  expect(waterMaterialReadsBakedSource(ordinary.materialProgramInputs?.forward)).toBe(false);
});

it('does not classify an ordinary binding collision as a Water source requirement', () => {
  const reads = [
    { name: 'fs_main', stage: 'fragment' as const, bindings: [{ group: 2, binding: 24 }] },
  ];
  const ordinary = materialProgramInputs({ ...artifact, program: { entryPoints: reads } } as never);
  const water = materialProgramInputs({
    ...artifact,
    program: { entryPoints: reads },
    receipt: { systemInputs: { water: 'water-frame/3' } },
  } as never);
  if (ordinary === undefined || water === undefined) throw new Error('missing compiled inputs');
  expect(
    waterMaterialNeedsSourceSnapshot({ ...material, materialProgramInputs: { forward: ordinary } }),
  ).toBe(false);
  expect(
    waterMaterialNeedsSourceSnapshot({ ...material, materialProgramInputs: { forward: water } }),
  ).toBe(true);
  const system = { hasBakedQueryGrid: () => false } as never;
  const sources = [{ guid: 'body', generation: 3 }];
  expect(() => requireWaterBodyBakedSources(system, sources, [ordinary])).not.toThrow();
  expect(() => requireWaterBodyBakedSources(system, sources, [water])).toThrow(
    expect.objectContaining({ code: 'query-data-unavailable' }),
  );
});

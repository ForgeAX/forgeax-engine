import { expect, it } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../../render-system-extract';
import { retainedMaterialProgramFacts } from '../material-program-facts';

function snapshot(entry: string): MaterialSnapshot {
  return Object.freeze({
    ...defaultMaterialSnapshot(31),
    passes: Object.freeze([
      Object.freeze({
        name: 'forward',
        program: Object.freeze({ module: 'forgeax_material::standard' }),
      }),
    ]),
    materialProgramKeys: Object.freeze({ forward: 'cooked:forward' }),
    materialProgramInputs: Object.freeze({
      forward: Object.freeze({
        entryPoints: Object.freeze([
          Object.freeze({ name: entry, stage: 'fragment' as const, bindings: Object.freeze([]) }),
        ]),
      }),
    }),
    materialPublication: undefined,
    materialContext: undefined,
  });
}

it('retains the accepted program inputs across parameter writes and replaces changed entry reads', () => {
  const first = snapshot('fs_first');
  const material = new MaterialResource(first);
  const pass = first.passes[0];
  if (pass === undefined) throw new Error('fixture requires its forward pass');
  const observed = retainedMaterialProgramFacts(material, first, pass, undefined);
  expect(observed?.fact.fragmentEntryPoints).toEqual(['fs_first']);

  const parameters = Object.freeze({ ...first, roughness: 0.7 });
  material.adopt(parameters);
  expect(retainedMaterialProgramFacts(material, parameters, pass, undefined)).toBe(observed);

  const changed = Object.freeze({ ...snapshot('fs_changed'), passes: first.passes });
  material.adopt(changed);
  const next = retainedMaterialProgramFacts(material, changed, pass, undefined);
  expect(next).not.toBe(observed);
  expect(next?.fact.fragmentEntryPoints).toEqual(['fs_changed']);
  expect(observed?.fact.fragmentEntryPoints).toEqual(['fs_first']);
});

it('keeps mutable program inputs on the borrowed route', () => {
  const borrowed = Object.freeze({
    ...snapshot('fs_first'),
    materialProgramInputs: { forward: { entryPoints: [] } },
  });
  const pass = borrowed.passes[0];
  if (pass === undefined) throw new Error('fixture requires its forward pass');
  expect(
    retainedMaterialProgramFacts(new MaterialResource(borrowed), borrowed, pass, undefined),
  ).toBeUndefined();
});

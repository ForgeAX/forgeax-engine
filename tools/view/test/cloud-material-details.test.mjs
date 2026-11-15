import assert from 'node:assert/strict';
import { it } from 'node:test';
import { cloudDeclaredDependencyReference, cloudMaterialDetails, cloudParameterGroups, cloudProgramDetails, cloudThumbnailScope } from '../packages/view-plugin-asset/src/cloud-material.ts';

it('preserves owner parameter values and author groups while filtering details', () => {
  const parameters = [
    { name: 'bodyNoise', definition: { kind: 'texture', group: '01 - Cloud Shape', label: 'Noise_Texture3D' }, value: 'volume' },
    { name: 'layoutPattern', definition: { kind: 'texture', group: '00 - Cloud Layout' }, value: 'pattern' },
    { name: 'coverage', definition: { kind: 'scalar', group: '00 - Cloud Layout' }, value: -0.2, overridden: true },
  ];
  const details = cloudMaterialDetails({ meta: { kind: 'cloud-material', parameters } });
  assert.equal(details.parameters, parameters);
  assert.deepEqual(cloudParameterGroups(details).map(([group, rows]) => [group, rows.map(row => row.value)]), [
    ['00 - Cloud Layout', ['pattern', -0.2]], ['01 - Cloud Shape', ['volume']],
  ]);
  assert.equal(cloudParameterGroups(details, 'noise_texture3d')[0][1][0].value, 'volume');
  assert.equal(cloudMaterialDetails({ meta: { kind: 'cloud-material' } }), null);
});

it('invalidates thumbnail reads on exact target, publication and subject replacements', () => {
  const asset = { guid: 'cloud', kind: 'cloud-material' };
  const state = { project: { id: 'p', root: '/p' }, projectTarget: { targetId: 'target', generation: 1 }, openRequest: { asset }, assets: [{ guid: 'volume', publicationId: 'v1' }] };
  const scope = cloudThumbnailScope(state, ['volume']);
  assert.ok(scope);
  for (const next of [{ ...state, workspaceTargetLost: true }, { ...state, projectTarget: { targetId: 'target', generation: 2 } },
    { ...state, assets: [{ guid: 'volume', publicationId: 'v2' }] }, { ...state, openRequest: { asset: { ...asset, guid: 'other' } } }]) {
    assert.notEqual(cloudThumbnailScope(next, ['volume']), scope);
  }
});

it('keeps cooked program variants and declared dependencies separate from resolved parameters', () => {
  const variants = [{ programIdentity: 'authored-program', programDigest: 'digest', compilerIdentity: 'compiler',
    staticValues: { detail: false }, selected: true, renderer: { programDigest: 'renderer-digest' } }];
  const declaredDependencies = [{ guid: 'default-texture', kind: 'texture', declaredBy: 'material' },
    { guid: 'override-texture', kind: 'texture', declaredBy: 'instance' }];
  const details = { kind: 'cloud-material-instance', model: 'program', cookIdentity: 'cook', densityKernelIdentity: 'kernel',
    variants, declaredDependencies, dependenciesTruncated: true, parameters: [{ name: 'texture', value: 'override-texture' }] };
  assert.equal(cloudProgramDetails(details), details);
  assert.equal(cloudProgramDetails(details).variants, variants);
  assert.equal(cloudProgramDetails(details).declaredDependencies, declaredDependencies);
  assert.equal(cloudProgramDetails({ ...details, variants: undefined }), null);
  assert.equal(cloudProgramDetails({ ...details, declaredDependencies: undefined }), null);
  assert.equal(cloudProgramDetails({ ...details, cookIdentity: undefined }), null);
  assert.equal(cloudProgramDetails({ ...details, model: 'uniform', variants: [], declaredDependencies: [] }).variants.length, 0);
});

it('uses declared dependency identity and disables references absent from the current Catalog', () => {
  const dependency = { guid: 'texture', kind: 'texture', declaredBy: 'material' };
  assert.deepEqual(cloudDeclaredDependencyReference(dependency, [{ guid: 'texture', kind: 'texture', name: 'Noise' }]),
    { guid: 'texture', kind: 'texture', name: 'Noise', missing: false });
  for (const assets of [[], [{ guid: 'texture', kind: 'mesh', name: 'Wrong kind' }], [{ guid: 'texture', kind: 'texture', lifecycle: 'missing' }]]) {
    assert.equal(cloudDeclaredDependencyReference(dependency, assets).missing, true);
  }
  assert.equal(cloudDeclaredDependencyReference(dependency, []).guid, 'texture');
});

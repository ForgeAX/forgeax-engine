import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifySceneEntity, SCENE_ENTITY_KINDS } from '../packages/view-workspace-core/src/scene-entity-classification.ts';
import { normalizeSceneTreeRows } from '../packages/view-plugin-scene-tree/src/hierarchy.ts';
import { inspectorCollection, inspectorComponentTree, inspectorEntityFromInspection, inspectorFieldMatches, inspectorGroups, inspectorGroupsForComponents, inspectorSections, inspectorSectionsForComponents } from '../packages/view-plugin-inspector/src/inspection.ts';
import { entityInspectorCases, fixtureTransform } from './fixtures/entity-inspections.ts';

const inspect = components => inspectorEntityFromInspection({ entityId: 'world:5', entity: 5, name: null, components });
describe('all scene entity Details', () => {
  it('covers all 28 independently specified configurations in both scene views', () => {
    assert.equal(entityInspectorCases.length, 28);
    assert.deepEqual(new Set(entityInspectorCases.map(item => item.kind)), new Set(SCENE_ENTITY_KINDS));
    for (const item of entityInspectorCases) {
      const source = inspect([fixtureTransform, ...item.components]);
      assert.equal(source.kind, item.kind);
      assert.equal(source.name, 'Entity 5');
      assert(inspectorGroups(source).includes(item.group), `${item.kind} exposes ${item.group}`);
      assert.equal(inspectorSections(source, 'common')[0].component, 'Transform');
      assert.deepEqual(inspectorSections(source, 'all').flatMap(section => section.fields), source.components.flatMap(component => component.fields));
      const nodes = inspectorComponentTree(source);
      const projected = new Set(nodes.flatMap(node => node.components));
      for (const component of item.components) assert(projected.has(component.name), `${item.kind} projects ${component.name}`);
      for (const node of nodes) {
        const expected = source.components.filter(component => node.components.includes(component.name)).flatMap(component => component.fields);
        assert.deepEqual(inspectorSectionsForComponents(source, 'all', node.components).flatMap(section => section.fields), expected, `${item.kind}/${node.key} preserves its raw fields`);
      }
      const names = source.components.map(component => component.name);
      assert.equal(classifySceneEntity(names).kind, source.kind);
      assert.equal(normalizeSceneTreeRows({ nodes: [{ entityId: source.id, componentNames: names }] })[1].typeKey, source.kind);
      for (const component of item.components) assert(inspectorSections(source, item.group).some(section => section.component === component.name)
        || inspectorSections(source, 'common').some(section => section.component === component.name)
        || inspectorSections(source, 'animation').some(section => section.component === component.name));
    }
  });
  it('gives a scene root its own instance facts without promoting child meshes', () => {
    const source = inspect([fixtureTransform, ...entityInspectorCases.find(item => item.kind === 'sceneInstance').components]);
    assert.deepEqual(inspectorSections(source, 'common').map(section => section.component), ['Transform', 'SceneInstance']);
    assert.equal(source.components[1].fields.find(field => field.key === 'mapping').presentation, 'collection');
  });
  it('keeps current Engine presentation facts at the entity root without losing returned fields', () => {
    const source = inspect([
      fixtureTransform,
      { name: 'GlobalTransform', fields: { world: { type: 'array<f32, 16>' }, presentation: { type: 'array<f32, 16>' } },
        values: { world: Array(16).fill(0), presentation: Array(16).fill(1) } },
      { name: 'TransformInterpolation', fields: {}, values: {} },
      ...entityInspectorCases.find(item => item.kind === 'mesh').components,
    ]);
    assert.deepEqual(inspectorComponentTree(source).map(node => node.key), ['mesh']);
    const all = inspectorSections(source, 'all');
    assert(all.some(section => section.component === 'TransformInterpolation'));
    const transforms = all.find(section => section.component === 'GlobalTransform');
    assert.deepEqual(transforms.fields.map(field => field.key), ['world', 'presentation']);
    assert(transforms.fields.every(field => field.presentation === 'collection'));
    assert.deepEqual(all.flatMap(section => section.fields), source.components.flatMap(component => component.fields));
  });
  it('preserves current object-vector, enum-list, color and explicit asset-reference schemas', () => {
    const source = inspectorEntityFromInspection({ entityId: 'modern', components: [{
      name: 'Custom',
      fields: { vector: { type: 'vec3' }, mode: { type: 'enum', enum: ['first', 'second'] },
        color: { type: 'color' }, mesh: { type: 'AssetRef' } },
      values: { vector: { x: 1, y: 2, z: 3 }, mode: 'first', color: [0.5, 0.25, 0.125, 1],
        mesh: { guid: 'mesh-guid', kind: 'mesh', name: 'Current Mesh' } },
    }] }, [{ guid: 'mesh-guid', kind: 'mesh', name: 'Current Mesh' }]);
    const fields = Object.fromEntries(source.components[0].fields.map(field => [field.key, field]));
    assert.equal(fields.vector.kind, 'vector3');
    assert.deepEqual(fields.vector.value, { x: 1, y: 2, z: 3 });
    assert.deepEqual(fields.mode.options, ['first', 'second']);
    assert.deepEqual(fields.color.colorChannels, [0.5, 0.25, 0.125, 1]);
    assert.equal(fields.mesh.resource.guid, 'mesh-guid');
    assert.equal(fields.mesh.resource.asset.name, 'Current Mesh');
  });
  it('hides empty groups and falls back to Object for a transform-free generic entity', () => {
    const source = inspect([{ name: 'Entity', values: { self: 5 }, fields: { self: { type: 'entity' } } }]);
    assert.deepEqual(inspectorGroups(source), ['object', 'all']);
    assert.deepEqual(inspectorComponentTree(source), []);
    const unknown = inspect([{ name: 'Custom', values: { undeclared: [1, 2, 3] }, fields: {} }]);
    assert.deepEqual(inspectorGroups(unknown), ['all']);
    assert.equal(unknown.components[0].fields[0].presentation, 'collection');
  });
  it('keeps combined capabilities while respecting primary type priority', () => {
    const kinds = ['camera', 'mesh', 'physics', 'animation', 'audio', 'vfx', 'npc', 'sky', 'sceneInstance'];
    const source = inspect(kinds.flatMap(kind => entityInspectorCases.find(item => item.kind === kind).components));
    assert.equal(source.kind, 'camera');
    assert.deepEqual(inspectorGroups(source), ['common', 'object', 'rendering', 'physics', 'animation', 'media', 'effects', 'behavior', 'all']);
    assert(inspectorSections(source, 'rendering').some(section => section.kind === 'mesh'));
    assert(inspectorSections(source, 'rendering').some(section => section.kind === 'materials'));
    const animationNode = inspectorComponentTree(source).find(node => node.key === 'MorphWeights');
    assert(animationNode);
    assert(inspectorGroupsForComponents(source, animationNode.components).includes('animation'));
    assert(inspectorSectionsForComponents(source, 'all', animationNode.components).some(section => section.component === 'MorphWeights'));
    assert.equal(classifySceneEntity(['Instances']).kind, 'entity');
    assert.equal(classifySceneEntity(['GlyphText', 'MeshFilter', 'MeshRenderer']).kind, 'text');
  });
  it('shows enum zero labels and distinguishes collection, vector, color and resource schemas', () => {
    const physics = inspect(entityInspectorCases.find(item => item.kind === 'physics').components);
    assert.equal(physics.components[0].fields[0].kind, 'enum');
    assert.equal(physics.components[0].fields[0].value, 'static');
    assert.equal(physics.components[0].fields[0].rawValue, 0);
    const animation = inspect(entityInspectorCases.find(item => item.kind === 'animation').components);
    assert.equal(animation.components[0].fields.find(field => field.key === 'weights').presentation, 'collection');
    assert.equal(animation.components[0].fields.find(field => field.key === 'clips').presentation, 'collection');
    const light = inspect(entityInspectorCases.find(item => item.kind === 'directionalLight').components);
    assert.deepEqual(light.components[0].fields[0].colorChannels, [1, 0.85, 0.6]);
    const source = inspect([fixtureTransform]);
    assert.equal(source.components[0].fields[1].kind, 'angle3');
    assert.deepEqual(Object.keys(source.components[0].fields[1].value), ['x', 'y', 'z']);
    assert.deepEqual(source.components[0].fields[1].rawValue, fixtureTransform.values.quat);
  });
  it('retains Engine truncation and unavailability rather than implying complete collections', () => {
    const collection = inspectorCollection({ items: [1, 2, 3], truncated: true, length: 300 });
    assert.equal(collection.length, 300); assert.equal(collection.entries.length, 3); assert.equal(collection.truncated, true);
    assert.equal(inspectorCollection({ fields: { a: 1 }, truncated: true, length: 200 }).entries[0][0], 'a');
    assert.equal(inspectorCollection({ unavailable: 'depth-limit' }).unavailable, 'depth-limit');
    const source = inspect([{ name: 'MeshRenderer', values: { materials: { items: [1025, 0], truncated: true, length: 300 } }, fields: { materials: { type: 'array<shared<MaterialAsset>>' } } }]);
    assert.equal(source.materialOverridesTruncated, true);
    assert.equal(source.materialOverrides.length, 2);
    assert.equal(source.materialOverrides[1].inherited, true);
    const unique = inspect([{ name: 'SceneInstance', values: { state: 12 }, fields: { state: { type: 'unique<SceneInstanceState>' } } }]);
    assert.equal(unique.components[0].fields[0].presentation, 'handle');
    const colorCollection = inspect([{ name: 'Custom', values: { color: [1, 2, 3] }, fields: { color: { type: 'array<entity>' } } }]);
    assert.equal(colorCollection.components[0].fields[0].presentation, 'collection');
  });
  it('only navigates explicit GUIDs and searches actual resource names', () => {
    const components = [{ name: 'AudioSource', values: { clip: 'audio-guid' }, fields: { clip: { type: 'shared<AudioClipAsset>' } } }];
    const source = inspectorEntityFromInspection({ entityId: 'audio', components }, [{ guid: 'audio-guid', kind: 'audio', name: 'Ambient Wind' }]);
    assert.equal(source.components[0].fields[0].resource.guid, 'audio-guid');
    assert.equal(inspectorFieldMatches(source.components[0].fields[0], 'wind'), true);
    for (const value of [1025, 0, { unavailable: 'opaque-value' }]) {
      components[0].values.clip = value;
      assert.equal(inspect(components).components[0].fields[0].resource.guid, undefined);
    }
  });
});

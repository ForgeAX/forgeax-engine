import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compactInspectorTransform, inspectorComponentDisplayName, inspectorComponentTree, inspectorEntityFromInspection, inspectorGroups, inspectorGroupsForComponents,
  inspectorResourceReference, inspectorSectionMatches, inspectorSections, inspectorSectionsForComponents, inspectorWorkspaceTarget,
} from '../packages/view-plugin-inspector/src/inspection.ts';

function entity(extra = []) {
  return inspectorEntityFromInspection({ entityId: 'floor', name: 'Floor', components: [
    { name: 'Entity', fields: { self: { type: 'entity' } }, values: { self: 0 } },
    { name: 'Transform', fields: { pos: { type: 'array<f32, 3>' }, quat: { type: 'array<f32, 4>' }, scale: { type: 'array<f32, 3>' } }, values: { pos: [0, -0.28, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { name: 'GlobalTransform', fields: { world: { type: 'array<f32, 16>' } }, values: { world: Array(16).fill(0) } },
    { name: 'MeshFilter', fields: { assetHandle: { type: 'asset<mesh>' } }, values: { assetHandle: 1025 } },
    { name: 'MeshRenderer', fields: { materials: { type: 'array<asset<material>>' }, lightingChannels: { type: 'f64' } }, values: { materials: [1026, 1027, 1028], lightingChannels: 1 } },
    ...extra,
  ] });
}

describe('mesh inspector presentation', () => {
  it('defaults to exactly three common sections and exposes only populated functional groups', () => {
    const source = entity();
    assert.deepEqual(inspectorGroups(source), ['common', 'object', 'rendering', 'all']);
    assert.deepEqual(inspectorSections(source, 'common').map(section => section.key), ['Transform', 'mesh', 'materials']);
    assert.deepEqual(inspectorSections(source, 'rendering')[0].fields.map(field => field.key), ['lightingChannels']);
    assert.deepEqual(inspectorSections(source, 'all').map(section => section.key), source.components.map(component => component.name));
    assert.equal(source.components.find(component => component.name === 'MeshRenderer').fields[0].kind, 'text');
    assert.equal(source.components.find(component => component.name === 'MeshRenderer').fields[0].value, '[1026,1027,1028]');
  });
  it('shows XYZ rotation while retaining raw quaternion, enum labels and unknown components', () => {
    const source = entity([
      { name: 'Mobility', fields: { kind: { type: 'enum', labels: { static: 0, movable: 2 } } }, values: { kind: 2 } },
      { name: 'Collider', fields: { size: { type: 'number' } }, values: { size: 2 } },
      { name: 'CustomHealth', fields: { health: { type: 'f32' } }, values: { health: 7 } },
    ]);
    assert.deepEqual(inspectorGroups(source), ['common', 'object', 'rendering', 'physics', 'all']);
    const rotation = source.components.find(c => c.name === 'Transform').fields[1];
    assert.equal(rotation.kind, 'angle3');
    assert.deepEqual(rotation.value, { x: 0, y: 0, z: 0 });
    assert.deepEqual(rotation.rawValue, [0, 0, 0, 1]);
    assert.equal(source.components.find(c => c.name === 'Mobility').fields[0].value, 'movable');
    assert.equal(source.components.find(c => c.name === 'Mobility').fields[0].rawValue, 2);
    assert.deepEqual(inspectorComponentTree(source).map(node => node.key), ['mesh', 'Collider', 'CustomHealth']);
  });
  it('projects the entity root and one composite mesh node without exposing child entities', () => {
    const source = entity([{ name: 'SceneInstance', fields: { state: { type: 'string' } }, values: { state: 'ready' } }]);
    const nodes = inspectorComponentTree(source);
    assert.deepEqual(nodes.map(node => node.key), ['mesh', 'SceneInstance']);
    assert.deepEqual(nodes[0].components, ['MeshFilter', 'MeshRenderer']);
    assert.equal(nodes.some(node => node.key === 'Floor Trim'), false);
    assert.deepEqual(inspectorGroupsForComponents(source, nodes[0].components), ['common', 'rendering', 'all']);
    assert.deepEqual(inspectorSectionsForComponents(source, 'common', nodes[0].components).map(section => section.key), ['mesh', 'materials']);
    assert.deepEqual(inspectorSectionsForComponents(source, 'all', nodes[0].components).map(section => section.component), ['MeshFilter', 'MeshRenderer']);
  });
  it('keeps partial mesh bindings visible without inventing missing component fields', () => {
    const source = inspectorEntityFromInspection({ entityId: 'partial', components: [
      { name: 'MeshFilter', fields: { assetHandle: { type: 'asset<mesh>' } }, values: { assetHandle: 1025 } },
    ] });
    const [meshNode] = inspectorComponentTree(source);
    assert.deepEqual(meshNode.components, ['MeshFilter']);
    assert.deepEqual(inspectorSectionsForComponents(source, 'common', meshNode.components).map(section => section.kind), ['mesh']);
    assert.deepEqual(inspectorSectionsForComponents(source, 'all', meshNode.components).map(section => section.component), ['MeshFilter']);
  });
  it('groups point-light shadow data with its light and preserves both raw components in All', () => {
    const source = inspectorEntityFromInspection({ entityId: 'point', components: [
      { name: 'PointLight', fields: { intensity: { type: 'f32' } }, values: { intensity: 3 } },
      { name: 'PointLightShadow', fields: { enabled: { type: 'bool' } }, values: { enabled: true } },
    ] });
    const [node] = inspectorComponentTree(source);
    assert.deepEqual(node.components, ['PointLight', 'PointLightShadow']);
    assert.deepEqual(inspectorSectionsForComponents(source, 'all', node.components).map(section => section.component), node.components);
  });
  it('omits entity-level settings from the component projection but retains them in All', () => {
    const source = entity([
      { name: 'ChildOf', fields: { parent: { type: 'entity' } }, values: { parent: 3 } },
      { name: 'Children', fields: { ids: { type: 'array<entity>' } }, values: { ids: [4, 5] } },
      { name: 'Visibility', fields: { visible: { type: 'bool' } }, values: { visible: true } },
      { name: 'Layer', fields: { layer: { type: 'u32' } }, values: { layer: 2 } },
    ]);
    const keys = inspectorComponentTree(source).map(node => node.key);
    assert.deepEqual(keys, ['mesh']);
    assert.deepEqual(inspectorSections(source, 'all').map(section => section.component), source.components.map(component => component.name));
  });
  it('shows custom and unknown functional components by their returned names', () => {
    const source = inspectorEntityFromInspection({ entityId: 'custom', components: [
      { name: 'CustomHealth', fields: { health: { type: 'f32' } }, values: { health: 7 } },
    ] });
    assert.deepEqual(inspectorComponentTree(source).map(node => ({ key: node.key, components: node.components })), [
      { key: 'CustomHealth', components: ['CustomHealth'] },
    ]);
    assert.deepEqual(inspectorSectionsForComponents(source, 'all', ['CustomHealth']).map(section => section.fields[0].rawValue), [7]);
    assert.equal(inspectorComponentDisplayName('CustomHealth', key => key), 'CustomHealth');
    assert.equal(inspectorComponentDisplayName('RigidBody', key => key === 'inspector.component.RigidBody' ? '刚体' : key), '刚体');
  });
  it('combines mesh, skin and instance data only when a mesh component is present', () => {
    const combined = entity([
      { name: 'Skin', fields: {}, values: {} }, { name: 'Instances', fields: {}, values: {} },
    ]);
    assert.deepEqual(inspectorComponentTree(combined)[0].components, ['MeshFilter', 'MeshRenderer', 'Skin', 'Instances']);
    assert.equal(inspectorComponentTree(combined)[0].kind, 'skinnedMesh');
    const standaloneSkin = inspectorEntityFromInspection({ entityId: 'skin', components: [{ name: 'Skin', fields: {}, values: {} }] });
    assert.deepEqual(inspectorComponentTree(standaloneSkin).map(node => node.components), [['Skin']]);
  });
  it('matches resource identities as well as component and property names', () => {
    const source = entity();
    const sections = inspectorSections(source, 'common');
    assert.equal(inspectorSectionMatches(sections[1], source, '1025', 'Static Mesh'), true);
    assert.equal(inspectorSectionMatches(sections[2], source, '1026', 'Materials'), true);
    assert.equal(inspectorSectionMatches(sections[0], source, 'quat', 'Transform'), true);
    assert.equal(inspectorSectionMatches(sections[1], source, 'unrelated', 'Static Mesh'), false);
  });
  it('formats Float32 display noise without changing the original copy value', () => {
    const rawValue = [0, -0.2800000011920929, 0];
    const field = { key: 'pos', kind: 'vector3', value: { x: 0, y: rawValue[1], z: 0 }, rawValue };
    assert.equal(compactInspectorTransform(field).value.y, -0.28);
    assert.deepEqual(compactInspectorTransform(field).rawValue, rawValue);
    assert.equal(field.value.y, rawValue[1]);
  });
  it('uses only explicit resource identities and does not equate World handles with catalog GUIDs', () => {
    const catalog = [{ guid: 'mesh-guid', kind: 'mesh', name: 'Stone Floor', path: 'assets/floor.pack.ts' }];
    assert.equal(inspectorResourceReference(1025, 'mesh', catalog).guid, undefined);
    assert.equal(inspectorResourceReference('mesh-guid', 'mesh', catalog).asset, catalog[0]);
    const source = entity();
    source.raw.components.find(c => c.name === 'MeshRenderer').values.materials = [];
    const empty = inspectorEntityFromInspection(source.raw);
    assert.deepEqual(empty.materialOverrides, []);
    assert.equal('materialSlots' in empty.raw, false);
  });
  it('uses the unified presentation for skinned meshes and non-mesh entities', () => {
    assert.equal(entity([{ name: 'Skin', fields: {}, values: {} }]).kind, 'skinnedMesh');
    assert.equal(inspectorEntityFromInspection({ entityId: 'light', components: [{ name: 'DirectionalLight', fields: {}, values: {} }] }).kind, 'directionalLight');
  });
  it('keeps entity reads on their Scene binding while an independent resource preview is selected', () => {
    const scene = { targetId: 'scene', generation: 4 };
    const workspace = { scenePreview: { target: scene }, preview: { target: { targetId: 'mesh-preview', generation: 1 } }, sceneSelection: { targetId: 'scene', targetGeneration: 4, primary: { entityId: 'floor' } } };
    assert.equal(inspectorWorkspaceTarget(workspace), scene);
    assert.equal(inspectorWorkspaceTarget({ ...workspace, sceneSelection: { ...workspace.sceneSelection, targetGeneration: 3 } }), undefined);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { euler, quat } from '@forgeax/engine/math';

import {
  formatInspectorFieldLabel,
  inspectorEntityFromInspection,
} from '../packages/view-plugin-inspector/src/inspection.ts';
import { inspectorColorHex, inspectorFormGroupsFromInspection } from '../packages/view-components/src/inspector-form-model.ts';
import { INSPECTIONS, SCENE_NODES } from '../apps/view-fixture-host/src/scenarios/default.ts';

describe('Object inspector data source', () => {
  it('keeps native metadata paths distinct from identity fields', () => {
    const groups = inspectorFormGroupsFromInspection({ guid: 'mesh-guid', asset: { kind: 'mesh' },
      meta: { kind: 'mesh', vertexCount: 24, collision: { kind: 'triangles' } } });
    const fields = groups[0].fields;
    assert.equal(new Set(fields.map(field => field.key)).size, fields.length);
    assert.equal(fields.find(field => field.key === 'kind').value, 'mesh');
    assert.equal(fields.find(field => field.key === 'meta.kind').value, 'mesh');
    assert.equal(groups[1].fields[0].key, 'meta.collision.kind');
  });

  const inspectRotation = (value, component = 'Transform', labels = {}) => inspectorEntityFromInspection({
    entityId: 'world:1',
    components: [{ name: component, fields: { quat: { type: 'array<f32, 4>' } }, values: { quat: value } }],
  }, [], labels).components[0].fields[0];

  const assertDegrees = (field, expected) => {
    assert.equal(field.kind, 'angle3');
    assert.deepEqual(Object.keys(field.value), ['x', 'y', 'z']);
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(field.value[axis] - expected[axis]) < 0.001, `${axis}: ${field.value[axis]}`);
  };

  it('does not mirror content-browser asset inspection', () => {
    const fromCatalog = inspectorEntityFromInspection({
      guid: 'scene-guid',
      asset: { name: 'MainScene', kind: 'scene', sourcePath: 'assets/scene.pack.ts' },
      source: { path: 'assets/scene.pack.ts', kind: 'pack.ts' },
    });
    assert.equal(fromCatalog, null, 'asset metadata is not a live entity inspection');
  });

  it('formats only live Transform.quat as XYZ degrees while preserving its raw value', () => {
    assert.equal(formatInspectorFieldLabel('halfExtents'), 'Half Extents');
    assert.equal(formatInspectorFieldLabel('pos'), 'Pos');

    const entity = inspectorEntityFromInspection({
      entityId: 'world:1',
      name: 'Knot',
      components: [{
        name: 'Transform',
        fields: { pos: { type: 'vec3' }, quat: { type: 'quat' }, scale: { type: 'vec3' } },
        values: {
          pos: [4.4, 2.05, -4],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      }],
    });

    const fields = entity.components[0].fields;
    assert.deepEqual(fields.map((field) => field.label), ['Pos', 'Rotation', 'Scale']);
    assert.equal(fields[0].kind, 'vector3');
    assert.deepEqual(fields[0].value, { x: 4.4, y: 2.05, z: -4 });
    assertDegrees(fields[1], { x: 0, y: 0, z: 0 });
    assert.deepEqual(fields[1].rawValue, [0, 0, 0, 1]);
    const other = inspectRotation([0, 0, 0, 1], 'Orientation');
    assert.equal(other.kind, 'vector4');
    assert.equal(other.value.w, 1);
  });

  it('handles single axes, composed XYZ rotations, sign equivalence and normalization', () => {
    const half = Math.SQRT1_2;
    assertDegrees(inspectRotation([half, 0, 0, half]), { x: 90, y: 0, z: 0 });
    assertDegrees(inspectRotation([0, -Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]), { x: 0, y: -45, z: 0 });
    assertDegrees(inspectRotation([0, 0, half, half]), { x: 0, y: 0, z: 90 });
    const screenshotQuat = [-Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)];
    assertDegrees(inspectRotation(screenshotQuat), { x: -30, y: 0, z: 0 });
    assert.deepEqual(inspectRotation(screenshotQuat).rawValue, screenshotQuat);
    const gimbal = inspectRotation([0, -half, 0, half]);
    assert.equal(gimbal.kind, 'angle3');
    assert.ok(Math.abs(gimbal.value.y + 90) < 0.1);
    assert.ok(Object.values(gimbal.value).every(Number.isFinite));
    const composed = Array.from(quat.fromEuler(quat.create(), Math.PI / 6, Math.PI / 4, -Math.PI / 3, 'XYZ'));
    assertDegrees(inspectRotation(composed), { x: 30, y: 45, z: -60 });
    assertDegrees(inspectRotation(composed.map(part => -part)), { x: 30, y: 45, z: -60 });
    assertDegrees(inspectRotation(composed.map(part => part * 3)), { x: 30, y: 45, z: -60 });
  });

  it('agrees with Engine XYZ extraction for representative orientations', () => {
    for (const [x, y, z] of [[0.3, -0.5, 1.1], [-1.4, 0.7, -2.8], [2.5, -1.2, 0.4]]) {
      const original = quat.fromEuler(quat.create(), x, y, z, 'XYZ');
      const normalized = quat.normalize(quat.create(), original);
      const reference = euler.fromQuat(euler.create(), normalized, 'XYZ');
      const actual = inspectRotation(Array.from(original)).value;
      for (const axis of ['x', 'y', 'z']) {
        assert.ok(Math.abs(actual[axis] - reference[axis] * 180 / Math.PI) < 0.001, `${axis}: ${actual[axis]}`);
      }
      const restored = quat.fromEuler(quat.create(), actual.x * Math.PI / 180, actual.y * Math.PI / 180, actual.z * Math.PI / 180, 'XYZ');
      assert.ok(Math.abs(quat.dot(restored, normalized)) > 1 - 1e-6);
    }
  });

  it('shows localized unavailability for malformed quaternions without introducing W', () => {
    for (const value of [undefined, [0, 0, 0, 0], [0, 0, null, 1], [0, 0, Number.NaN, 1], [0, 0, 1]]) {
      const field = inspectRotation(value);
      assert.equal(field.label, 'Rotation');
      assert.equal(field.kind, 'text');
      assert.equal(field.value, 'Unavailable');
      assert.deepEqual(field.rawValue, value);
    }
    const localized = inspectRotation([0, 0, 0, 0], 'Transform', { rotation: '旋转', unavailable: '不可用' });
    assert.equal(localized.label, '旋转');
    assert.equal(localized.value, '不可用');
  });

  it('projects every fixture field control from the Player inspection', () => {
    const entity = inspectorEntityFromInspection(INSPECTIONS.player);
    assert.ok(entity);
    assert.deepEqual(
      SCENE_NODES.find(node => node.entityId === 'player').componentNames,
      entity.components.map(component => component.name),
    );
    const fields = entity.components.flatMap(component => component.fields);
    assert.deepEqual(new Set(fields.map(field => field.kind)), new Set([
      'vector3', 'vector4', 'angle3', 'number', 'bool', 'switch', 'text', 'enum', 'color', 'asset',
    ]));
    const field = key => fields.find(item => item.key === key);
    assert.deepEqual(field('mode').options, ['Third Person', 'First Person', 'Orbit']);
    assert.equal(field('active').value, true);
    assert.equal(field('offset').kind, 'vector3');
    assert.equal(field('grounded').value, false);
    assert.deepEqual(field('mesh').value, { guid: 'fixture-geometry-capsule', name: 'geometry/capsule', kind: 'mesh' });
    assert.equal(field('overrideMaterial').value, '');
    assert.deepEqual(field('missingMaterial').value, { guid: 'fixture-missing-material', missing: true });
    assert.deepEqual(field('orientation').value, { x: 0, y: 0, z: 0, w: 1 });
  });

  it('keeps numeric shared-asset handles in reference controls', () => {
    const entity = inspectorEntityFromInspection({ entityId: 'world:2', components: [{
      name: 'MeshFilter',
      fields: { mesh: { type: 'asset<mesh>' }, optionalMesh: { type: 'asset<mesh>' } },
      values: { mesh: 42, optionalMesh: 0 },
    }] });
    assert.deepEqual(entity.components[0].fields.map(({ kind, value }) => ({ kind, value })), [
      { kind: 'asset', value: { name: 'Handle 42' } },
      { kind: 'asset', value: '' },
    ]);
  });

  it('presents linear color values in sRGB without changing the source channels', () => {
    const value = [0.5, 0, 0, 0.5];
    const entity = inspectorEntityFromInspection({ entityId: 'world:3', components: [{
      name: 'MeshRenderer', fields: { tint: { type: 'color' } }, values: { tint: value },
    }] });
    assert.equal(entity.components[0].fields[0].kind, 'color');
    assert.deepEqual(entity.components[0].fields[0].value, value);
    assert.equal(inspectorColorHex(value), '#BC000080');
  });
});

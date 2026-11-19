import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  degrees, groundShadowCamera, referenceCamera, REFERENCE_EYE, REFERENCE_VERTICAL_FOV, shadowInspectionCamera,
  stepGroundCamera, viewDirection,
} from '../terrain.ts';
import { cameraTransform } from '../ground-scene.ts';

it('frames both band edges from a near-ground receiver inside both shadow footprints', () => {
  const camera = groundShadowCamera();
  assert.equal(camera.y, 20);
  assert.ok(camera.z < 800);
  assert.equal(cameraTransform(camera).pos[1], 20);
  const direction = viewDirection(camera.yaw, camera.pitch);
  assert.ok(direction[2] > 0);
  const groundZ = camera.z - direction[2] * camera.y / direction[1];
  assert.ok(groundZ > camera.z && groundZ < 800);
  const edges = [800, 1600].map(z => Math.atan2(-camera.y, z - camera.z));
  for (const elevation of edges) assert.ok(Math.abs(elevation - camera.pitch) < REFERENCE_VERTICAL_FOV / 2);
  assert.ok(Math.abs(edges[0] - edges[1]) > 3 * degrees);
  stepGroundCamera(camera, 0, 1, 0, 0, 1);
  assert.equal(camera.y, 20);
  assert.ok(camera.z > groundShadowCamera().z);
});

it('preserves the accepted elevated inspection and original reference camera exactly', () => {
  assert.deepEqual(shadowInspectionCamera(), { x: 0, y: 2000, z: 3600, yaw: 0, pitch: -40 * degrees });
  const camera = referenceCamera();
  assert.deepEqual([camera.x, camera.y, camera.z], REFERENCE_EYE);
  assert.equal(camera.yaw, 121.540557 * degrees);
  assert.equal(camera.pitch, 11.521956 * degrees);
});

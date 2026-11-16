import assert from 'node:assert/strict';
import { it } from 'node:test';
import { shadowConsumerFields } from '../cloud-shadow-controls.ts';
import { degrees, REFERENCE_EYE, referenceCamera, shadowInspectionCamera, stepGroundCamera, viewDirection } from '../terrain.ts';
import { cameraTransform } from '../ground-scene.ts';

it('toggles ground and atmosphere consumers independently while retaining the other strength', () => {
  for (const groundShadowEnabled of [false, true]) for (const atmosphereShadowEnabled of [false, true]) {
    assert.deepEqual(shadowConsumerFields({ groundShadowEnabled, atmosphereShadowEnabled,
      surfaceShadowStrength: 0.7, atmosphereShadowStrength: 0.4 }), {
      castCloudShadows: groundShadowEnabled || atmosphereShadowEnabled,
      surfaceShadowStrength: groundShadowEnabled ? 0.7 : 0,
      atmosphereShadowStrength: atmosphereShadowEnabled ? 0.4 : 0,
    });
  }
  assert.deepEqual(shadowConsumerFields({ groundShadowEnabled: true, atmosphereShadowEnabled: true,
    surfaceShadowStrength: 0, atmosphereShadowStrength: 0 }), {
    castCloudShadows: true, surfaceShadowStrength: 0, atmosphereShadowStrength: 0,
  });
});

it('retains the frozen ground eye, speed and lower pitch bound alongside the inspection view', () => {
  const camera = referenceCamera();
  assert.deepEqual(cameraTransform(camera).pos, REFERENCE_EYE);
  const initial = { ...camera };
  stepGroundCamera(camera, 1, 1, 0, -90 * degrees, 1);
  assert.equal(camera.y, REFERENCE_EYE[1]);
  assert.ok(Math.abs(Math.hypot(camera.x - initial.x, camera.z - initial.z) - 3) < 1e-10);
  assert.equal(camera.pitch, -20 * degrees);
});

it('frames both kilometer-scale band boundaries on the ground from below the cloud layer', () => {
  const camera = shadowInspectionCamera();
  assert.ok(camera.y > 1000 && camera.y < 5000);
  assert.equal(cameraTransform(camera).pos[1], camera.y);
  const ray = viewDirection(camera.yaw, camera.pitch);
  const groundZ = camera.z - ray[2] * camera.y / ray[1];
  assert.ok(groundZ > 800 && groundZ < 1600);
  assert.ok(camera.pitch < -20 * degrees);
  assert.deepEqual(shadowInspectionCamera(), camera);
});

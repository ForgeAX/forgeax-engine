import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SPOT_SHADOW_SCENES } from '../../src/spot-shadow-scene.ts';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);
const outputPath = process.env.FORGEAX_CANONICAL_ORACLE_OUTPUT === undefined
  ? resolve(scriptDirectory, 'canonical-direct-light-oracle.json')
  : resolve(process.env.FORGEAX_CANONICAL_ORACLE_OUTPUT);
const sceneSourcePath = resolve(scriptDirectory, '../../src/spot-shadow-scene.ts');
const materialSourcePath = resolve(scriptDirectory, '../../src/main.ts');
const calibrationPath = resolve(scriptDirectory, 'calibration/three-r184-finite-range-authority.json');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

const RECEIVER_BASE_COLOR = [0.55, 0.55, 0.6];
const RECEIVER_NORMAL = [0, 1, 0];
const DIRECTIONAL_LIGHT = {
  direction: [-0.2, -1, -0.3],
  color: [1, 1, 1],
  intensity: 0.5,
};
const POINT_LIGHTS = [
  { position: [0.7, 0.2, 2], color: [1, 1, 1], intensity: 100, range: 50 },
  { position: [2.3, -3.3, -4], color: [1, 0, 0], intensity: 100, range: 50 },
  { position: [-4, 2, -12], color: [0, 1, 0], intensity: 100, range: 50 },
  { position: [0, 0, -3], color: [0, 0, 1], intensity: 100, range: 50 },
];

function addRgb(left, right) {
  return left.map((value, index) => value + right[index]);
}

function scaleRgb(value, scale) {
  return value.map((channel) => channel * scale);
}

function lightVector(position, target) {
  return position.map((value, index) => value - target[index]);
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function diffuseLight(position, target, color, intensity, range) {
  const vector = lightVector(position, target);
  const distanceSquared = vector.reduce((sum, value) => sum + value ** 2, 0);
  const distance = Math.sqrt(distanceSquared);
  const normalDot = Math.max(dot(RECEIVER_NORMAL, vector) / distance, 0);
  const finiteRange = clamp(1 - (distance / range) ** 4, 0, 1) ** 2;
  const irradiance = intensity * normalDot * finiteRange / distanceSquared;
  return color.map((channel, index) => irradiance * channel * RECEIVER_BASE_COLOR[index] / Math.PI);
}

function directionalDiffuse(direction, color, intensity) {
  const length = Math.hypot(...direction);
  const normalDot = Math.max(dot(RECEIVER_NORMAL, direction.map((value) => -value)) / length, 0);
  const irradiance = intensity * normalDot;
  return color.map((channel, index) => irradiance * channel * RECEIVER_BASE_COLOR[index] / Math.PI);
}

function deriveExpected(scene) {
  // The direct-light fixture deliberately keeps the shared caster setup: the
  // receiver sees one directional light and four colored point lights in
  // addition to the spot. This is a source-derived analytic RGB oracle, not a
  // projection of Browser or Dawn observations. The named ROIs are represented
  // by the deterministic camera target sample; all arithmetic remains linear.
  const target = scene.camera.target;
  const nonSpot = POINT_LIGHTS.reduce(
    (sum, light) => addRgb(sum, diffuseLight(light.position, target, light.color, light.intensity, light.range)),
    directionalDiffuse(DIRECTIONAL_LIGHT.direction, DIRECTIONAL_LIGHT.color, DIRECTIONAL_LIGHT.intensity),
  );
  const spotVector = lightVector(scene.light.position, target);
  const spotDistanceSquared = spotVector.reduce((sum, value) => sum + value ** 2, 0);
  const spotDistance = Math.sqrt(spotDistanceSquared);
  const spotNormalDot = Math.max(spotVector[1] / spotDistance, 0);
  const spotAttenuation = clamp(1 - (spotDistance / scene.light.range) ** 4, 0, 1) ** 2;
  const spotIrradiance = scene.light.intensity * spotNormalDot * spotAttenuation / spotDistanceSquared;
  const spot = scene.light.color.map((channel, index) => spotIrradiance * channel * RECEIVER_BASE_COLOR[index] / Math.PI);

  // The shadow ROI retains the shared non-spot lighting while the caster
  // attenuates the spot contribution by the fixture's existing shadow fill.
  // These are fixed source-model constants, independent of observed pixels.
  const shadowFill = 0.55;
  const spotVisibleInLitRoi = 0.6;
  const baseShadow = scaleRgb(nonSpot, shadowFill);
  const baseLit = addRgb(baseShadow, scaleRgb(spot, spotVisibleInLitRoi));
  const clearcoatGain = 1 + (1 - 0.9);
  const clearcoatLit = scaleRgb(baseLit, clearcoatGain);
  const clearcoatShadow = scaleRgb(baseShadow, clearcoatGain);
  const baseDelta = baseLit.map((value, index) => value - baseShadow[index]);
  const clearcoatDelta = clearcoatLit.map((value, index) => value - clearcoatShadow[index]);
  return {
    base: { rgb: baseLit, shadowRgb: baseShadow, deltaRgb: baseDelta },
    clearcoat: { rgb: clearcoatLit, shadowRgb: clearcoatShadow, deltaRgb: clearcoatDelta },
    clearcoatDelta: { rgb: clearcoatDelta },
  };
}

const scene = SPOT_SHADOW_SCENES.hdrp;
const sceneInput = {
  scene: scene.scene,
  camera: scene.camera,
  floor: scene.floor,
  occluder: scene.occluder,
  light: scene.light,
  roi: scene.roi,
};
const calibration = JSON.parse(readFileSync(calibrationPath, 'utf8'));
const expected = deriveExpected(scene);
const sceneDigest = `sha256:${sha256(canonicalJson(sceneInput))}`;
const roiDigest = `sha256:${sha256(canonicalJson({
  method: 'linear-HDR channel-wise mean over every pixel in each named ROI',
  rois: scene.roi,
  colorDomain: 'linearHdr',
}))}`;
const aggregation = {
  method: 'linear-HDR channel-wise mean over every pixel in each named ROI',
  colorDomain: 'linearHdr',
  rois: scene.roi,
};
const sourceSha256 = `sha256:${sha256(readFileSync(sceneSourcePath))}`;
const materialSourceSha256 = `sha256:${sha256(readFileSync(materialSourcePath))}`;
const inputDigest = `sha256:${sha256(canonicalJson({
  scene: sceneInput,
  calibration,
  sourceSha256,
    materialSource: {
      path: 'apps/parity/color-lighting/src/main.ts',
      sha256: materialSourceSha256,
      fixedValues: 'direct spot-shadow material: baseColor=[0.55,0.55,0.6], roughness=0.9, clearcoat=1, clearcoatRoughness=0.2; directional=[-0.2,-1,-0.3], intensity=0.5; point colors=[white,red,green,blue], intensity=100, range=50',
    },
}))}`;
const generatorSha256 = sha256(readFileSync(scriptPath));
const oracleCore = {
  schema: 'forgeax.direct-light.canonical-oracle/1',
  authorityId: 'SPOT_SHADOW_SCENES',
  sceneId: 'direct-spot-shadow-v1',
  sceneDigest,
  roiDigest,
  aggregation,
  expected,
  epsilonAbs: 0.05,
  pairwiseEpsilonAbs: 0.05,
};
const payloadBytesSha256 = `sha256:${sha256(canonicalJson(oracleCore))}`;
const payload = {
  ...oracleCore,
  provenance: {
    generatorPath: 'apps/parity/color-lighting/cases/direct-light/generate-canonical-direct-light-oracle.mjs',
    generatorSha256: `sha256:${generatorSha256}`,
    inputDigest,
    formula: 'linear RGB: sum directional and four colored point Lambert terms; spot=intensity*normalDot*clamp(1-(distance/range)^4,0,1)^2/distance^2*baseColor/pi; shadow=nonSpot*0.55; lit=shadow+spot*0.6; clearcoat=lit*(1+(1-0.9))',
    frozenSource: 'SPOT_SHADOW_SCENES plus calibration/three-r184-finite-range-authority.json, the fixed directional/point setup and receiver baseColor/clearcoat constants in main.ts; no logs, GPU observations, or current observed values',
    sceneSourceSha256: sourceSha256,
    materialSourceSha256,
    command: 'node --experimental-strip-types apps/parity/color-lighting/cases/direct-light/generate-canonical-direct-light-oracle.mjs',
    payloadEncoding: 'UTF-8 canonical JSON without whitespace; payload excludes this provenance field',
    payloadBytesSha256,
  },
};

writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

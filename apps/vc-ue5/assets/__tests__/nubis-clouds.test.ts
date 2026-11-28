import assert from 'node:assert/strict';
import { test } from 'node:test';
import { referenceCloudRef } from '@forgeax-assets/volumetric-clouds/references';
import { halfFloat } from '@forgeax/engine/math';
import { CLOUD_MODES, isSampledCloudMode, unavailableParameter } from '../cloud-controls.ts';
import { NUBIS_LAYOUT_METERS, NUBIS_MODES } from '../nubis/presets.ts';
import { DAWN_LAYOUT_METERS } from '../nubis/dawn-textures.ts';
import { nubisInstanceSource } from '../nubis/clouds.pack.ts';
import { referenceCamera } from '../terrain.ts';
import { bossSunSegment, makeNubisTexture, nubisFields, NUBIS_ROLES } from '../nubis/textures.ts';

const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...a.map((value, index) => value - b[index]!));

test('all Nubis modes override exactly the Generated Clouds texture slots', () => {
  const textureGuids = new Set();
  for (const mode of NUBIS_MODES) {
    assert.ok(CLOUD_MODES.includes(mode));
    assert.ok(isSampledCloudMode(mode));
    assert.equal(unavailableParameter('useDetail', mode, {}), undefined);
    const source = nubisInstanceSource(mode);
    assert.equal(source.material, referenceCloudRef.$asset);
    const textureSlots = Object.entries(source.parameters)
      .filter(([, parameter]) => parameter.kind === 'texture').map(([name]) => name);
    assert.equal(textureSlots.length, 4);
    assert.deepEqual(Object.keys(source.overrides).sort(), textureSlots.sort());
    for (const guid of Object.values(source.overrides)) {
      assert.ok(!textureGuids.has(guid));
      textureGuids.add(guid);
    }
  }
});

test('Boss sun ray stays open from cloud entry to exit, including its offset mask', () => {
  const [start, end] = bossSunSegment();
  const fields = nubisFields('nubis-boss');
  for (let i = 0; i <= 12; i++) {
    const u = start[0] + (end[0] - start[0]) * i / 12;
    const v = start[1] + (end[1] - start[1]) * i / 12;
    assert.deepEqual(fields.pattern(u, v), [0, 0, 0, 0]);
    assert.deepEqual(fields.mask(u + 0.5, v + 0.5), [0, 0, 0, 0]);
    assert.ok(distance(fields.pattern(u + 1, v - 1), [0, 0, 0, 0]) < 1e-8);
  }
  const middle = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2] as const;
  const du = end[0] - start[0], dv = end[1] - start[1];
  const length = Math.hypot(du, dv);
  for (const side of [-1, 1]) {
    const cloudWall = [0.055, 0.08, 0.1, 0.13].some(offset => {
      const pattern = fields.pattern(middle[0] - side * offset * dv / length, middle[1] + side * offset * du / length);
      return Math.max(pattern[1], pattern[2]) > 0.15;
    });
    assert.ok(cloudWall, 'the sun corridor should have clouds on both sides');
  }
});

test('each preset generates four distinct deterministic linear textures', () => {
  for (const role of NUBIS_ROLES) {
    const textures = NUBIS_MODES.map(mode => makeNubisTexture(mode, role, 12));
    for (let i = 0; i < textures.length; i++) {
      const texture = textures[i]!;
      assert.equal(texture.colorSpace, 'linear');
      assert.equal(texture.shape.viewDimension, role === 'body-noise' ? '3d' : '2d');
      assert.equal(texture.format, role === 'body-noise' || role === 'layout-mask' ? 'bgra8unorm' : 'rgba16float');
      assert.deepEqual(texture.data, makeNubisTexture(NUBIS_MODES[i]!, role, 12).data);
      for (const other of textures.slice(i + 1)) assert.notDeepEqual(texture.data, other.data);
    }
  }
  const profile = makeNubisTexture('nubis-dawn', 'height-profile', 32);
  const data = new DataView(profile.data.buffer, profile.data.byteOffset, profile.data.byteLength);
  const sample = (x: number, channel = 0) => halfFloat.f16ToF32(data.getUint16(((24 * 32 + x) * 4 + channel) * 2, true));
  // Three UE-calibrated flattened dawn decks (R ~0.27, G ~0.41, B ~0.56) stay below 0.60 so 3D body noise sculpts silhouettes.
  assert.ok(sample(9, 0) > 0.50 && sample(9, 0) < 0.59);
  assert.ok(sample(13, 1) > 0.50 && sample(13, 1) < 0.59);
  assert.ok(sample(18, 2) > 0.48 && sample(18, 2) < 0.59);
  assert.ok(sample(28, 0) < 0.15);
});


test('each weather map has cloud and gaps across all eight compass sectors', () => {
  const camera = referenceCamera();
  for (const mode of NUBIS_MODES) {
    const layoutMeters = mode === 'nubis-dawn' ? DAWN_LAYOUT_METERS : NUBIS_LAYOUT_METERS;
    const { pattern } = nubisFields(mode);
    for (let sector = 0; sector < 8; sector++) {
      let cloud = 0;
      let gap = 0;
      let samples = 0;
      for (let ring = 1; ring <= 12; ring++) {
        const radius = mode === 'nubis-dawn' ? 3_000 + ring * 3_800 : 1_500 + ring * 2_100;
        for (let ray = 0; ray < 7; ray++) {
          const yaw = camera.yaw + (sector + (ray - 3) / 7) * Math.PI / 4;
          const u = (-camera.z + radius * Math.cos(yaw)) / layoutMeters;
          const v = (camera.x + radius * Math.sin(yaw)) / layoutMeters;
          const rgba = pattern(u, v);
          const value = Math.max(rgba[0], rgba[1], rgba[2]);
          if (value > 0.22) cloud++;
          if (value < 0.12) gap++;
          samples++;
          assert.ok(distance(rgba, pattern(u + 1, v - 1)) < 1e-8);
        }
      }
      const minimumCloud = 0.20;
      assert.ok(cloud / samples >= minimumCloud, `${mode} sector ${sector}: only ${cloud}/${samples} cloud samples`);
      const minimumGap = 0.08;
      assert.ok(gap / samples >= minimumGap, `${mode} sector ${sector}: only ${gap}/${samples} clear samples`);
    }
  }
});


test('distant weather has separated clusters and less coverage than the near field', () => {
  const stage = referenceCamera();
  for (const mode of NUBIS_MODES) {
    const layoutMeters = mode === 'nubis-dawn' ? DAWN_LAYOUT_METERS : NUBIS_LAYOUT_METERS;
    const { pattern } = nubisFields(mode);
    const coverage = (radii: readonly number[]) => {
      let occupied = 0;
      for (const radius of radii) {
        for (let i = 0; i < 48; i++) {
          const theta = 2 * Math.PI * i / 48;
          const u = (-stage.z + radius * Math.cos(theta)) / layoutMeters;
          const v = (stage.x + radius * Math.sin(theta)) / layoutMeters;
          if (Math.max(...pattern(u, v)) > 0.22) occupied++;
        }
      }
      return occupied / (48 * radii.length);
    };
    const near = coverage(mode === 'nubis-dawn' ? [5_000, 10_000, 15_000, 20_000] : [3_000, 6_000, 9_000, 12_000]);
    const far = coverage(mode === 'nubis-dawn' ? [42_000, 48_000, 54_000, 60_000] : [29_000, 33_000, 37_000, 41_000]);
    const minimumFar = 0.08;
    assert.ok(far >= minimumFar, `${mode} distant coverage is too sparse: ${far}`);
    assert.ok(far < near * 0.8, `${mode} distant ${far} versus near ${near}`);
  }
});


test('the baked density carrier limits high-frequency jumps and retains volume contrast', () => {
  const size = 32;
  for (const mode of NUBIS_MODES) {
    const { data } = makeNubisTexture(mode, 'body-noise', size);
    let squaredDelta = 0, low = 255, high = 0;
    for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const row = size * (y + size * z);
      const value = data[4 * (x + row) + 1]!;
      const neighbor = data[4 * ((x + 1) % size + row) + 1]!;
      squaredDelta += (value - neighbor) ** 2;
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    assert.ok(Math.sqrt(squaredDelta / size ** 3) / 255 < 0.12, mode);
    assert.ok(high - low > 100, mode);
  }
});


test('the profile has neutral wrap boundaries and soft height transitions', () => {
  const size = 256;
  for (const mode of NUBIS_MODES) {
    const { data } = makeNubisTexture(mode, 'height-profile');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const value = (x: number, y: number, c: number) => halfFloat.f16ToF32(view.getUint16(8 * (y * size + x) + c * 2, true));
    for (let x = 0; x < size; x++) for (let c = 0; c < 3; c++) {
      assert.ok((value(x, 0, c) + value(x, size - 1, c)) * 0.5 < 0.001, mode);
    }
    for (const y of [40, 76, 128, 204, 245]) {
      for (let x = 1; x < size; x++) for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(value(x, y, c) - value(x - 1, y, c)) < 0.029, mode);
      }
    }
  }
});

test('the aligned additive mask stays empty where all cloud lanes are zero', () => {
  for (const mode of NUBIS_MODES) {
    const { pattern, mask } = nubisFields(mode);
    let gaps = 0;
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
      const u = (x + 0.5) / 24, v = (y + 0.5) / 24;
      if (Math.max(...pattern(u, v)) !== 0) continue;
      gaps++;
      assert.deepEqual(mask(u + 0.5, v + 0.5), [0, 0, 0, 0], mode);
    }
    assert.ok(gaps > 40, mode);
  }
});

test('the density profile softens its ramps while preserving the dawn sheet', () => {
  const samples = 256;
  for (const mode of NUBIS_MODES) {
    const { profile } = nubisFields(mode);
    let largestStep = 0;
    for (let i = 1; i < samples; i++) {
      const before = profile((i - 1) / samples, 0.8);
      const after = profile(i / samples, 0.8);
      for (const channel of [0, 1, 2] as const) {
        largestStep = Math.max(largestStep, Math.abs(after[channel] - before[channel]));
      }
    }
    const bound = mode === 'nubis-dawn' ? 0.006 : 0.09;
    assert.ok(largestStep < bound, `${mode}: ${largestStep}`);
  }
  const dawn = nubisFields('nubis-dawn').profile;
  // UE-calibrated thin sheet peaks with smooth V-axis taper below visibility before wrap boundaries.
  assert.ok(dawn(0.28, 0.8)[0] > 0.52 && dawn(0.28, 0.8)[0] < 0.59);
  assert.ok(dawn(0.42, 0.8)[1] > 0.52 && dawn(0.42, 0.8)[1] < 0.59);
  assert.ok(dawn(0.56, 0.8)[2] > 0.50 && dawn(0.56, 0.8)[2] < 0.59);
  assert.ok(dawn(0.27, 0.03)[0] < 0.22, 'low-layout dawn profile must dissolve before V=0 wrap cutoff');
  assert.ok(dawn(0.85, 0.8)[0] < 0.05);
});

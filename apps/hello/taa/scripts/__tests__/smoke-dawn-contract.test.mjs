import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deriveAppleParavirtualAttestation,
  parseMacIoregAdapterFacts,
  parseMacMetalDeviceFacts,
  parseMacMetalProbeOutput,
  parseMacSystemProfilerAdapterFacts,
  parseMacSystemProfilerText,
} from '../host-adapter-facts.mjs';
import { activePassCountersFromInspection } from '../performance-contract.mjs';
import { projectAdapterInfo } from '../../../triangle/scripts/smoke-helpers.mjs';

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const dawnScript = read('../smoke-dawn.mjs');
const helperScript = read('../../../triangle/scripts/smoke-helpers.mjs');
const frameScript = read('../../../../../packages/render/src/record/frame.ts');
const taaMainScript = read('../../src/main.ts');
const webkitVerifyScript = read('../../../../../scripts/dev-verify/verify-webkit-hello-taa.mjs');

test('TAA Dawn carrier forwards the named ROI to both readback captures', () => {
  const captures = dawnScript.match(/samplePoints: motionSamplePoints/g) ?? [];
  assert.equal(captures.length, 3);
  assert.match(dawnScript, /const motionSamplePoints = \[/);
  assert.match(helperScript, /const requestedSamples = samplePoints \?\?/);
  assert.match(helperScript, /pixelSamples\[point\.name\] = readRgba/);
  assert.match(helperScript, /pixelSamples\.ndcCenter \?\?=/);
  assert.match(helperScript, /pixelSamples\.corner \?\?=/);
});

test('CI falsifier Dawn carrier uses a reduced target, frame floor, and post-process budget', () => {
  assert.match(dawnScript, /FORGEAX_TAA_FALSIFIER_PROFILE === 'ci'/);
  assert.match(dawnScript, /falsifierLightweight \? 128 : 200/);
  assert.match(dawnScript, /falsifierLightweight \? 72 : 150/);
  assert.match(dawnScript, /Math\.max\(requestedFrames, 60\)/);
  assert.match(dawnScript, /castShadow: true/);
  assert.match(dawnScript, /cascadeCount: 1, mapSize: 64/);
  assert.match(dawnScript, /motionBlurMaxRadiusPixels = falsifierLightweight \? 8 : 32/);
  assert.match(dawnScript, /motionBlurSampleCount = falsifierLightweight \? 4 : 8/);
});

test('recording bridges camera-owned Motion Blur parameters into the builtin pass', () => {
  assert.match(frameScript, /const framePostProcessParams = new Map\(postProcessParams\)/);
  assert.match(frameScript, /if \(camera\.motionBlur !== undefined\)/);
  assert.match(frameScript, /framePostProcessParams\.set\('forgeax\.motion-blur', motionBlurParams\)/);
  assert.match(frameScript, /postProcessParams: framePostProcessParams/);
});

test('hello-taa inspection keeps the semantic temporal target in the browser projection', () => {
  assert.match(taaMainScript, /temporalTarget: renderInspection\.temporalTarget \?\? null/);
  assert.match(webkitVerifyScript, /temporalTarget: on\.temporalTarget \?\? null/);
});

test('Dawn carrier exposes adapter identity to the performance admission gate', () => {
  assert.match(helperScript, /adapterInfo:\s*projectAdapterInfo\(adapter\.info\)/);
  assert.match(helperScript, /vendor: read\('vendor'\)/);
  assert.match(helperScript, /architecture: read\('architecture'\)/);
  assert.match(helperScript, /device: read\('device'\)/);
  assert.match(helperScript, /description: read\('description'\)/);
  assert.match(helperScript, /runtimeService/);
  assert.match(helperScript, /requestedBackend/);
  assert.match(helperScript, /isFallbackAdapter/);
  assert.match(dawnScript, /shim\.adapterInfo \?\? null/);
  assert.match(dawnScript, /adapter !== 'null'/);
  assert.match(dawnScript, /adapter !== '\{\}'/);
});

test('adapter.info getter projection keeps identity enumerable', () => {
  const info = {};
  Object.defineProperties(info, {
    vendor: { enumerable: false, get: () => 'Apple' },
    architecture: { enumerable: false, get: () => 'apple-gpu' },
    device: { enumerable: false, get: () => 'Apple M4 Pro' },
    description: { enumerable: false, get: () => 'Metal adapter' },
    runtimeService: { enumerable: false, get: () => 'AppleParavirtGPU' },
  });
  const projected = projectAdapterInfo(info);
  assert.deepEqual(projected, {
    vendor: 'Apple',
    architecture: 'apple-gpu',
    device: 'Apple M4 Pro',
    description: 'Metal adapter',
    runtimeService: 'AppleParavirtGPU',
  });
  assert.deepEqual(JSON.parse(JSON.stringify({ adapter: projected })), { adapter: projected });
});

test('Dawn fallback provenance reads the adapter.info getter when the adapter has no own field', () => {
  const info = {};
  Object.defineProperty(info, 'isFallbackAdapter', { enumerable: false, get: () => false });
  const adapter = { info };
  assert.match(helperScript, /adapter\.info\?\.isFallbackAdapter/);
  assert.equal(typeof adapter.info.isFallbackAdapter, 'boolean');
  assert.equal(adapter.info.isFallbackAdapter, false);
});

test('macOS adapter probe finds nested system_profiler GPU records', () => {
  const facts = parseMacSystemProfilerAdapterFacts({
    SPDisplaysDataType: [{
      _name: 'spdisplays_gpu',
      spdisplays_ndrvs: [{
        sppci_vendor: 'Apple',
        sppci_model: 'Apple M4 Pro',
        sppci_device_type: 'spdisplays_gpu',
        spdisplays_mtlgpufamilysupport: 'Metal 4',
      }],
    }],
  });
  assert.deepEqual(facts, {
    source: 'system_profiler',
    vendor: 'Apple',
    device: 'Apple M4 Pro',
    driver: 'Metal 4',
    deviceType: 'spdisplays_gpu',
    physicalGpu: true,
  });
});

test('macOS adapter probe accepts alternate nested keys and derives Apple GPU type', () => {
  const facts = parseMacSystemProfilerAdapterFacts({
    SPDisplaysDataType: [{
      spdisplays_ndrvs: [{
        spdisplays_vendor_name: 'Apple',
        spdisplays_gpu_model: 'Apple M4 Pro',
        spdisplays_metal_family_support: 'Metal 4',
      }],
    }],
  });
  assert.deepEqual(facts, {
    source: 'system_profiler',
    vendor: 'Apple',
    device: 'Apple M4 Pro',
    driver: 'Metal 4',
    deviceType: 'apple-gpu',
    physicalGpu: true,
  });
});

test('macOS adapter probe parses the text fallback used by headless hosted runners', () => {
  const facts = parseMacSystemProfilerText(`
Graphics/Displays:

    Apple M4 Pro:
      Chipset Model: Apple M4 Pro
      Type: GPU
      Vendor: Apple (0x106b)
      Metal Support: Metal 4
  `);
  assert.deepEqual(facts, {
    source: 'system_profiler',
    vendor: 'Apple',
    device: 'Apple M4 Pro',
    driver: 'Metal 4',
    deviceType: 'GPU',
    physicalGpu: true,
  });
});

test('macOS adapter probe rejects software adapter identities', () => {
  const facts = parseMacSystemProfilerText(`
Graphics/Displays:
  Chipset Model: Software Renderer
  Type: GPU
  Vendor: Virtual
  Metal Support: Unsupported
`);
  assert.equal(facts.physicalGpu, false);
});

test('macOS adapter probe accepts an explicit IOAccelerator service', () => {
  const facts = parseMacIoregAdapterFacts(`
  +-o AGXAcceleratorG16X  <class AGXAcceleratorG16X, id 0x1, registered, matched, active>
      {
        "MetalPluginName" = "AGXMetalG16X"
        "model" = "Apple M4 Pro"
        "IOClass" = "AGXAcceleratorG16X"
      }
  +-o unrelated  <class OtherService, id 0x2>
  `);
  assert.deepEqual(facts, {
    source: 'ioreg',
    vendor: 'Apple',
    device: 'Apple M4 Pro',
    driver: 'AGXMetalG16X',
    deviceType: 'AGXAcceleratorG16X',
    physicalGpu: true,
  });
});

test('Apple paravirtual admission requires the exact ioreg service pair and owner facts', () => {
  const facts = parseMacIoregAdapterFacts(`
  +-o AppleParavirtGPU  <class AppleParavirtGPU, id 0x1, registered, matched, active>
      {
        "MetalPluginName" = "AppleParavirtGPUMetalIOGPUFamily"
        "IOClass" = "AppleParavirtGPUMetalIOGPUFamily"
      }
  `);
  assert.deepEqual(facts, {
    source: 'ioreg',
    vendor: 'Apple',
    device: '',
    driver: 'AppleParavirtGPUMetalIOGPUFamily',
    deviceType: 'AppleParavirtGPU',
    physicalGpu: false,
  });
  const owner = {
    provider: 'github-hosted/macos-15-xlarge',
    runnerFacts: {
      environment: 'github-hosted',
      os: 'macOS',
      arch: 'ARM64',
      queue: 'native-gpu',
    },
    requestedBackend: 'metal',
    isFallbackAdapter: false,
    ioregFacts: facts,
  };
  assert.deepEqual(deriveAppleParavirtualAttestation(owner), {
    kind: 'provider-backed-paravirtual',
    provider: 'github-hosted/macos-15-xlarge',
    deviceType: 'AppleParavirtGPU',
    driver: 'AppleParavirtGPUMetalIOGPUFamily',
    requestedBackend: 'metal',
    isFallbackAdapter: false,
  });
  const rejects = [
    { ioregFacts: { ...facts, driver: 'AppleParavirtGPU' } },
    { ioregFacts: { ...facts, deviceType: 'AppleParavirtGPUMetalIOGPUFamily' } },
    { ioregFacts: { ...facts, source: 'system_profiler' } },
    { ioregFacts: { ...facts, physicalGpu: true } },
    { provider: 'generic/macos-15-xlarge' },
    { runnerFacts: { ...owner.runnerFacts, environment: 'self-hosted' } },
    { runnerFacts: { ...owner.runnerFacts, arch: 'X64' } },
    { runnerFacts: { ...owner.runnerFacts, queue: 'standard' } },
    { requestedBackend: 'vulkan' },
    { isFallbackAdapter: true },
    { ioregFacts: { ...facts, driver: 'llvmpipe' } },
  ];
  for (const change of rejects) {
    assert.equal(
      deriveAppleParavirtualAttestation({ ...owner, ...change }),
      undefined,
      `unexpected attestation for ${JSON.stringify(change)}`,
    );
  }
  assert.match(dawnScript, /deriveAppleParavirtualAttestation/);
  assert.match(dawnScript, /ioregFacts: physicalAdapterFacts\.fallback/);
  assert.match(dawnScript, /activePassCountersFromInspection/);
});

test('active work counters separate renderer state from retained topology', () => {
  const topology = ['standard-scene-data', 'taa-resolve', 'motion-blur', 'output-transform'];
  assert.deepEqual(
    activePassCountersFromInspection({
      temporalTarget: { targetCount: 1 },
      motionBlur: { enabled: false, status: 'off', temporalDemand: null },
      passes: topology,
    }),
    { producer: 1, blur: 0 },
  );
  assert.deepEqual(
    activePassCountersFromInspection({
      temporalTarget: { targetCount: 1 },
      motionBlur: { enabled: true, status: 'active', temporalDemand: 'scene-data-temporal-v1' },
      passes: topology,
    }),
    { producer: 1, blur: 1 },
  );
  assert.deepEqual(
    activePassCountersFromInspection({
      temporalTarget: { targetCount: 1 },
      motionBlur: { enabled: true, status: 'reset', temporalDemand: 'scene-data-temporal-v1' },
      passes: topology,
    }),
    { producer: 1, blur: 0 },
  );
  assert.deepEqual(
    activePassCountersFromInspection({
      temporalTarget: { targetCount: 2 },
      motionBlur: { enabled: true, status: 'active', temporalDemand: 'scene-data-temporal-v1' },
      passes: topology,
    }),
    { producer: 0, blur: 1 },
  );
});

test('direct Metal API probe accepts a physical registry-backed device', () => {
  const facts = parseMacMetalDeviceFacts({
    default: {
      name: 'Apple M4 Pro',
      registryID: '4294968997',
      lowPower: false,
      removable: false,
      headless: false,
      unifiedMemory: true,
      location: 'MTLDeviceLocation(rawValue: 0)',
    },
  });
  assert.equal(facts.source, 'metal-api');
  assert.equal(facts.vendor, 'Apple');
  assert.equal(facts.device, 'Apple M4 Pro');
  assert.equal(facts.driver, 'Metal');
  assert.equal(facts.deviceType, 'MTLDevice');
  assert.equal(facts.registryID, '4294968997');
  assert.equal(facts.physicalGpu, true);
  assert.deepEqual(facts.accelerationAttestation, { kind: 'direct-device' });
});

test('direct Metal API probe rejects empty, software, malformed, and label-only payloads', () => {
  assert.equal(parseMacMetalDeviceFacts({ devices: [] }).physicalGpu, false);
  assert.equal(
    parseMacMetalProbeOutput(JSON.stringify({ default: { name: 'SwiftShader', registryID: '1' } })).physicalGpu,
    false,
  );
  assert.equal(parseMacMetalProbeOutput('{not-json}').physicalGpu, false);
  assert.equal(
    parseMacMetalDeviceFacts({ provider: 'github-hosted/macos-15-xlarge', physicalGpu: true }).physicalGpu,
    false,
  );
});

test('native admission requires direct Metal proof and the declared hosted provider', () => {
  assert.match(dawnScript, /xcrun', \['swift', '-'\]/);
  assert.match(dawnScript, /backend=metal/);
  assert.match(dawnScript, /deriveAppleParavirtualAttestation/);
  assert.match(dawnScript, /qualifiedNativeFromAttestation/);
  assert.match(dawnScript, /FORGEAX_GPU_PROVIDER/);
  assert.match(dawnScript, /fallback: fallbackFacts/);
});

test('Metal label-only payload remains non-physical without the exact ioreg pair', () => {
  const facts = parseMacMetalDeviceFacts({
    default: { name: 'AppleParavirtGPU', registryID: '1', location: 'AppleParavirtGPU' },
  });
  assert.equal(facts.physicalGpu, false);
  assert.equal(facts.accelerationAttestation, undefined);
  assert.doesNotMatch(dawnScript, /runtimeService: paravirtualRuntimeService/);
});

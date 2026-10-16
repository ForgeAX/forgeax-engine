import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeDawnAdapter,
  normalizeDawnDeviceDescriptor,
  patchDawnAdapterPrototype,
} from '../normalize-dawn-device-limits.mjs';

test('fills only omitted dynamic limits from the adapter', () => {
  const adapter = {
    limits: {
      maxDynamicUniformBuffersPerPipelineLayout: 16,
      maxDynamicStorageBuffersPerPipelineLayout: 12,
    },
  };
  const descriptor = { requiredFeatures: ['timestamp-query'] };
  const normalized = normalizeDawnDeviceDescriptor(adapter, descriptor);

  assert.deepEqual(normalized, {
    requiredFeatures: ['timestamp-query'],
    requiredLimits: {
      maxDynamicUniformBuffersPerPipelineLayout: 16,
      maxDynamicStorageBuffersPerPipelineLayout: 12,
    },
  });
  assert.deepEqual(descriptor, { requiredFeatures: ['timestamp-query'] });
});

test('preserves supported explicit limits and clamps Dawn synthetic defaults', () => {
  const descriptor = {
    requiredLimits: {
      maxDynamicUniformBuffersPerPipelineLayout: 4,
      maxDynamicStorageBuffersPerPipelineLayout: 1_000_000,
    },
  };
  assert.deepEqual(
    normalizeDawnDeviceDescriptor(
      {
        limits: {
          maxDynamicUniformBuffersPerPipelineLayout: 16,
          maxDynamicStorageBuffersPerPipelineLayout: 16,
        },
      },
      descriptor,
    ),
    {
      requiredLimits: {
        maxDynamicUniformBuffersPerPipelineLayout: 4,
        maxDynamicStorageBuffersPerPipelineLayout: 16,
      },
    },
  );
  assert.equal(normalizeDawnDeviceDescriptor({}, descriptor), descriptor);
});

test('preserves an explicit unsupported limit instead of changing caller requirements', () => {
  const descriptor = {
    requiredLimits: { maxDynamicUniformBuffersPerPipelineLayout: 32 },
  };
  assert.deepEqual(
    normalizeDawnDeviceDescriptor(
      {
        limits: {
          maxDynamicUniformBuffersPerPipelineLayout: 16,
          maxDynamicStorageBuffersPerPipelineLayout: 16,
        },
      },
      descriptor,
    ),
    {
      requiredLimits: {
        maxDynamicUniformBuffersPerPipelineLayout: 32,
        maxDynamicStorageBuffersPerPipelineLayout: 16,
      },
    },
  );
});

test('does not mutate a descriptor when an oversized limit is clamped', () => {
  const descriptor = {
    requiredLimits: { maxDynamicUniformBuffersPerPipelineLayout: 1_000_000 },
  };
  const normalized = normalizeDawnDeviceDescriptor(
    {
      limits: {
        maxDynamicUniformBuffersPerPipelineLayout: 16,
        maxDynamicStorageBuffersPerPipelineLayout: 16,
      },
    },
    descriptor,
  );
  assert.deepEqual(normalized.requiredLimits, {
    maxDynamicUniformBuffersPerPipelineLayout: 16,
    maxDynamicStorageBuffersPerPipelineLayout: 16,
  });
  assert.deepEqual(descriptor, {
    requiredLimits: { maxDynamicUniformBuffersPerPipelineLayout: 1_000_000 },
  });
});

test('patches a prototype once and forwards the normalized descriptor', async () => {
  const calls = [];
  class FakeAdapter {
    constructor() {
      this.limits = {
        maxDynamicUniformBuffersPerPipelineLayout: 8,
        maxDynamicStorageBuffersPerPipelineLayout: 7,
      };
    }

    async requestDevice(descriptor) {
      calls.push(descriptor);
      return descriptor;
    }
  }
  const globals = { GPUAdapter: FakeAdapter };
  assert.equal(patchDawnAdapterPrototype(globals), true);
  assert.equal(patchDawnAdapterPrototype(globals), true);
  const descriptor = await new FakeAdapter().requestDevice({ requiredFeatures: [] });
  assert.deepEqual(descriptor.requiredLimits, {
    maxDynamicUniformBuffersPerPipelineLayout: 8,
    maxDynamicStorageBuffersPerPipelineLayout: 7,
  });
  assert.equal(calls.length, 1);
});

test('normalizes GPU requestAdapter results when the adapter method is own or frozen', async () => {
  const calls = [];
  const adapter = Object.freeze({
    limits: {
      maxDynamicUniformBuffersPerPipelineLayout: 8,
      maxDynamicStorageBuffersPerPipelineLayout: 7,
    },
    async requestDevice(descriptor) {
      calls.push(descriptor);
      return descriptor;
    },
  });
  class FakeGpu {
    async requestAdapter() {
      return adapter;
    }
  }
  assert.equal(patchDawnAdapterPrototype({ GPU: FakeGpu }), true);
  const normalized = await new FakeGpu().requestAdapter();
  assert.notEqual(normalized, adapter);
  const descriptor = await normalized.requestDevice({ requiredFeatures: [] });
  assert.deepEqual(descriptor.requiredLimits, {
    maxDynamicUniformBuffersPerPipelineLayout: 8,
    maxDynamicStorageBuffersPerPipelineLayout: 7,
  });
  assert.equal(calls.length, 1);
});

test('normalizes an adapter directly when no GPU prototype is available', async () => {
  const adapter = Object.freeze({
    limits: {
      maxDynamicUniformBuffersPerPipelineLayout: 4,
      maxDynamicStorageBuffersPerPipelineLayout: 3,
    },
    async requestDevice(descriptor) {
      return descriptor;
    },
  });
  const normalized = normalizeDawnAdapter(adapter);
  const descriptor = await normalized.requestDevice();
  assert.deepEqual(descriptor.requiredLimits, {
    maxDynamicUniformBuffersPerPipelineLayout: 4,
    maxDynamicStorageBuffersPerPipelineLayout: 3,
  });
});

import { ok, type ShaderModule } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { ShaderRegistry, type ShaderRegistryDevice } from '../index.js';

function dataUrl(payload: unknown): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify(payload))}`;
}

function device(): ShaderRegistryDevice {
  return {
    createShaderModule(): ReturnType<ShaderRegistryDevice['createShaderModule']> {
      return ok({} as ShaderModule);
    },
  };
}

function variant(definesKey: string, cluster: boolean) {
  return {
    definesKey,
    defines: {
      CLUSTER_FORWARD_AVAILABLE: cluster,
      STORAGE_BUFFER_AVAILABLE: true,
      VERTEX_COLOR_AVAILABLE: false,
    },
    composedWgsl: `standard-${cluster}`,
  };
}

function standardRow(variants: readonly unknown[]) {
  return {
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'default-standard-pbr.wgsl',
    composedWgsl: 'standard-default',
    paramSchema: '[]',
    variants,
  };
}

async function load(materialShaders: readonly unknown[]) {
  const registry = new ShaderRegistry({
    device: device(),
    manifestUrl: dataUrl({ entries: [], materialShaders }),
  });
  return registry.loadManifest();
}

describe('Standard transmission manifest validation', () => {
  const falseKey =
    'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';
  const trueKey =
    'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';

  it('accepts one Standard row with the static capability/geometry states', async () => {
    const result = await load([standardRow([variant(falseKey, false), variant(trueKey, true)])]);
    expect(result.ok).toBe(true);
  });

  it('does not require a runtime transmission axis for a Standard row', async () => {
    const result = await load([standardRow([variant(falseKey, false)])]);
    expect(result.ok).toBe(true);
  });

  it('rejects duplicate material rows and duplicate variant keys', async () => {
    const row = standardRow([variant(falseKey, false), variant(trueKey, true)]);
    const duplicateRow = await load([row, row]);
    expect(duplicateRow.ok).toBe(false);

    const duplicateVariant = await load([
      standardRow([variant(trueKey, true), variant(trueKey, true)]),
    ]);
    expect(duplicateVariant.ok).toBe(false);
  });
});

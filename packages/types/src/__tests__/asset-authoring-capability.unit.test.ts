import { describe, expect, it } from 'vitest';
import {
  authoringCapabilityForAssetKind,
  catalogOperationsFor,
  isCatalogProjectionValid,
} from '../index';

describe('producer-owned asset authoring capability', () => {
  it('keeps the ordinary Asset discovery set separate from UI capability kinds', () => {
    const ordinaryKinds = [
      'mesh',
      'material',
      'scene',
      'texture',
      'equirect',
      'sampler',
      'font',
      'render-pipeline',
      'tileset',
      'video',
      'skeleton',
      'skin',
      'animation-clip',
      'animation-graph',
      'audio',
      'particle-effect',
    ] as const;
    for (const kind of ordinaryKinds) {
      expect(authoringCapabilityForAssetKind(kind)).toHaveProperty('placement');
      expect(authoringCapabilityForAssetKind(kind)).toHaveProperty('binding');
    }
  });

  it('publishes placement and binding shape for built-in kinds', () => {
    expect(authoringCapabilityForAssetKind('mesh')).toEqual({
      placement: { operation: 'spawnEntity' },
      binding: {
        operation: 'bindAssetRef',
        target: {
          component: 'MeshFilter',
          field: 'assetHandle',
          assetType: 'MeshAsset',
          cardinality: 'single',
        },
        requiredSlots: 1,
      },
    });
    expect(authoringCapabilityForAssetKind('scene').placement).toEqual({
      operation: 'addSceneAssetToScene',
    });
  });

  it('publishes the producer-owned particle effect binding contract', () => {
    expect(authoringCapabilityForAssetKind('particle-effect')).toEqual({
      placement: { operation: 'spawnEntity' },
      binding: {
        operation: 'bindAssetRef',
        target: {
          component: 'ParticleEffectPlayer',
          field: 'effect',
          assetType: 'ParticleEffectAsset',
          cardinality: 'single',
        },
        requiredSlots: 1,
      },
    });

    expect(authoringCapabilityForAssetKind('mesh').binding).toMatchObject({
      target: { assetType: 'MeshAsset' },
    });
    expect(authoringCapabilityForAssetKind('material').binding).toMatchObject({
      target: { assetType: 'MaterialAsset' },
    });
    expect(authoringCapabilityForAssetKind('audio').binding).toEqual({
      operation: 'unavailable',
      reason: {
        code: 'unsupported-asset-kind',
        hint: expect.stringContaining('binding capability'),
      },
    });
  });

  it('publishes a versioned UI runtime contract instead of an unavailable kind fallback', () => {
    const capability = authoringCapabilityForAssetKind('ui');
    expect(capability.placement.operation).toBe('unavailable');
    expect(capability.binding.operation).toBe('unavailable');
    expect(capability.ui).toEqual({
      contractVersion: '1',
      profileVersion: '1',
      preview: { operation: 'createUiPreviewSession', lifecycle: 'open-rebuild-retry-dispose' },
      mount: { operation: 'mountUi', lifecycle: 'mount-dispose', actionPort: 'onAction' },
      state: { status: 'supported', operation: 'gameProjection', contractVersion: '1' },
      actions: { status: 'supported', operation: 'gameProjection', contractVersion: '1' },
      reads: { status: 'supported', operation: 'gameProjection', contractVersion: '1' },
      input: { status: 'supported', operation: 'dom-native', contractVersion: '1' },
      navigation: { status: 'supported', operation: 'dom-native', contractVersion: '1' },
      font: { status: 'supported', operation: 'ui-artifact-companion', contractVersion: '1' },
      localization: { status: 'supported', operation: 'i18next', contractVersion: '1' },
    });
  });

  it('fails closed with a structured reason for a new kind without a producer fact', () => {
    const capability = authoringCapabilityForAssetKind('host/new-kind');
    expect(capability.placement).toEqual({
      operation: 'unavailable',
      reason: { code: 'unsupported-asset-kind', hint: expect.any(String) },
    });
    expect(capability.binding).toEqual({
      operation: 'unavailable',
      reason: { code: 'unsupported-asset-kind', hint: expect.any(String) },
    });
  });

  it('projects capabilities without deriving them from kind or path', () => {
    const operations = catalogOperationsFor({
      subject: 'imported-output',
      execution: 'cooked',
      lifecycle: 'stale',
    });

    expect(operations.sourceOverride).toEqual({ operation: 'sourceOverride', enabled: true });
    expect(operations.save).toMatchObject({ operation: 'save', enabled: false });
    expect(
      isCatalogProjectionValid({
        subject: 'imported-output',
        execution: 'cooked',
        lifecycle: 'stale',
        operations,
      }),
    ).toBe(true);
  });
});

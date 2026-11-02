import { describe, expect, it } from 'vitest';
import { createStandardClusterLayout } from '../pipeline/standard-lighting/layout';
import { CLUSTER_GRID_STRIDE_U32, LIGHT_INDEX_LIST_CAPACITY } from '../pipeline/standard-profile';
import { STANDARD_CLUSTER_TEST_ABI } from './cluster-test-abi';

const STANDARD_CLUSTER_LAYOUT = createStandardClusterLayout(
  STANDARD_CLUSTER_TEST_ABI.directLightSlot.capacity,
);

describe('Standard lighting layout SSOT', () => {
  it('derives the transport storage sizes from one cluster layout', () => {
    expect(STANDARD_CLUSTER_LAYOUT.clusterGridStrideU32).toBe(CLUSTER_GRID_STRIDE_U32);
    expect(STANDARD_CLUSTER_LAYOUT.lightIndexListCapacity).toBe(LIGHT_INDEX_LIST_CAPACITY);
    expect(STANDARD_CLUSTER_LAYOUT.clusterGridU32Length).toBe(
      STANDARD_CLUSTER_LAYOUT.clusterCount * STANDARD_CLUSTER_LAYOUT.clusterGridStrideU32,
    );
  });

  it('does not introduce a second light-index budget', () => {
    expect(Object.keys(STANDARD_CLUSTER_LAYOUT)).not.toContain('maxLightIndexListCapacity');
    expect(STANDARD_CLUSTER_LAYOUT.lightIndexListCapacity).toBe(LIGHT_INDEX_LIST_CAPACITY);
  });
});

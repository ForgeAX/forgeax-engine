import type { ShaderReflection } from '@forgeax/engine-types';
import { packClusterUniform } from '../hdrp-buffers';
import {
  type DirectLightSnapshot,
  deriveStandardClusterReflectedAbi,
  packDirectLightSlot,
} from '../light-buffer-layout';
import { createStandardClusterLayout } from '../pipeline/standard-lighting/layout';
import type { PreparedStandardLighting } from '../pipeline/standard-lighting/prepare';
import {
  type StandardClusterCapabilities,
  selectStandardClusterTransport,
} from '../pipeline/standard-lighting/transport';

const slotFields = [
  ['position', 'vec4<f32>'],
  ['colorTimesIntensity', 'vec4<f32>'],
  ['direction', 'vec4<f32>'],
  ['auxiliary', 'vec4<f32>'],
  ['metadata', 'vec4<u32>'],
  ['channels', 'vec4<u32>'],
] as const;
const uniformFields = [
  ['grid', 'vec4<u32>'],
  ['near_far_log', 'vec4<f32>'],
  ['ao', 'vec4<u32>'],
  ['direct_ao', 'vec4<f32>'],
  ['texture', 'vec4<u32>'],
  ['cluster_layout', 'vec4<u32>'],
] as const;
const members = (fields: readonly (readonly [string, string])[]) =>
  fields.map(([name, type], index) => ({
    name,
    type,
    offset: index * 16,
    size: 16,
    alignment: 16,
    typeDescriptor: {
      kind: 'vector' as const,
      scalarKind: type.endsWith('<u32>') ? ('uint' as const) : ('float' as const),
      width: 4,
      components: 4,
      byteSize: 16,
      alignment: 16,
    },
  }));

function structDescriptor(name: string, values: ReturnType<typeof members>, span: number) {
  return { kind: 'struct' as const, name, span, byteSize: span, alignment: 16, members: values };
}

const slotMembers = members(slotFields);
const uniformMembers = members(uniformFields);

export const STANDARD_CLUSTER_TEST_REFLECTION: ShaderReflection = {
  schemaVersion: 'shader-reflection/3',
  uvSetCount: 0,
  boundGlobals: [
    {
      group: 2,
      binding: 3,
      addressSpace: 'storage',
      resourceKind: 'storage-buffer',
      resourceAccess: 'read-write',
      visibility: 2,
      name: 'light_data',
      elementType: 'LightData',
      elementStride: slotMembers.length * 16,
      arrayLength: 256,
      members: slotMembers,
      span: slotMembers.length * 16,
      typeDescriptor: {
        kind: 'array',
        size: { kind: 'constant', count: 256 },
        stride: slotMembers.length * 16,
        byteSize: slotMembers.length * 16 * 256,
        alignment: 16,
        element: structDescriptor('LightData', slotMembers, slotMembers.length * 16),
      },
    },
    {
      group: 2,
      binding: 6,
      addressSpace: 'uniform',
      resourceKind: 'buffer',
      resourceAccess: 'read-only',
      visibility: 2,
      name: 'cluster_uniform',
      elementType: 'struct',
      span: uniformMembers.length * 16,
      members: uniformMembers,
      typeDescriptor: structDescriptor(
        'ClusterUniform',
        uniformMembers,
        uniformMembers.length * 16,
      ),
    },
  ],
};

const abi = deriveStandardClusterReflectedAbi([STANDARD_CLUSTER_TEST_REFLECTION]);
if (abi === undefined) throw new Error('Invalid test Cluster reflection');

/** Synthetic reflected ABI for pure Cluster packing and transport unit tests. */
export const STANDARD_CLUSTER_TEST_ABI = abi;

export function packTestDirectLightSlot(
  snapshot: DirectLightSnapshot,
  projectorSelected?: boolean,
): Float32Array {
  return packDirectLightSlot(
    snapshot,
    STANDARD_CLUSTER_TEST_ABI.directLightSlot,
    projectorSelected,
  );
}

export function selectTestStandardClusterTransport(
  capabilities: StandardClusterCapabilities,
  prepared: PreparedStandardLighting,
) {
  return selectStandardClusterTransport(capabilities, prepared, STANDARD_CLUSTER_TEST_ABI);
}

type TestClusterUniformInput = Omit<
  Parameters<typeof packClusterUniform>[0],
  'reflectedAbi' | 'clusterGridStrideU32' | 'clusterGridCountWordOffsetU32'
>;

export function packTestClusterUniform(input: TestClusterUniformInput): ArrayBuffer {
  const layout = createStandardClusterLayout(
    STANDARD_CLUSTER_TEST_ABI.directLightSlot.capacity,
    input.grid,
  );
  return packClusterUniform({
    ...input,
    reflectedAbi: STANDARD_CLUSTER_TEST_ABI,
    clusterGridStrideU32: layout.clusterGridStrideU32,
    clusterGridCountWordOffsetU32: layout.clusterGridCountWordOffsetU32,
  });
}

import type { RenderPipelineTopology } from '../render-pipeline';
import type { StaticShadowLayout } from '../static-shadow-memory';
import { terrainShadowLayoutMatches } from '../terrain/shadow-family';

/** Serialize the current graph inputs with native JSON observation semantics. */
export function serializeFrameGraphKey(input: object): string {
  return JSON.stringify(input);
}

type Directional = RenderPipelineTopology['shadow']['directional'];
type RetainedInputs = Pick<
  RenderPipelineTopology,
  | 'shadow'
  | 'forwardDirectionalShadow'
  | 'forwardCapsuleShadows'
  | 'compactGbuffer'
  | 'deferredPcfLighting'
>;

/** Only these bindings can make an earlier frame's draw unsafe during resource preparation. */
export interface RetainedFrameGraphPolicy {
  readonly screen: boolean;
  readonly capsule: boolean;
  readonly gbuffer: RenderPipelineTopology['compactGbuffer'];
  readonly pcf: boolean;
  readonly terrain: Directional | undefined;
  readonly staticDirectional: boolean;
  readonly staticPoints: number;
  readonly staticSpots: number;
}

export function retainedFrameGraphPolicy(topology: RetainedInputs): RetainedFrameGraphPolicy {
  const directional = topology.shadow.directional;
  const receivers = directional === 'disabled' ? undefined : directional.terrainReceivers;
  return {
    screen: topology.forwardDirectionalShadow?.mode === 'screen',
    capsule: topology.forwardCapsuleShadows === true,
    gbuffer: topology.compactGbuffer,
    pcf: topology.deferredPcfLighting === true,
    staticDirectional: directional !== 'disabled' && directional.staticLayer !== false,
    staticPoints: topology.shadow.pointStaticMask ?? 0,
    staticSpots: topology.shadow.spotStaticMask ?? 0,
    terrain:
      directional === 'disabled' || !receivers?.length
        ? undefined
        : {
            cascadeCount: directional.cascadeCount,
            mapSize: directional.mapSize,
            terrainReceivers: receivers.map(({ entityKey }) => ({ entityKey })),
          },
  };
}

export function retainedFrameGraphPolicyMatches(
  policy: RetainedFrameGraphPolicy | undefined,
  directional: Directional,
  forwardCapsuleShadows: boolean,
  compactGbuffer?: RenderPipelineTopology['compactGbuffer'],
  deferredPcfLighting = false,
  staticLayers?: Readonly<StaticShadowLayout>,
): boolean {
  return (
    policy?.screen !== true &&
    (policy?.capsule === true) === forwardCapsuleShadows &&
    policy?.gbuffer === compactGbuffer &&
    (policy?.pcf === true) === deferredPcfLighting &&
    (staticLayers === undefined ||
      ((policy?.staticDirectional === true) ===
        (directional !== 'disabled' && staticLayers.directional) &&
        (policy?.staticPoints ?? 0) === staticLayers.pointMask &&
        (policy?.staticSpots ?? 0) === staticLayers.spotMask)) &&
    terrainShadowLayoutMatches(policy?.terrain, directional)
  );
}

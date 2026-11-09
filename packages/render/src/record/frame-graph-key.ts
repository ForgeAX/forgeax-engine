import type { RenderPipelineTopology } from '../render-pipeline';
import { terrainShadowLayoutMatches } from '../terrain/shadow-family';

/** Serialize the current graph inputs with native JSON observation semantics. */
export function serializeFrameGraphKey(input: object): string {
  return JSON.stringify(input);
}

/** Judge both retained caster policies from one parse of the existing graph key. */
export function retainedFrameGraphPolicyMatches(
  topologyKey: string,
  directional: RenderPipelineTopology['shadow']['directional'],
  forwardCapsuleShadows: boolean,
): boolean {
  let topology: RenderPipelineTopology | undefined;
  try {
    topology = JSON.parse(topologyKey).topology;
  } catch {
    topology = undefined;
  }
  return (
    (topology?.forwardCapsuleShadows === true) === forwardCapsuleShadows &&
    terrainShadowLayoutMatches(topology?.shadow?.directional, directional)
  );
}

import type { RenderPipelineTopology } from '../render-pipeline';
import { terrainShadowLayoutMatches } from '../terrain/shadow-family';

/** Serialize the current graph inputs with native JSON observation semantics. */
export function serializeFrameGraphKey(input: object): string {
  return JSON.stringify(input);
}

/** Check the retained caster policies and the configured GBuffer contract. */
export function retainedFrameGraphPolicyMatches(
  topologyKey: string,
  directional: RenderPipelineTopology['shadow']['directional'],
  forwardCapsuleShadows: boolean,
  compactGbuffer?: RenderPipelineTopology['compactGbuffer'],
): boolean {
  let topology: RenderPipelineTopology | undefined;
  try {
    topology = JSON.parse(topologyKey).topology;
  } catch {
    topology = undefined;
  }
  return (
    (topology?.forwardCapsuleShadows === true) === forwardCapsuleShadows &&
    topology?.compactGbuffer === compactGbuffer &&
    terrainShadowLayoutMatches(topology?.shadow?.directional, directional)
  );
}

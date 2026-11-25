import type { BindGroup, Sampler } from '@forgeax/engine-rhi';
import { pushAtmosphereBindingResources } from '../environment/bindings';
import { bindGroupChainLeaf } from './mesh-ssbo';
import type { PipelineState } from './render-context';

interface ShadowBindingKeys {
  readonly keys: object[];
  readonly samplerIndex: number;
}

/** One complete ABI projection; borrowed callers reconstruct it from current inputs. */
export function shadowViewBindingKeys(state: PipelineState): ShadowBindingKeys | undefined {
  const sampler = state.perPassResources.shadowSampler;
  if (sampler === null) return undefined;
  const extended = state.extendedLightingAvailable ?? false;
  const projector = state.projectorAvailable !== false;
  const ies = state.iesProfileTextureView,
    cookie = state.cookieTextureView;
  const matrices = state.cookieMatrixBuffer,
    lambert = state.ltcLambertTextureView,
    ggx = state.ltcGgxTextureView;
  if (
    extended &&
    (ies === undefined ||
      cookie === undefined ||
      matrices === undefined ||
      lambert === undefined ||
      ggx === undefined)
  )
    return undefined;
  const keys: object[] = [state.viewBindGroupLayout];
  pushAtmosphereBindingResources(keys, state);
  keys.push(state.viewUniformBuffer, state.shadowArrayFallbackTextureView);
  const samplerIndex = keys.length;
  keys.push(
    sampler,
    state.shadowAtlasFallbackTextureView,
    state.shadowParamsBuffer,
    state.shadowCasterCascadeBuffer,
    state.shadowArrayFallbackTextureView,
  );
  if (extended)
    keys.push(
      state.defaultSampler,
      ies as object,
      cookie as object,
      lambert as object,
      ggx as object,
      matrices as object,
    );
  else if (projector) keys.push(state.defaultWhiteTextureView, state.defaultSampler);
  if (extended || projector) keys.push(state.defaultWhiteTextureView, state.defaultSampler);
  return { keys, samplerIndex };
}

/** Issued only by physical PipelineState producers. Fixed resources belong to
 * that device/view lifetime; the sampler can vary.
 * The existing weak cache owns bind groups and all variant entries. */
export class ShadowViewResources {
  private readonly owner: PipelineState;
  private binding: ShadowBindingKeys | undefined;
  private root: WeakMap<object, unknown> | undefined;
  private leaf: Map<string, BindGroup> | undefined;

  constructor(owner: PipelineState) {
    this.owner = owner;
    this.binding = shadowViewBindingKeys(owner);
  }

  resolve(
    state: PipelineState,
    root: WeakMap<object, unknown>,
  ): Map<string, BindGroup> | undefined {
    if (state !== this.owner) return undefined;
    const sampler: Sampler | null = state.perPassResources.shadowSampler;
    if (sampler === null) return undefined;
    this.binding ??= shadowViewBindingKeys(state);
    const binding = this.binding;
    if (binding === undefined) return undefined;
    const changed = binding.keys[binding.samplerIndex] !== sampler;
    if (changed || root !== this.root || this.leaf === undefined) {
      binding.keys[binding.samplerIndex] = sampler;
      this.leaf = bindGroupChainLeaf(root, binding.keys);
      this.root = root;
    }
    return this.leaf;
  }
}

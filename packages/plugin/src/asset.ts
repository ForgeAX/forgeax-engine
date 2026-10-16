import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis';
import type {
  GuidString,
  PluginAssetDefinition,
  PluginBuildTarget,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

export type PluginAssetError = {
  readonly expected: string;
  readonly hint: string;
} & (
  | {
      readonly code: 'plugin-asset-read-failed';
      readonly detail: { readonly guid: string; readonly cause: unknown };
    }
  | {
      readonly code: 'plugin-program-unavailable';
      readonly detail: {
        readonly guid: string;
        readonly program: string;
        readonly target: PluginBuildTarget;
      };
    }
  | {
      readonly code: 'plugin-publication-mismatch';
      readonly detail: {
        readonly guid: string;
        readonly expected: PluginAssetDefinition['evidence'] | undefined;
        readonly actual: PluginAssetDefinition['evidence'];
      };
    }
  | {
      readonly code: 'plugin-module-invalid';
      readonly detail: { readonly guid: string; readonly program: string; readonly cause: unknown };
    }
  | {
      readonly code: 'plugin-mount-cancelled';
      readonly detail: { readonly guid: string; readonly sessionGeneration: number };
    }
  | {
      readonly code: 'plugin-activation-failed';
      readonly detail: { readonly guid: string; readonly cause: unknown };
    }
);

export interface PluginAssetReader {
  readPluginDefinition(guid: GuidString): Promise<Result<PluginAssetDefinition, unknown>>;
}

export interface PluginProgramEntry {
  readonly load: () => Promise<unknown>;
  /** Export exact portable bytes without evaluating the lazy executable module. */
  readonly exportSource?: () => Promise<import('@forgeax/engine-pack/runtime').PackProgram>;
}

/** An immutable program projection. It contains no Fiber or activation state. */
export interface PluginPrograms {
  readonly sessionId: string;
  readonly contextId: string;
  readonly sessionGeneration: number;
  readonly target: PluginBuildTarget;
  /** Pure declarations; executor keys select entries in the same program projection. */
  readonly tools: ReadonlyMap<
    GuidString,
    import('@forgeax/engine-tool-runtime').ToolCommandContract
  >;
  readonly definitions: ReadonlyMap<GuidString, PluginAssetDefinition['evidence']>;
  readonly programs: ReadonlyMap<string, PluginProgramEntry>;
  readonly imports?: Readonly<
    Record<string, import('@forgeax/engine-pack/runtime').PackProgramImport>
  >;
  readonly programHost?: import('@forgeax/engine-pack/runtime').PackProgramHost;
}

export const pluginAssetOrigin: unique symbol = Symbol('forgeax.pluginAssetOrigin');

export interface PluginAssetOrigin {
  readonly guid: GuidString;
  readonly program: string;
  readonly evidence: PluginAssetDefinition['evidence'];
  readonly sessionId: string;
  readonly contextId: string;
  readonly sessionGeneration: number;
  readonly target: PluginBuildTarget;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginPrograms?: PluginPrograms;
    [pluginAssetOrigin]?: PluginAssetOrigin;
  }
}

export function samePluginEvidence(
  left: PluginAssetDefinition['evidence'] | undefined,
  right: PluginAssetDefinition['evidence'],
): boolean {
  if (left?.kind === 'source' && right.kind === 'source') {
    return left.revision === right.revision && left.digest === right.digest;
  }
  if (left?.kind !== 'publication' || right.kind !== 'publication') return false;
  const a = left.publication,
    b = right.publication;
  return (
    a.scopeId === b.scopeId &&
    a.generation === b.generation &&
    a.digest === b.digest &&
    a.outputSetDigest === b.outputSetDigest
  );
}

/**
 * Owner disposer for a mounted Fiber, safe to yield from an async generator effect.
 * Cordis disposers are thenable, so `yield fiber.dispose` there collects a different
 * function and leaves the child unloading concurrently with its owner's earlier yields.
 */
export function joinPluginFiber(fiber: Fiber): () => Promise<void> {
  return async () => {
    await fiber.dispose();
    while (fiber.inertia) await fiber.inertia;
  };
}

/** Creates a native Fiber; readiness is checked by the host after apply returns. */
export async function mountPluginAsset(
  ctx: Context,
  guid: GuidString,
  signal?: AbortSignal,
): Promise<Result<Fiber, PluginAssetError>> {
  const programs = ctx.pluginPrograms;
  const assets = ctx.get('assets') as PluginAssetReader | undefined;
  if (!programs || !assets?.readPluginDefinition) {
    return err({
      code: 'plugin-asset-read-failed',
      expected: 'assets and pluginPrograms services in the installing Context',
      hint: 'declare both services in inject and configure the host asset reader',
      detail: { guid, cause: 'missing plugin asset services' },
    });
  }
  const expected = programs.definitions.get(guid);
  const executable = programs.tools.has(guid);
  let selected: { readonly program: string; readonly entry: PluginProgramEntry } | undefined;
  let cancelled = false;
  const isCancelled = () => {
    const current = ctx.pluginPrograms;
    return (
      cancelled ||
      signal?.aborted === true ||
      ctx.fiber.uid === null ||
      ctx.fiber.state === 5 ||
      current === undefined ||
      current.sessionId !== programs.sessionId ||
      current.contextId !== programs.contextId ||
      current.sessionGeneration !== programs.sessionGeneration ||
      current.target !== programs.target ||
      current.tools.has(guid) !== executable ||
      (current.definitions.get(guid) !== expected &&
        (expected === undefined || !samePluginEvidence(current.definitions.get(guid), expected))) ||
      (selected !== undefined && current.programs.get(selected.program) !== selected.entry)
    );
  };
  const cancelledResult = (): Result<never, PluginAssetError> =>
    err({
      code: 'plugin-mount-cancelled',
      expected: 'the installing Fiber and program session to remain current',
      hint: 'discard this result and install from the current session',
      detail: { guid, sessionGeneration: programs.sessionGeneration },
    });
  let release: (() => unknown) | undefined;
  try {
    release = ctx.effect(
      () => () => {
        cancelled = true;
      },
      'plugin-asset/pending-mount',
    );
    const definition = await assets.readPluginDefinition(guid);
    if (isCancelled()) return cancelledResult();
    if (!definition.ok)
      return err({
        code: 'plugin-asset-read-failed',
        expected: 'a validated plugin definition and its atomic publication evidence',
        hint: 'inspect and rebuild the owning Pack',
        detail: { guid, cause: definition.error },
      });
    const { asset, evidence } = definition.value;
    if (definition.value.guid !== guid || !samePluginEvidence(expected, evidence))
      return err({
        code: 'plugin-publication-mismatch',
        expected: 'the definition tuple locked by this program inventory',
        hint: 'rebuild and start a new session with one consistent inventory',
        detail: { guid, expected, actual: evidence },
      });
    const entry = programs.programs.get(asset.program);
    if (!entry || !executable)
      return err({
        code: 'plugin-program-unavailable',
        expected: 'a delivered static program for this build target',
        hint: 'include the plugin in the target closure and rebuild',
        detail: { guid, program: asset.program, target: programs.target },
      });
    selected = { program: asset.program, entry };
    if (isCancelled()) return cancelledResult();
    let plugin: unknown;
    try {
      plugin = await entry.load();
    } catch (cause) {
      if (isCancelled()) return cancelledResult();
      return err({
        code: 'plugin-module-invalid',
        expected: 'a loadable native Cordis export',
        hint: 'repair the referenced module and rebuild',
        detail: { guid, program: asset.program, cause },
      });
    }
    if (isCancelled()) return cancelledResult();
    // Module evaluation can await while referenced asset versions change.
    // Reuse the reader's evidence fence without loading or activating those dependencies.
    const currentDefinition = await assets.readPluginDefinition(guid);
    if (isCancelled()) return cancelledResult();
    if (!currentDefinition.ok)
      return err({
        code: 'plugin-asset-read-failed',
        expected: 'the fixed definition and reference versions before native installation',
        hint: 'restore the referenced publications or rebuild the owning Pack',
        detail: { guid, cause: currentDefinition.error },
      });
    if (
      currentDefinition.value.guid !== guid ||
      currentDefinition.value.asset.program !== asset.program ||
      !samePluginEvidence(evidence, currentDefinition.value.evidence)
    )
      return err({
        code: 'plugin-publication-mismatch',
        expected: 'the same definition after loading its program',
        hint: 'retry with the current matching definition and program',
        detail: { guid, expected: evidence, actual: currentDefinition.value.evidence },
      });
    if (!ctx.registry.resolve(plugin as Plugin))
      return err({
        code: 'plugin-module-invalid',
        expected: 'a native function, constructor or apply object',
        hint: 'export the native plugin selected by module.export',
        detail: { guid, program: asset.program, cause: 'unsupported plugin export' },
      });
    const origin: PluginAssetOrigin = Object.freeze({
      guid,
      program: asset.program,
      evidence: structuredClone(evidence),
      sessionId: programs.sessionId,
      contextId: programs.contextId,
      sessionGeneration: programs.sessionGeneration,
      target: programs.target,
    });
    const scope = ctx.extend({ [pluginAssetOrigin]: origin });
    const installed = scope.plugin(plugin as Plugin, structuredClone(asset.config));
    return ok(installed.ctx.fiber);
  } catch (cause) {
    if (isCancelled()) return cancelledResult();
    return err({
      code: 'plugin-activation-failed',
      expected: 'native plugin creation to succeed',
      hint: 'repair the plugin configuration or native creation failure',
      detail: { guid, cause },
    });
  } finally {
    await release?.();
  }
}

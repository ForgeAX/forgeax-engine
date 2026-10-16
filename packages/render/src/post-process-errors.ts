// @forgeax/engine-runtime - fullscreen post-process error model
// (feat-20260604-resource-owning-render-graph-and-fullscreen-postpr M2 / w12;
//  feat-20260609-learn-render-4-5-framebuffers-demo-offscreen-rt-an M1 / T-2
//  added 'fullscreen-input-not-found').
//
// Closed PostProcessErrorCode union + PostProcessError discriminated-union class.
//   - 'post-process-already-registered' (programmer error) -> fullscreen effect registration THROWS a
//     PostProcessError, mirroring ShaderCatalog.installMaterialArtifact's Map.has -> throw
//     fail-fast (research Finding M2-4). A second register under the same id is a coding
//     mistake that must surface immediately.
//   - 'post-process-not-found' (runtime path) -> the typed fullscreen plan returns Result.err with
//     this code when the supplied id resolves to no registered post-process (stale / wrong
//     id). AI users branch on `err.code === 'post-process-not-found'` by property access.
//   - 'fullscreen-input-not-found' (runtime path, feat-20260609 M1 / D-2) -> the
//     dispatchFullscreenPass generic branch THROWS this when reads[0] references a
//     graph resource key that the per-pass resolve context cannot resolve (typo /
//     an unregistered colorTarget / mis-ordered color-target declaration vs the typed fullscreen pass).
//   - 'ssao-radius-non-positive' (runtime path, feat-20260612-hdrp-ssao M2 / w10) ->
//     SSAO radius parameter <= 0; fires when config.ssao.radius value is non-positive.
//   - 'ssao-bias-negative' (runtime path, feat-20260612-hdrp-ssao M2 / w10) ->
//     SSAO bias parameter < 0; fires when config.ssao.bias value is negative.
//
// D-1: a NEW independent union rather than folding into RuntimeErrorCode /
// RuntimeErrorCode's members are render / skin / shadow domain; a separate union
// keeps the post-process error surface cohesive and additively evolvable.
//
// Also per D-4: the fullscreen effect channel is parallel to installMaterialArtifact;
// material shader errors carry 4-BGL / 12-float-vertex / depth / triangle-list semantics,
// while post-process errors carry 0-vertex-buffer / no-depth / input-texture-BGL semantics.
// Mixing the two error spaces would confuse AI users who branch on code for diagnostics.
//
// PostProcessError is exposed as a discriminated union (variant per code, AppError pattern)
// so `if (err.code === 'X')` simultaneously narrows `err.detail` to the per-code payload.
//
// Related: requirements M2 AC-08 + AC-19; plan-strategy D-4 / D-9; charter P3 / P4;
// feat-20260609 M1 plan-decisions D-2 (L-1 lock to scheme B - new closed-set member).

/**
 * Closed union of fullscreen post-process error codes.
 *
 * AI users perform exhaustive `switch (err.code)` without a default
 * and TS guards completeness (AC-08).
 *
 * | code | channel | trigger |
 * |:--|:--|:--|
 * | `'post-process-already-registered'` | throw | a second fullscreen effect registration under an already-registered `id` |
 * | `'post-process-not-found'` | throw / `Result.err` | a typed fullscreen plan whose `shader` id resolves to no registered post-process |
 * | `'fullscreen-input-not-found'` | throw | a typed fullscreen plan whose `reads` key is not a graph-declared color target, or a depth key missing TEXTURE_BINDING (D-4) |
 * | `'ssao-radius-non-positive'` | throw | SSAO `radius <= 0` |
 * | `'ssao-bias-negative'` | throw | SSAO `bias < 0` |
 * | `'params-size-mismatch'` | throw | a fullscreen effect declaration with `params.byteSize < 16` or `defaultValue.length !== byteSize` (feat-20260621 M-A4 / D-4) |
 * | `'params-update-size-mismatch'` | throw | per-frame data-driven write where `PostProcessParams.data` byteLength !== registered `params.byteSize` (feat-20260621 M-A4 / D-4) |
 */
export type PostProcessErrorCode = keyof typeof POST_PROCESS_POLICY;

/**
 * Detail for `'post-process-already-registered'`: the post-process id that was already taken.
 * AI consumers read `.detail.id` by property access (charter P4), no message parsing.
 */
export interface PostProcessPreviouslyRegisteredDetail {
  readonly id: string;
}

/**
 * Detail for `'post-process-not-found'`: the post-process id that resolved to no
 * registered entry. Read via `.detail.id` after the code guard.
 */
export interface PostProcessNotFoundDetail {
  readonly id: string;
}

/**
 * Detail for `'fullscreen-input-not-found'`: the graph resource key that the
 * per-pass resolve context could not resolve, plus the pass name that referenced
 * it. Both fields are read via property access after `if (err.code === 'fullscreen-input-not-found')`
 * (charter P4); the AI user immediately knows WHICH key to declare and WHICH
 * pass needs wiring.
 */
export interface FullscreenInputNotFoundDetail {
  /** The reads[0] key that resolved to undefined (e.g. 'offscreenColor' / 'hdrColor'). */
  readonly readsKey: string;
  /** The name assigned to the typed fullscreen pass (e.g. 'pp' / 'post'). */
  readonly passName: string;
}

/**
 * Detail for `'ssao-radius-non-positive'`: the SSAO radius parameter was zero or negative.
 * AI consumers read `.detail.paramName` / `.detail.value` by property access (charter P4).
 */
export interface SsaoRadiusNonPositiveDetail {
  readonly paramName: string;
  readonly value: number;
}

/**
 * Detail for `'ssao-bias-negative'`: the SSAO bias parameter was negative.
 * AI consumers read `.detail.paramName` / `.detail.value` by property access.
 */
export interface SsaoBiasNegativeDetail {
  readonly paramName: string;
  readonly value: number;
}

/**
 * Detail for `'params-size-mismatch'`: the register call's byteSize / defaultValue.length
 * is invalid. Carries `byteSize` (the declared size) and `actualLength` (defaultValue.length).
 * AI consumers read `.detail.byteSize` / `.detail.actualLength` after the code guard.
 */
export interface PostProcessParamsSizeMismatchDetail {
  readonly byteSize: number;
  readonly actualLength: number;
}

/**
 * Detail for `'params-update-size-mismatch'`: the per-frame data-driven write
 * (PostProcessParams.data) had a byteLength that did not equal the registered
 * `params.byteSize`. Carries `byteSize` (registered) + `actualLength` (the
 * supplied data byteLength). AI consumers read `.detail.byteSize` /
 * `.detail.actualLength` after the code guard.
 *
 * NOTE (feat-20260621 M-A2): this code is wired here so dispatchFullscreenPass
 * can fail-fast on a mismatched per-frame write; the full error-model
 * formalization (expected/hint refinement, JSDoc member count, public
 * PostProcessError union variant) is finished in M-A4.
 */
export interface PostProcessParamsUpdateSizeMismatchDetail {
  readonly byteSize: number;
  readonly actualLength: number;
}

/**
 * Conditional resolver from `PostProcessErrorCode` to its detail payload type. Used by the
 * constructor signature so `new PostProcessError({ code: 'X', detail })` narrows the
 * `detail` parameter to the variant payload at compile time.
 */
export type PostProcessErrorDetailFor<C extends PostProcessErrorCode> =
  C extends 'ssao-parameter-invalid'
    ? { readonly paramName: string; readonly value: unknown }
    : C extends 'post-process-already-registered'
      ? PostProcessPreviouslyRegisteredDetail
      : C extends 'post-process-not-found'
        ? PostProcessNotFoundDetail
        : C extends 'fullscreen-input-not-found'
          ? FullscreenInputNotFoundDetail
          : C extends 'ssao-radius-non-positive'
            ? SsaoRadiusNonPositiveDetail
            : C extends 'ssao-bias-negative'
              ? SsaoBiasNegativeDetail
              : C extends 'params-size-mismatch'
                ? PostProcessParamsSizeMismatchDetail
                : C extends 'params-update-size-mismatch'
                  ? PostProcessParamsUpdateSizeMismatchDetail
                  : never;

/**
 * Tagged union of `.detail` payloads. The variants are unique by structural fields
 * (`{ id }` for the two id-by-string variants vs `{ readsKey, passName }` for the
 * graph-resource-miss variant); the code discriminator narrows the intent across
 * the two id-shaped variants.
 */
export type PostProcessErrorDetail = PostProcessErrorDetailFor<PostProcessErrorCode>;

const POST_PROCESS_POLICY = {
  'post-process-already-registered': {
    expected: 'each post-process id is registered at most once',
    hint: (detail) =>
      `post-process id '${(detail as PostProcessPreviouslyRegisteredDetail).id}' is already ` +
      'registered; same-id re-register is forbidden. Pick a distinct id ' +
      '(engine builtins use the forgeax:: prefix; user passes use <package>::<id>).',
  },
  'post-process-not-found': {
    expected: 'typed fullscreen plan references a registered post-process id',
    hint: (detail) =>
      `no post-process is registered for id '${(detail as PostProcessNotFoundDetail).id}'. ` +
      'For Engine-owned effects, rebuild the shader manifest with that Engine entry enabled. ' +
      `For custom effects, register '${(detail as PostProcessNotFoundDetail).id}' with the feature host ({source, reads?}), ` +
      'then reference it from a typed fullscreen RenderFeaturePlan.',
  },
  'fullscreen-input-not-found': {
    expected: 'reads key must be a graph-declared colorTarget with TEXTURE_BINDING',
    hint: (detail) => {
      const d = detail as FullscreenInputNotFoundDetail;
      return (
        `fullscreen pass '${d.passName}' references reads key '${d.readsKey}' but that key is not ` +
        `declared as a graph color target, or the target is not sampleable as a texture. ` +
        `First declare graph color target '${d.readsKey}' with its format and size ` +
        `(or check spelling) before the typed fullscreen pass '${d.passName}' reads it. ` +
        `If '${d.readsKey}' is a depth target, ensure it has TEXTURE_BINDING usage (0x04) ` +
        `and is declared via graph.addColorTarget. Consider switching pipeline if your pipeline does not expose a sampleable depth target.`
      );
    },
  },
  'ssao-parameter-invalid': {
    expected: 'finite non-negative SSAO intensity and low, medium, or high quality',
    hint: () =>
      'Set ssao.algorithm to ssao or gtao, ssao.intensity to a finite non-negative value and ssao.quality to low, medium, or high.',
  },
  'ssao-radius-non-positive': {
    expected: 'SSAO radius must be > 0',
    hint: (detail) => {
      const d = detail as SsaoRadiusNonPositiveDetail;
      return (
        `SSAO parameter '${d.paramName}' is ${d.value}, must be greater than 0. ` +
        `Set config.ssao.${d.paramName} to a positive value (default 0.5) or disable SSAO with config.ssao.enabled = false.`
      );
    },
  },
  'ssao-bias-negative': {
    expected: 'SSAO bias must be >= 0',
    hint: (detail) => {
      const d = detail as SsaoBiasNegativeDetail;
      return (
        `SSAO parameter '${d.paramName}' is ${d.value}, must be >= 0. ` +
        `Set config.ssao.${d.paramName} to a non-negative value (default 0.025) or disable SSAO.`
      );
    },
  },
  'params-size-mismatch': {
    expected: 'params.byteSize >= 16 and defaultValue.length === byteSize',
    hint: (detail) => {
      const d = detail as PostProcessParamsSizeMismatchDetail;
      return (
        `params.byteSize is ${d.byteSize} but defaultValue.length is ${d.actualLength}. ` +
        'The UBO byteSize must be >= 16 B and defaultValue.length must equal byteSize. ' +
        'Pass a defaultValue Uint8Array whose .length matches byteSize exactly.'
      );
    },
  },
  'params-update-size-mismatch': {
    expected: 'PostProcessParams.data byteLength === registered params.byteSize',
    hint: (detail) => {
      const d = detail as PostProcessParamsUpdateSizeMismatchDetail;
      return (
        `PostProcessParams.data byteLength is ${d.actualLength} but the registered ` +
        `params.byteSize is ${d.byteSize}. The per-frame data-driven write must match ` +
        'the registered byteSize exactly; check the PostProcessParams.data you assign each frame.'
      );
    },
  },
} satisfies Record<
  string,
  {
    readonly expected: string;
    readonly hint: (detail: unknown) => string;
  }
>;

class PostProcessErrorClass<C extends PostProcessErrorCode> extends Error {
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PostProcessErrorDetailFor<C>;

  constructor(args: { code: C; detail: PostProcessErrorDetailFor<C> }) {
    const policy = POST_PROCESS_POLICY[args.code];
    const hint = policy.hint(args.detail);
    super(`post-process: ${args.code} (${hint})`);
    this.name = 'PostProcessError';
    this.code = args.code;
    this.expected = policy.expected;
    this.hint = hint;
    this.detail = args.detail;
  }
}

/**
 * Variant intersection: a `PostProcessErrorClass` instance whose `code` literal narrows to
 * `C` and whose `detail` narrows to `PostProcessErrorDetailFor<C>`, so `if (err.code === 'X')`
 * simultaneously narrows `err.detail` (charter P3 + P4 discriminated union).
 */
type PostProcessErrorVariant<C extends PostProcessErrorCode> = PostProcessErrorClass<C> & {
  readonly code: C;
  readonly detail: PostProcessErrorDetailFor<C>;
};

interface PostProcessErrorConstructor {
  new <C extends PostProcessErrorCode>(args: {
    code: C;
    detail: PostProcessErrorDetailFor<C>;
  }): PostProcessErrorVariant<C>;
  readonly prototype: PostProcessErrorClass<PostProcessErrorCode>;
}

/**
 * Public PostProcessError type - mapped from the authoritative code union.
 *
 * ```ts
 * function recover(err: PostProcessError): string {
 *   switch (err.code) {
 *     case 'post-process-already-registered': return `id taken: ${err.detail.id}`;
 *     case 'post-process-not-found':          return `bad id: ${err.detail.id}`;
 *     case 'fullscreen-input-not-found':      return `bad reads key: ${err.detail.readsKey} on pass ${err.detail.passName}`;
 *   }
 * }
 * ```
 */
export type PostProcessError = {
  [C in PostProcessErrorCode]: PostProcessErrorVariant<C>;
}[PostProcessErrorCode];

/**
 * PostProcessError constructor - `new PostProcessError({ code, detail })`.
 *
 * The generic `C` is inferred from the literal `code` argument, which narrows `detail` to
 * the per-code payload (`PostProcessErrorDetailFor<C>`) and narrows the return type to the
 * corresponding `PostProcessErrorVariant<C>` so the call site walks the discriminated union
 * without manual cast (AppError pattern; TS class declarations cannot directly express
 * `<C> ... PostProcessErrorVariant<C>` polymorphism, hence the typed-cast affordance).
 */
export const PostProcessError: PostProcessErrorConstructor = PostProcessErrorClass;

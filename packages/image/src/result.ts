// Result<T, E> + ok / err live in `@forgeax/engine-types` (tweak-20260612-result-
// into-types). They were duplicated here as a lite (plain-object, no `unwrap`)
// variant; consolidated upstream into the same shape used by rhi / ecs / naga.
// The barrel here re-exports them so existing
// `import { err, ok, Result, ResultOk, ResultErr } from '@forgeax/engine-image'`
// consumers (and intra-package `./result.js` imports) stay unchanged.
export {
  err,
  ok,
  type Result,
  type ResultErr,
  type ResultOk,
} from '@forgeax/engine-types';

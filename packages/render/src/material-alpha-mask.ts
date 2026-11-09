/**
 * Alpha test is a compile-time material variant (ALPHA_MASK). A material with
 * a positive alphaCutoff or an enabled alphaHash selects the alpha-mask lane;
 * every other material selects the opaque program, which contains no
 * reachable discard. On tile-based GPUs (Apple TBDR) any reachable discard in
 * a pipeline disables hidden-surface removal for that pipeline, so a runtime
 * branch or pipeline override is not a substitute for this split.
 */
export function materialAlphaMask(
  paramSnapshot: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return Number(paramSnapshot?.alphaCutoff ?? 0) > 0 || Number(paramSnapshot?.alphaHash ?? 0) > 0.5;
}

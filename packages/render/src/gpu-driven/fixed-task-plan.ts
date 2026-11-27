import type { SubmissionPlan } from './batch-topology';

// Only execution producers call this after capturing their task headers.
// A public readonly type, shallow freeze, or a MemberCandidates instance does
// not admit raw/custom header getters to identity-based encoding reuse.
const fixed = new WeakSet<SubmissionPlan>();
// Membership is a smaller fact than encoded headers: native execution may
// still resolve a physical fallback material against the current Scene.
// The active list can outlive its resident frame without keeping dormant geometry alive.
const membership = new WeakMap<SubmissionPlan, true | WeakRef<SubmissionPlan>>();

/** Only the mesh producer can establish the exact ordered selection of another frame. */
export function isIssuedExecution(plan: SubmissionPlan, resident: SubmissionPlan): boolean {
  const issued = membership.get(plan);
  return (
    issued !== undefined && (plan === resident || (issued !== true && issued.deref() === resident))
  );
}

// The Mesh publisher owns binding order independently of candidate rows and physical ranges.
const materialLayouts = new WeakMap<object, symbol>();

export function materialBindingLayout(batches: object): symbol | undefined {
  return materialLayouts.get(batches);
}

export function captureTaskMembership(
  plan: SubmissionPlan,
  layout?: symbol,
  resident?: SubmissionPlan,
): SubmissionPlan {
  if (layout !== undefined) materialLayouts.set(plan.batches, layout);
  membership.set(plan, resident === undefined ? true : new WeakRef(resident));
  return plan;
}
export function hasCapturedTaskMembership(plan: SubmissionPlan): boolean {
  return membership.has(plan);
}
export function fixedTaskPlan(plan: SubmissionPlan): SubmissionPlan {
  fixed.add(plan);
  return plan;
}
export function hasFixedTaskHeaders(plan: SubmissionPlan): boolean {
  return fixed.has(plan);
}
export function inheritTaskHeaders(source: SubmissionPlan, plan: SubmissionPlan): SubmissionPlan {
  return fixed.has(source) ? fixedTaskPlan(plan) : plan;
}

import type { SubmissionPlan } from './batch-topology';

// Only execution producers call this after capturing their task headers.
// A public readonly type, shallow freeze, or a MemberCandidates instance does
// not admit raw/custom header getters to identity-based encoding reuse.
const fixed = new WeakSet<SubmissionPlan>();
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

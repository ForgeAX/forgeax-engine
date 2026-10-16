import { it } from 'vitest';

// Explicit diagnosis: original generated-game case, budgets and falsifiers.
// Instrumented runs are never distribution or performance qualification.
if (
  process.env.FOCUS_SELECTOR ===
  'packages/devkit/src/__tests__/view-ibl-startup-diagnostic.integration.test.ts'
) {
  await import('./new-project-workers.e2e.test.js');
} else {
  it.skip('observes actual IBL startup only through an explicit CI Focus request', () => {});
}

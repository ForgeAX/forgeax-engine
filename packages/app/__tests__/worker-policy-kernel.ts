import { defineComponent, type QuerySpan } from '@forgeax/engine-ecs';
export const WorkerCounter = defineComponent('WorkerPolicyCounter', { value: 'f32', fail: 'f32' });
export function run(spans: readonly QuerySpan[]): void {
  for (const span of spans) {
    const rows = span.mut(WorkerCounter);
    for (let i = 0; i < span.length; i++) {
      rows.value[i] = (rows.value[i] ?? 0) + 1;
      if (rows.fail[i]) throw new Error('injected shared write failure');
    }
  }
}
export default { run };

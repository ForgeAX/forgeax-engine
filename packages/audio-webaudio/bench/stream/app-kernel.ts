import { defineComponent, type QuerySpan } from '@forgeax/engine-ecs';
export const AudioCounter = defineComponent('AudioCounter', { value: 'f32' });
export function run(spans: readonly QuerySpan[]) {
  for (const span of spans) {
    const rows = span.mut(AudioCounter);
    for (let i = 0; i < span.length; i++) rows.value[i] = (rows.value[i] ?? 0) + 1;
  }
}
export default { run };

import { defineComponent, type QuerySpan } from '@forgeax/engine/ecs';
export const AcousticCounter = defineComponent('AcousticCounter', { value: 'f32' });
export function run(spans: readonly QuerySpan[]) {
  for (const span of spans) { const values = span.mut(AcousticCounter).value;
    for (let i=0;i<span.length;i++) values[i]=(values[i]??0)+1;
  }
}
export default { run };

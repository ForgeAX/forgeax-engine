import { it } from 'vitest';
import { runPipelineBindingState } from './pipeline-binding-state.fixture';

it(
  'retains shared bindings across pipeline changes and rejects incompatible material bindings',
  runPipelineBindingState,
  60_000,
);

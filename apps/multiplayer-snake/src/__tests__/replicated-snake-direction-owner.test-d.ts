import { expectTypeOf } from 'vitest';
import type { ReplicatedSnake } from '../client';
import type { Direction } from '../shared/commands';

expectTypeOf<ReplicatedSnake['direction']>().toEqualTypeOf<Direction>();
expectTypeOf<'not-a-direction'>().not.toExtend<Direction>();

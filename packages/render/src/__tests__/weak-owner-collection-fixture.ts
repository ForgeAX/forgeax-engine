import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

setFlagsFromString('--expose-gc');
const collect = runInNewContext('gc') as () => void;

/** Fixed collection turns; callers dereference only after this observation completes. */
export async function collectWeakOwners(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  collect();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  collect();
}

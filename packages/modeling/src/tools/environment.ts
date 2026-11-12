import { TS_KERNEL_DIGEST } from '../compute/kernel-digest';

/** What produced a tool report: the kernel build digest, comparable with the source digest. */
export interface ToolEnvironment {
  readonly kernel: string;
}

export function environmentOf(): ToolEnvironment {
  return { kernel: TS_KERNEL_DIGEST };
}

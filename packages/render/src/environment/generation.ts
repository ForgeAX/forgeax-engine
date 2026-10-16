import type { DeviceScope } from '../device/device-scope';

export interface EnvironmentGeneration {
  readonly signature: string;
  readonly generation: number;
  readonly lane: 'direct' | 'clustered';
  readonly scope: DeviceScope;
  readonly liveHandle: object;
  readonly resourceCount: number;
  readonly resourceBytes: number;
  retired: boolean;
}

export interface EnvironmentGenerationFailure {
  readonly failureAt?: 'prepare' | 'build' | 'execute' | 'finish' | 'submit';
}

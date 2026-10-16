import type { Result } from '@forgeax/engine-types';
import type { IntelligenceError, IntelligenceFailure } from './errors';

declare const activityIdBrand: unique symbol;

/** Opaque identity of one bounded asynchronous operation. */
export type ActivityId = string & { readonly [activityIdBrand]: true };

/** Provider-scoped durable conversation identity. */
export interface SessionRef {
  readonly providerId: string;
  readonly id: string;
}

export interface ActivityRef {
  readonly id: ActivityId;
  readonly session: SessionRef;
}

export interface ActivityRequest {
  readonly input: string;
  readonly session?: SessionRef;
}

/** Fully identified request used by realm transports and provider dispatch. */
export interface ActivitySubmission extends ActivityRef {
  readonly input: string;
}

export type ActivityEvent =
  | {
      readonly type: 'text-delta';
      readonly activityId: ActivityId;
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly type: 'completed';
      readonly activityId: ActivityId;
      readonly sequence: number;
      readonly session: SessionRef;
      readonly output: string;
    }
  | {
      readonly type: 'failed';
      readonly activityId: ActivityId;
      readonly sequence: number;
      readonly error: IntelligenceFailure;
    }
  | {
      readonly type: 'cancelled';
      readonly activityId: ActivityId;
      readonly sequence: number;
    };

export interface ActivitySink {
  text(text: string): void;
  complete(output: string): void;
  fail(cause: unknown): void;
  cancelled(): void;
}

/** Provider implementation boundary. It never receives World or Renderer authority. */
export interface IntelligenceProvider {
  readonly id: string;
  start(submission: ActivitySubmission, sink: ActivitySink): Result<void, IntelligenceError>;
  cancel(activityId: ActivityId): Result<void, IntelligenceError>;
  close(): Promise<void>;
}

/** Frame-safe consumer surface. No method waits for provider work. */
export interface IntelligenceService {
  readonly providerId: string;
  submit(request: ActivityRequest): Result<ActivityRef, IntelligenceError>;
  poll(maxEvents?: number): readonly ActivityEvent[];
  cancel(activityId: ActivityId): Result<void, IntelligenceError>;
  close(): Promise<void>;
}

export interface IntelligenceLimits {
  readonly maxInputChars: number;
  readonly maxOutputChars: number;
  readonly maxConcurrentActivities: number;
  readonly maxPendingEventsPerActivity: number;
  readonly maxPollEvents: number;
}

export const DEFAULT_INTELLIGENCE_LIMITS: IntelligenceLimits = {
  maxInputChars: 16_384,
  maxOutputChars: 65_536,
  maxConcurrentActivities: 8,
  maxPendingEventsPerActivity: 256,
  maxPollEvents: 64,
};

export interface IntelligenceRuntimeOptions {
  readonly limits?: Partial<IntelligenceLimits>;
  readonly createActivityId?: () => ActivityId;
  readonly createSessionId?: () => string;
}

export function activityId(value: string): ActivityId {
  return value as ActivityId;
}

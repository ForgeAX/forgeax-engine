import { err, ok, type Result } from '@forgeax/engine-types';
import { IntelligenceError, intelligenceFailure, providerError } from './errors';
import {
  type ActivityEvent,
  type ActivityId,
  type ActivityRef,
  type ActivityRequest,
  type ActivitySink,
  type ActivitySubmission,
  activityId,
  DEFAULT_INTELLIGENCE_LIMITS,
  type IntelligenceLimits,
  type IntelligenceProvider,
  type IntelligenceRuntimeOptions,
  type IntelligenceService,
} from './types';

interface ActivityRecord {
  readonly ref: ActivityRef;
  readonly events: ActivityEvent[];
  sequence: number;
  outputChars: number;
  terminal: boolean;
}

let fallbackIdentity = 0;

/** @internal Realm-neutral default identity source for direct and transported requests. */
export function nextIntelligenceIdentity(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `${prefix}-${uuid}`;
  fallbackIdentity += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackIdentity.toString(36)}`;
}

export function resolveIntelligenceLimits(
  overrides: Partial<IntelligenceLimits> | undefined,
): IntelligenceLimits {
  const limits = { ...DEFAULT_INTELLIGENCE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`);
    }
  }
  if (limits.maxPendingEventsPerActivity < 2) {
    throw new RangeError(
      'maxPendingEventsPerActivity must reserve at least one data and terminal event',
    );
  }
  return limits;
}

/** @internal One admission policy for the Host runtime and its realm client. */
export function validateActivityRequest(
  request: ActivityRequest,
  providerId: string,
  maxInputChars: number,
  closed: boolean,
): Result<void, IntelligenceError> {
  if (closed) return err(new IntelligenceError({ code: 'intelligence-closed', detail: {} }));
  if (request.input.length === 0 || request.input.length > maxInputChars) {
    return err(
      new IntelligenceError({
        code: 'intelligence-invalid-request',
        detail: {
          field: 'input',
          reason:
            request.input.length === 0
              ? 'input is empty'
              : `input exceeds ${maxInputChars} characters`,
        },
      }),
    );
  }
  if (request.session !== undefined && request.session.providerId !== providerId) {
    return err(
      new IntelligenceError({
        code: 'intelligence-session-provider-mismatch',
        detail: {
          expectedProviderId: providerId,
          receivedProviderId: request.session.providerId,
        },
      }),
    );
  }
  return ok(undefined);
}

export class IntelligenceRuntime implements IntelligenceService {
  readonly providerId: string;
  readonly limits: IntelligenceLimits;
  private readonly records = new Map<ActivityId, ActivityRecord>();
  private readonly createActivityId: () => ActivityId;
  private readonly createSessionId: () => string;
  private closed = false;
  private closeTask: Promise<void> | undefined;

  constructor(
    private readonly provider: IntelligenceProvider,
    options: IntelligenceRuntimeOptions = {},
  ) {
    this.providerId = provider.id;
    this.limits = resolveIntelligenceLimits(options.limits);
    this.createActivityId =
      options.createActivityId ?? (() => activityId(nextIntelligenceIdentity('activity')));
    this.createSessionId = options.createSessionId ?? (() => nextIntelligenceIdentity('session'));
  }

  submit(request: ActivityRequest): Result<ActivityRef, IntelligenceError> {
    const validated = this.validateRequest(request);
    if (!validated.ok) return validated;
    const ref: ActivityRef = {
      id: this.createActivityId(),
      session: request.session ?? { providerId: this.providerId, id: this.createSessionId() },
    };
    const accepted = this.accept({ ...ref, input: request.input });
    return accepted.ok ? ok(ref) : accepted;
  }

  /** Accept an already identified request from a realm transport. */
  accept(submission: ActivitySubmission): Result<void, IntelligenceError> {
    const validated = this.validateRequest({
      input: submission.input,
      session: submission.session,
    });
    if (!validated.ok) return validated;
    if (this.records.has(submission.id)) {
      return err(
        providerError(this.providerId, `duplicate activity identity: ${String(submission.id)}`),
      );
    }
    if (this.runningCount >= this.limits.maxConcurrentActivities) {
      return err(
        new IntelligenceError({
          code: 'intelligence-capacity-exceeded',
          detail: { limit: this.limits.maxConcurrentActivities },
        }),
      );
    }
    const record: ActivityRecord = {
      ref: { id: submission.id, session: submission.session },
      events: [],
      sequence: 0,
      outputChars: 0,
      terminal: false,
    };
    this.records.set(submission.id, record);
    let started: Result<void, IntelligenceError>;
    try {
      started = this.provider.start(submission, this.createSink(record));
    } catch (cause) {
      this.records.delete(submission.id);
      return err(providerError(this.providerId, cause));
    }
    if (!started.ok) {
      this.records.delete(submission.id);
      return started;
    }
    return ok(undefined);
  }

  poll(maxEvents = this.limits.maxPollEvents): readonly ActivityEvent[] {
    if (!Number.isInteger(maxEvents) || maxEvents <= 0) return [];
    const bounded = Math.min(maxEvents, this.limits.maxPollEvents);
    const events: ActivityEvent[] = [];
    for (const [id, record] of this.records) {
      while (record.events.length > 0 && events.length < bounded) {
        const event = record.events.shift();
        if (event !== undefined) events.push(event);
      }
      if (record.terminal && record.events.length === 0) this.records.delete(id);
      if (events.length === bounded) break;
    }
    return events;
  }

  cancel(activity: ActivityId): Result<void, IntelligenceError> {
    if (this.closed) return err(this.closedError());
    const record = this.records.get(activity);
    if (record === undefined || record.terminal) {
      return err(
        new IntelligenceError({
          code: 'intelligence-activity-not-found',
          detail: { activityId: activity },
        }),
      );
    }
    try {
      return this.provider.cancel(activity);
    } catch (cause) {
      return err(providerError(this.providerId, cause));
    }
  }

  close(): Promise<void> {
    this.closeTask ??= this.performClose();
    return this.closeTask;
  }

  private async performClose(): Promise<void> {
    this.closed = true;
    try {
      await this.provider.close();
    } catch {
      // Disposal is terminal; provider failure must not strand the realm transport.
    }
    this.records.clear();
  }

  private get runningCount(): number {
    let count = 0;
    for (const record of this.records.values()) if (!record.terminal) count += 1;
    return count;
  }

  private validateRequest(request: ActivityRequest): Result<void, IntelligenceError> {
    return validateActivityRequest(
      request,
      this.providerId,
      this.limits.maxInputChars,
      this.closed,
    );
  }

  private createSink(record: ActivityRecord): ActivitySink {
    return {
      text: (text) => {
        if (this.closed || record.terminal || text.length === 0) return;
        if (record.outputChars + text.length > this.limits.maxOutputChars) {
          this.overflow(record, 'output-chars', this.limits.maxOutputChars);
          return;
        }
        if (record.events.length >= this.limits.maxPendingEventsPerActivity - 1) {
          this.overflow(record, 'pending-events', this.limits.maxPendingEventsPerActivity);
          return;
        }
        record.outputChars += text.length;
        this.push(record, { type: 'text-delta', text });
      },
      complete: (output) => {
        if (this.closed || record.terminal) return;
        if (output.length > this.limits.maxOutputChars) {
          this.overflow(record, 'output-chars', this.limits.maxOutputChars);
          return;
        }
        record.terminal = true;
        this.push(record, { type: 'completed', session: record.ref.session, output });
      },
      fail: (cause) => {
        if (this.closed || record.terminal) return;
        record.terminal = true;
        const error = providerError(this.providerId, cause);
        this.push(record, { type: 'failed', error: intelligenceFailure(error) });
      },
      cancelled: () => {
        if (this.closed || record.terminal) return;
        record.terminal = true;
        this.push(record, { type: 'cancelled' });
      },
    };
  }

  private overflow(
    record: ActivityRecord,
    bound: 'output-chars' | 'pending-events',
    limit: number,
  ): void {
    if (record.terminal) return;
    record.terminal = true;
    const error = new IntelligenceError({
      code: 'intelligence-output-overflow',
      detail: { activityId: record.ref.id, bound, limit },
    });
    if (record.events.length >= this.limits.maxPendingEventsPerActivity) record.events.pop();
    this.push(record, { type: 'failed', error: intelligenceFailure(error) });
    try {
      this.provider.cancel(record.ref.id);
    } catch {
      // The overflow terminal already owns the activity outcome.
    }
  }

  private push(
    record: ActivityRecord,
    event:
      | { readonly type: 'text-delta'; readonly text: string }
      | {
          readonly type: 'completed';
          readonly session: ActivityRef['session'];
          readonly output: string;
        }
      | { readonly type: 'failed'; readonly error: ReturnType<typeof intelligenceFailure> }
      | { readonly type: 'cancelled' },
  ): void {
    record.sequence += 1;
    record.events.push({
      ...event,
      activityId: record.ref.id,
      sequence: record.sequence,
    } as ActivityEvent);
  }

  private closedError(): IntelligenceError {
    return new IntelligenceError({ code: 'intelligence-closed', detail: {} });
  }
}

export function createIntelligenceRuntime(
  provider: IntelligenceProvider,
  options: IntelligenceRuntimeOptions = {},
): IntelligenceRuntime {
  return new IntelligenceRuntime(provider, options);
}

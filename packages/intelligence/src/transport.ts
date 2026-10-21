import { err, ok, type Result } from '@forgeax/engine-types';
import { IntelligenceError, intelligenceFailure } from './errors';
import {
  type IntelligenceRuntime,
  nextIntelligenceIdentity,
  resolveIntelligenceLimits,
  validateActivityRequest,
} from './runtime';
import {
  type ActivityEvent,
  type ActivityId,
  type ActivityRef,
  type ActivityRequest,
  type ActivitySubmission,
  activityId,
  type IntelligenceLimits,
  type IntelligenceRuntimeOptions,
  type IntelligenceService,
} from './types';

export type IntelligenceHostCommand =
  | { readonly kind: 'intelligence-submit'; readonly submission: ActivitySubmission }
  | { readonly kind: 'intelligence-poll'; readonly maxEvents: number }
  | { readonly kind: 'intelligence-cancel'; readonly activityId: ActivityId }
  | { readonly kind: 'intelligence-close' };

export type IntelligenceRealmMessage =
  | { readonly kind: 'intelligence-events'; readonly events: readonly ActivityEvent[] }
  | { readonly kind: 'intelligence-closed' }
  | {
      readonly kind: 'intelligence-rejected';
      readonly activityId: ActivityId;
      readonly error: import('./errors').IntelligenceFailure;
    };

export interface IntelligenceMessagePort {
  postMessage(message: IntelligenceHostCommand | IntelligenceRealmMessage): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>) => void,
  ): void;
  start?(): void;
  close(): void;
}

export interface IntelligencePortBinding {
  close(): Promise<void>;
}

/** Bind a Host-owned runtime to the realm side of a MessageChannel. */
export function bindIntelligencePort(
  port: IntelligenceMessagePort,
  runtime: IntelligenceRuntime,
): IntelligencePortBinding {
  let closeTask: Promise<void> | undefined;
  const listener = (
    event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>,
  ): void => {
    if (closeTask !== undefined) return;
    const message = event.data;
    if (message.kind === 'intelligence-submit') {
      const accepted = runtime.accept(message.submission);
      if (!accepted.ok) {
        const failure = intelligenceFailure(accepted.error);
        port.postMessage({
          kind: 'intelligence-rejected',
          activityId: message.submission.id,
          error: failure,
        });
      }
      return;
    }
    if (message.kind === 'intelligence-poll') {
      const events = runtime.poll(message.maxEvents);
      try {
        port.postMessage({ kind: 'intelligence-events', events });
      } catch {
        // Poll is destructive; a failed response must terminate the Host binding
        // so the drained events cannot remain attached to a live runtime.
        void close().catch(() => undefined);
      }
      return;
    }
    if (message.kind === 'intelligence-cancel') {
      runtime.cancel(message.activityId);
      return;
    }
    if (message.kind === 'intelligence-close') void close();
  };
  const close = (): Promise<void> => {
    if (closeTask !== undefined) return closeTask;
    closeTask = Promise.resolve().then(async () => {
      await runtime.close();
      try {
        port.postMessage({ kind: 'intelligence-closed' });
      } catch {
        // A failed terminal notification must not strand the physical transport.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      port.close();
    });
    port.removeEventListener('message', listener);
    return closeTask;
  };
  port.addEventListener('message', listener);
  port.start?.();
  return { close };
}

/** Worker/main-realm client. Polling is request/response and never awaits a Host provider. */
export class IntelligencePortClient implements IntelligenceService {
  readonly limits: IntelligenceLimits;
  private readonly received: ActivityEvent[] = [];
  private readonly active = new Set<ActivityId>();
  private readonly createActivityId: () => ActivityId;
  private readonly createSessionId: () => string;
  private readonly listener: (
    event: MessageEvent<IntelligenceHostCommand | IntelligenceRealmMessage>,
  ) => void;
  private state: 'open' | 'closing' | 'closed' = 'open';
  private pollPending = false;
  private closeTask: Promise<void> | undefined;
  private closeResolve: (() => void) | undefined;

  constructor(
    readonly providerId: string,
    private readonly port: IntelligenceMessagePort,
    options: IntelligenceRuntimeOptions = {},
  ) {
    this.limits = resolveIntelligenceLimits(options.limits);
    this.createActivityId =
      options.createActivityId ?? (() => activityId(nextIntelligenceIdentity('activity')));
    this.createSessionId = options.createSessionId ?? (() => nextIntelligenceIdentity('session'));
    this.listener = (event) => {
      const message = event.data;
      if (this.state !== 'open' && message.kind !== 'intelligence-closed') return;
      if (message.kind === 'intelligence-events') {
        this.pollPending = false;
        for (const item of message.events) {
          this.received.push(item);
          if (item.type !== 'text-delta') this.active.delete(item.activityId);
        }
      } else if (message.kind === 'intelligence-rejected') {
        this.active.delete(message.activityId);
        this.received.push({
          type: 'failed',
          activityId: message.activityId,
          sequence: 1,
          error: message.error,
        });
      } else if (message.kind === 'intelligence-closed') {
        this.retireTransport();
      }
    };
    port.addEventListener('message', this.listener);
    port.start?.();
  }

  private clearPending(): void {
    this.received.length = 0;
    this.active.clear();
    this.pollPending = false;
  }

  private retireTransport(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.clearPending();
    this.port.removeEventListener('message', this.listener);
    this.port.close();
    this.closeResolve?.();
    this.closeResolve = undefined;
    this.closeTask ??= Promise.resolve();
  }

  submit(request: ActivityRequest): Result<ActivityRef, IntelligenceError> {
    const validated = validateActivityRequest(
      request,
      this.providerId,
      this.limits.maxInputChars,
      this.state !== 'open',
    );
    if (!validated.ok) return validated;
    if (this.active.size >= this.limits.maxConcurrentActivities) {
      return err(
        new IntelligenceError({
          code: 'intelligence-capacity-exceeded',
          detail: { limit: this.limits.maxConcurrentActivities },
        }),
      );
    }
    const ref: ActivityRef = {
      id: this.createActivityId(),
      session: request.session ?? { providerId: this.providerId, id: this.createSessionId() },
    };
    this.active.add(ref.id);
    try {
      this.port.postMessage({
        kind: 'intelligence-submit',
        submission: { ...ref, input: request.input },
      });
    } catch {
      this.retireTransport();
      return err(new IntelligenceError({ code: 'intelligence-closed', detail: {} }));
    }
    return ok(ref);
  }

  poll(maxEvents = this.limits.maxPollEvents): readonly ActivityEvent[] {
    if (this.state !== 'open' || !Number.isInteger(maxEvents) || maxEvents <= 0) return [];
    const count = Math.min(maxEvents, this.limits.maxPollEvents);
    const events = this.received.splice(0, count);
    if (!this.pollPending) {
      this.pollPending = true;
      try {
        this.port.postMessage({ kind: 'intelligence-poll', maxEvents: count });
      } catch {
        this.retireTransport();
        return [];
      }
    }
    return events;
  }

  cancel(id: ActivityId): Result<void, IntelligenceError> {
    if (this.state !== 'open')
      return err(new IntelligenceError({ code: 'intelligence-closed', detail: {} }));
    if (!this.active.has(id)) {
      return err(
        new IntelligenceError({
          code: 'intelligence-activity-not-found',
          detail: { activityId: id },
        }),
      );
    }
    try {
      this.port.postMessage({ kind: 'intelligence-cancel', activityId: id });
    } catch {
      this.retireTransport();
      return err(new IntelligenceError({ code: 'intelligence-closed', detail: {} }));
    }
    return ok(undefined);
  }

  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask;
    this.state = 'closing';
    this.clearPending();
    this.closeTask = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    try {
      this.port.postMessage({ kind: 'intelligence-close' });
    } catch {
      this.retireTransport();
    }
    return this.closeTask;
  }
}

export function createIntelligencePortClient(
  providerId: string,
  port: IntelligenceMessagePort,
  options: IntelligenceRuntimeOptions = {},
): IntelligencePortClient {
  return new IntelligencePortClient(providerId, port, options);
}

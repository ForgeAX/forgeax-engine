// Private observation-build helper. Normal Engine sources never import this module.
const data = (value, key) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
};
const object = (value) =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

export function createFeaturePlanCensus(request, now = () => performance.now()) {
  if (
    !request ||
    typeof request.windowId !== 'string' ||
    !request.windowId.length ||
    request.windowId.length > 128 ||
    typeof request.featureIdentity !== 'string' ||
    request.featureIdentity.length > 256 ||
    !Number.isSafeInteger(request.frameNumber) ||
    request.frameNumber < 0
  )
    throw new Error('Require an explicit bounded window/feature/Renderer frame selection');
  const selection = Object.freeze({ ...request });
  let active,
    finished,
    consumed = false,
    identities = new WeakMap(),
    nextIdentity = 0;
  const rows = new Map(),
    physicalScopes = new Map(),
    stack = [];
  let scope = 'producer-admission',
    droppedRows = 0,
    identityOverflow = 0,
    unavailableArguments = 0,
    calls = 0,
    droppedCalls = 0;
  const metadata = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 256) return value;
    unavailableArguments++;
    return null;
  };
  const identity = (value) => {
    if (!object(value)) {
      if (typeof value === 'string' && value.length > 256) {
        unavailableArguments++;
        return '?';
      }
      if (['symbol', 'bigint'].includes(typeof value)) {
        unavailableArguments++;
        return '?';
      }
      return `${typeof value}:${String(value)}`;
    }
    let id = identities.get(value);
    if (id === undefined) {
      if (nextIdentity >= 8192) {
        identityOverflow++;
        return '?';
      }
      identities.set(value, (id = ++nextIdentity));
    }
    return `ref:${id}`;
  };
  const increment = (set, value) => {
    if (value === undefined || value.includes('?')) return false;
    const repeated = set.has(value);
    if (set.size < 8192) set.add(value);
    else identityOverflow++;
    return repeated;
  };
  const physical = (row, value) => {
    const id = identity(value),
      key = JSON.stringify([row.operation, id]);
    row.physicalObservations++;
    row.samePhysicalResource += Number(increment(row.physicalSeen, id));
    if (id === '?') return;
    let scopes = physicalScopes.get(key);
    if (!scopes) physicalScopes.set(key, (scopes = new Set()));
    if ([...scopes].some((previous) => previous !== row.scope)) row.samePhysicalOtherScope++;
    scopes.add(row.scope);
  };
  const start = (label, args = []) => {
    if (!active) return undefined;
    if (calls >= 8192) {
      droppedCalls++;
      return undefined;
    }
    calls++;
    const boundaryStart = now();
    const kind = label === 'graphics-store.prepare' ? data(args, '0') : undefined;
    const operation = typeof kind === 'string' ? `${label}/${kind}` : label;
    const key = JSON.stringify([scope, operation]);
    let row = rows.get(key);
    if (!row) {
      if (rows.size >= 128) {
        droppedRows++;
        return undefined;
      }
      row = {
        scope,
        operation,
        calls: 0,
        throws: 0,
        errorResults: 0,
        sameArgumentTuple: 0,
        sameReturnedReference: 0,
        samePhysicalResource: 0,
        physicalObservations: 0,
        physicalUnobservedReturns: 0,
        samePhysicalOtherScope: 0,
        inclusiveWrappedMs: 0,
        exclusiveWrappedMs: 0,
        observerBookkeepingMs: 0,
        argumentsSeen: new Set(),
        referencesSeen: new Set(),
        physicalSeen: new Set(),
      };
      rows.set(key, row);
    }
    row.calls++;
    const tuple = args.length <= 8 ? JSON.stringify(args.map(identity)) : '?';
    if (args.length > 8) unavailableArguments++;
    row.sameArgumentTuple += Number(increment(row.argumentsSeen, tuple));
    if (label === 'upload.writeBuffer' && object(args[0])) physical(row, args[0]);
    const token = {
      row,
      boundaryStart,
      childSpan: 0,
      value: undefined,
      returned: false,
      start: now(),
    };
    stack.push(token);
    return token;
  };
  const returned = (token, value, returnKind = 'opaque') => {
    if (token) {
      token.value = value;
      token.returned = true;
      token.returnKind = returnKind;
    }
    return value;
  };
  const end = (token) => {
    if (!token) return;
    const endTime = now(),
      row = token.row;
    if (stack.pop() !== token) throw new Error('Unbalanced private census operation');
    row.inclusiveWrappedMs += endTime - token.start;
    row.exclusiveWrappedMs += Math.max(0, endTime - token.start - token.childSpan);
    if (token.thrown) row.throws++;
    const result = token.value;
    // Only source-recognized Engine ok()/err() and private resource literals
    // are inspected. Arbitrary returned objects/proxies remain opaque refs.
    const resultStatus = token.returnKind?.startsWith('result-') ? data(result, 'ok') : undefined;
    row.errorResults += Number(resultStatus === false);
    const value = resultStatus === true ? data(result, 'value') : result;
    if (object(value)) {
      row.sameReturnedReference += Number(increment(row.referencesSeen, identity(value)));
      const resource =
        token.returnKind === 'result-physical' && resultStatus === true
          ? value
          : token.returnKind === 'resource' ||
              (token.returnKind === 'result-resource' && resultStatus === true)
            ? (data(value, 'buffer') ?? data(value, 'handle'))
            : undefined;
      if (object(resource)) physical(row, resource);
      else row.physicalUnobservedReturns++;
    }
    const boundaryEnd = now();
    row.observerBookkeepingMs += token.start - token.boundaryStart + boundaryEnd - endTime;
    if (stack.length) stack.at(-1).childSpan += boundaryEnd - token.boundaryStart;
  };
  return {
    isActive: () => active !== undefined,
    begin(input, featureIdentity, frameErrorsAtStart = 0) {
      if (
        consumed ||
        featureIdentity !== selection.featureIdentity ||
        data(input, 'frameNumber') !== selection.frameNumber ||
        (selection.generation !== undefined &&
          data(input, 'generation') !== selection.generation) ||
        (selection.owner !== undefined && data(input, 'owner') !== selection.owner)
      )
        return undefined;
      consumed = true;
      active = {
        windowId: selection.windowId,
        featureIdentity,
        frameNumber: selection.frameNumber,
        generation: metadata(data(input, 'generation')),
        owner: metadata(data(input, 'owner')),
        viewIdentity: metadata(data(input, 'identity')),
        startedAtMs: now(),
        frameErrorsAtStart,
      };
      return active;
    },
    transaction(value) {
      if (active) {
        active.transactionReference = identity(value);
        active.preparedGeneration = metadata(data(value, 'generation'));
      }
    },
    scope(value) {
      if (!active) return;
      const view = data(value, 'view');
      scope =
        typeof value === 'string' && value.length <= 256
          ? value
          : typeof view === 'string' && view.length <= 256
            ? `view:${view}`
            : 'unavailable';
    },
    start,
    returned,
    end,
    thrown(token) {
      if (token) token.thrown = true;
    },
    // This preserves receiver, method lookup-before-arguments, return and throw identity.
    method(receiver, name, category = 'upload') {
      const method = receiver[name];
      if (method === undefined || method === null) return method;
      return (...args) => {
        const token = start(`${category}.${name}`, args);
        try {
          return returned(token, Reflect.apply(method, receiver, args));
        } catch (error) {
          if (token) token.thrown = true;
          throw error;
        } finally {
          end(token);
        }
      };
    },
    lookup(origin, name, value) {
      if (active && value !== undefined) {
        const token = start(`resource-lookup/${origin}`, [name]);
        returned(token, value);
        end(token);
      }
      return value;
    },
    finish(token, errorCount, escapedException = false) {
      if (!token) return;
      finished = Object.freeze({
        diagnosticOnly: true,
        ordinaryFpsAcceptance: false,
        identity: Object.freeze(active),
        status: 'feature-iteration-exited',
        frameErrorsAtExit: errorCount,
        finishedAtMs: now(),
        newFrameErrors: errorCount - active.frameErrorsAtStart,
        escapedException,
        limits: { calls: 8192, rows: 128, identities: 8192, argumentsPerCall: 8 },
        droppedRows,
        droppedCalls,
        identityOverflow,
        unavailableArguments,
        populationStatus:
          droppedRows || droppedCalls || identityOverflow || unavailableArguments
            ? 'partial'
            : 'complete',
        operationRetentionStatus: droppedRows || droppedCalls ? 'partial' : 'complete',
        argumentIdentityStatus: identityOverflow || unavailableArguments ? 'partial' : 'complete',
        rows: Object.freeze(
          [...rows.values()].map(({ argumentsSeen, referencesSeen, physicalSeen, ...row }) =>
            Object.freeze({
              ...row,
              ...(row.operation.startsWith('resource-lookup/')
                ? {
                    timingScope:
                      'successful-origin metadata only; original Map lookup duration is unobserved',
                    inclusiveWrappedMs: null,
                    exclusiveWrappedMs: null,
                  }
                : {
                    timingScope:
                      'actual synchronous wrapped call; observation and any carrier oracle perturb it',
                  }),
            }),
          ),
        ),
        limitations: Object.freeze([
          'One synchronous feature transaction; neither submission nor GPU completion is claimed.',
          'Reference equality is population, not immutability or removable work. New equivalent descriptors are not merged.',
          'Prepared bindings/vertex/index requests are current reads. Inherited lookup hits remain distinct from preparation calls.',
          'Resource-lookup rows count successful origin hits, including inherited lookup layers; misses and original Map lookup durations are unobserved.',
          'Only source-recognized Engine results/private resource literals and writeBuffer argument zero identify physical resources. Other returns remain opaque; physicalUnobservedReturns is not zero cost.',
          'Provider/getter execution and typed byte contents are not inspected; call counts do not prove a provider can be skipped.',
          'Wrapped elapsed time is diagnostic wall time, not thread CPU. Exclusive time excludes nested observed call spans; instrumentation perturbs execution.',
        ]),
      });
      active = undefined;
      identities = new WeakMap();
      rows.clear();
      physicalScopes.clear();
    },
    snapshot: () => finished,
  };
}

let installed;
const inactive = {
  isActive: () => false,
  begin: () => undefined,
  scope() {},
  transaction() {},
  start: () => undefined,
  returned: (_token, value) => value,
  end() {},
  thrown() {},
  finish() {},
};
export function configureFeaturePlanCensus(request) {
  if (installed?.isActive()) throw new Error('Cannot replace an active census');
  installed = createFeaturePlanCensus(request);
  return installed;
}
export const featurePlanCensus = () => installed ?? inactive;

import type { ViewerModel } from '../viewer-model';

export function makeEmptyResourceLifecycle(): ViewerModel['resourceLifecycle'] {
  return {
    scope: 'captured-tape-resource-closure',
    counts: {
      created: 0,
      destroyed: 0,
      live: 0,
      peakLive: 0,
      destroyEvents: 0,
      unknownDestroyEvents: 0,
    },
    bytes: {
      knownCreated: 0,
      knownDestroyed: 0,
      knownLive: 0,
      knownPeak: 0,
      unavailableCreated: 0,
      unavailableDestroyed: 0,
      unavailableLive: 0,
      unavailablePeak: 0,
    },
    originBreakdown: {
      engine: {
        created: 0,
        destroyed: 0,
        live: 0,
        knownCreated: 0,
        knownDestroyed: 0,
        knownLive: 0,
        unavailableCreated: 0,
        unavailableDestroyed: 0,
        unavailableLive: 0,
      },
      swapchain: {
        created: 0,
        destroyed: 0,
        live: 0,
        knownCreated: 0,
        knownDestroyed: 0,
        knownLive: 0,
        unavailableCreated: 0,
        unavailableDestroyed: 0,
        unavailableLive: 0,
      },
    },
    availability: {
      destroy: 'observed-buffer-texture',
      retire: 'unavailable',
      driverAllocation: 'unavailable',
    },
    resources: [],
  };
}

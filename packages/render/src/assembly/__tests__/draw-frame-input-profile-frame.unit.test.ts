import { describe, expect, it } from 'vitest';
import type { DrawOptions, RenderFrameInput } from '../../render-contract';
import { captureDrawOwnerProfileFrame, frameDrawOptions } from '../draw-frame-input';

describe('legacy draw profile token capture', () => {
  it('reads an own accessor once and does not inspect another option getter', () => {
    let tokenReads = 0;
    let ownerReads = 0;
    const token = { captureId: 'capture-0001', frameId: 7 };
    const options = {
      get profileFrame() {
        tokenReads += 1;
        return token;
      },
      get cameraOwner() {
        ownerReads += 1;
        return 3;
      },
    } as DrawOptions;

    expect(captureDrawOwnerProfileFrame(options)).toEqual(token);
    expect(tokenReads).toBe(1);
    expect(ownerReads).toBe(0);
  });

  it('preserves the receiver for an inherited private-brand accessor', () => {
    class BrandedOptions {
      #token = { captureId: 'capture-0002', frameId: 8 };
      reads = 0;

      get profileFrame() {
        this.reads += 1;
        return this.#token;
      }

      cameraOwner = 0;
      resourceOwner = 0;
    }
    const options = new BrandedOptions();

    expect(captureDrawOwnerProfileFrame(options as DrawOptions)).toEqual({
      captureId: 'capture-0002',
      frameId: 8,
    });
    expect(options.reads).toBe(1);
  });

  it('reads an undefined token only once', () => {
    let tokenReads = 0;
    const options = Object.create({
      get profileFrame() {
        tokenReads += 1;
        return undefined;
      },
    }) as DrawOptions;

    expect(captureDrawOwnerProfileFrame(options)).toBeUndefined();
    expect(tokenReads).toBe(1);
  });

  it('reads the frame request token once while deriving owner options', () => {
    let tokenReads = 0;
    const token = { captureId: 'capture-0003', frameId: 9 };
    const request = {
      source: null,
      camera: null,
      get profileFrame() {
        tokenReads += 1;
        return token;
      },
    } as unknown as RenderFrameInput;

    expect(frameDrawOptions(request)).toMatchObject({ profileFrame: token });
    expect(tokenReads).toBe(1);
  });

  it('preserves option getter order and detaches token fields before later getters run', () => {
    const order: string[] = [];
    const values = { captureId: 'capture-0004', frameId: 10 };
    const fieldReads = { captureId: 0, frameId: 0 };
    const token = {
      get captureId() {
        order.push('captureId');
        fieldReads.captureId += 1;
        return values.captureId;
      },
      get frameId() {
        order.push('frameId');
        fieldReads.frameId += 1;
        return values.frameId;
      },
    };
    let profileFrameReads = 0;
    const lease = {};
    const cameraBinding = {
      get lease() {
        order.push('camera.lease');
        return lease;
      },
      get entityKey() {
        order.push('camera.entityKey');
        return 4;
      },
    };
    const environmentBinding = {
      get lease() {
        order.push('environment.lease');
        return lease;
      },
    };
    const request = {
      get leases() {
        order.push('leases');
        return [lease];
      },
      get camera() {
        order.push('camera');
        return cameraBinding;
      },
      get environment() {
        order.push('environment');
        return environmentBinding;
      },
      get sampleTimeSeconds() {
        order.push('sampleTimeSeconds');
        return 1;
      },
      get temporalReset() {
        order.push('temporalReset');
        return false;
      },
      get profileFrame() {
        order.push('profileFrame');
        profileFrameReads += 1;
        return token;
      },
      get geometryObservation() {
        order.push('geometryObservation');
        values.captureId = 'capture-9999';
        values.frameId = 999;
        return false;
      },
      get geometryLane() {
        order.push('geometryLane');
        return undefined;
      },
    } as unknown as RenderFrameInput;

    const options = frameDrawOptions(request);

    expect(order).toEqual([
      'camera',
      'camera.entityKey',
      'camera',
      'camera.entityKey',
      'sampleTimeSeconds',
      'sampleTimeSeconds',
      'temporalReset',
      'profileFrame',
      'captureId',
      'frameId',
      'geometryObservation',
      'geometryLane',
    ]);
    expect(profileFrameReads).toBe(1);
    expect(fieldReads).toEqual({ captureId: 1, frameId: 1 });
    expect(options.profileFrame).toEqual({ captureId: 'capture-0004', frameId: 10 });
    expect(options.profileFrame).not.toBe(token);
    expect(Object.isFrozen(options.profileFrame)).toBe(true);
  });
});

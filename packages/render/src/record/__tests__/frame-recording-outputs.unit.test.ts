import type { TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { FrameObservationSource } from '../frame-snapshot';
import { emptyFrameRecordingOutputs, resetFrameRecordingOutputs } from '../frame-snapshot';

describe('frame recording outputs', () => {
  it('clears shadow views and observation source together without replacing the record', () => {
    const outputs = emptyFrameRecordingOutputs();
    expect(outputs).toEqual({
      sceneSubmitted: false,
      directionalShadowView: null,
      spotShadowView: null,
      observationSource: undefined,
    });
    outputs.sceneSubmitted = true;
    outputs.directionalShadowView = {} as TextureView;
    outputs.spotShadowView = {} as TextureView;
    outputs.observationSource = {} as FrameObservationSource;

    resetFrameRecordingOutputs(outputs);

    expect(outputs).toEqual(emptyFrameRecordingOutputs());
  });
});

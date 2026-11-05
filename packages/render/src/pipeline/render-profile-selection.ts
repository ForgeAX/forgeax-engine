import type { RhiDevice } from '@forgeax/engine-rhi';
import { validateRenderProfile } from '../assembly/renderer-facade';
import type { RenderProfile } from '../render-contract';
import { supportsStandardDeferred } from './standard-deferred-capability';
import type { StandardProfile } from './standard-profile';

/** Resolve author intent against the admitted device, independently of cameras
 * and effects. The same selection survives view changes; a recovered device
 * invalidates only this constant-sized derived value. */
export function createRenderProfileSelection() {
  let previous: RenderProfile | undefined;
  let previousDevice: Pick<RhiDevice, 'caps' | 'limits'> | undefined;
  let selected: StandardProfile | undefined;
  const select = (
    profile: RenderProfile,
    device: Pick<RhiDevice, 'caps' | 'limits'>,
  ): StandardProfile => {
    if (selected !== undefined && previous === profile && previousDevice === device)
      return selected;
    previous = profile;
    previousDevice = device;
    const { caps, limits } = device;
    if (profile.renderPath !== 'auto') selected = profile as StandardProfile;
    else {
      const deferred = supportsStandardDeferred(caps, limits.maxColorAttachmentBytesPerSample);
      selected = Object.freeze({ ...profile, renderPath: deferred ? 'deferred' : 'forward' });
    }
    return selected;
  };
  return {
    select,
    validate(profile: RenderProfile, device: Pick<RhiDevice, 'caps' | 'limits'>) {
      return validateRenderProfile(profile) ?? validateRenderProfile(select(profile, device));
    },
  };
}

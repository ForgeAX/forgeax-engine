import { ResourceInvalidValueError } from '../errors/ecs-validation';

/** All 32 independent surface direct-light channels; zero matches no lights. */
export const LIGHTING_CHANNELS_DEFAULT = 0xffffffff;

/** Validate before projecting the author number into a GPU u32. */
export function validateLightingChannels(value: number): ResourceInvalidValueError | null {
  if (Number.isInteger(value) && value >= 0 && value <= LIGHTING_CHANNELS_DEFAULT) return null;
  return new ResourceInvalidValueError(
    'lightingChannels is an integer in [0, 0xffffffff]',
    'assign an unsigned 32-bit mask; use 0x80000000 for bit 31, not the signed result of 1 << 31',
    { receivedKey: 'lightingChannels', receivedMode: value },
  );
}

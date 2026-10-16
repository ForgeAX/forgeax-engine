// The camera must sit strictly inside the tunnel: a wall vertex on the eye
// plane (clip w = 0) splits each wall into two differently lit triangles on
// Mali WebGL2.
import { describe, expect, it } from 'vitest';
import {
  CAMERA_NEAR,
  CAMERA_POS_Z,
  TUNNEL_ENTRANCE_Z,
  TUNNEL_FAR_Z,
  TUNNEL_POS_Z,
  TUNNEL_SCALE_Z,
} from '../tunnel-layout';

describe('HDR tunnel layout', () => {
  it('places the entrance behind the camera, clear of the near plane', () => {
    expect(TUNNEL_ENTRANCE_Z - CAMERA_POS_Z).toBeGreaterThan(CAMERA_NEAR);
  });

  it('keeps the far end in front of the camera', () => {
    expect(TUNNEL_FAR_Z).toBeLessThan(CAMERA_POS_Z);
  });

  it('derives the unit-box transform from both ends', () => {
    expect(TUNNEL_POS_Z + TUNNEL_SCALE_Z / 2).toBe(TUNNEL_ENTRANCE_Z);
    expect(TUNNEL_POS_Z - TUNNEL_SCALE_Z / 2).toBe(TUNNEL_FAR_Z);
  });
});

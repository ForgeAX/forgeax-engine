import { describe, expect, it } from 'vitest';
import { deriveOfficialScenePose } from '../scene-pose';

describe('official volumetric lighting scene pose', () => {
  it('matches the pinned Three.js pose at captureTime zero', () => {
    expect(deriveOfficialScenePose(0)).toEqual({
      pointPosition: [0, 2.4, 2.4],
      spotPosition: [2.4, 5, 2.5],
      spotDirection: [-2.4, -5, -2.5],
      teapotRotationY: 0,
    });
  });

  it('uses the same trigonometric mapping for a non-zero frozen time', () => {
    const time = 1.25;
    const pose = deriveOfficialScenePose(time);
    expect(pose.pointPosition[0]).toBeCloseTo(Math.sin(time * 0.7) * 2.4);
    expect(pose.pointPosition[1]).toBeCloseTo(Math.cos(time * 0.5) * 2.4);
    expect(pose.pointPosition[2]).toBeCloseTo(Math.cos(time * 0.3) * 2.4);
    expect(pose.spotPosition[0]).toBeCloseTo(Math.cos(time * 0.3) * 2.4);
    expect(pose.spotPosition[1]).toBe(5);
    expect(pose.spotPosition[2]).toBe(2.5);
    expect(pose.spotDirection).toEqual([
      -pose.spotPosition[0],
      -pose.spotPosition[1],
      -pose.spotPosition[2],
    ]);
    expect(pose.teapotRotationY).toBeCloseTo(time * 0.2);
  });

  it('keeps the authored spot height and depth while animating its X axis', () => {
    const pose = deriveOfficialScenePose(Math.PI / 0.3);
    expect(pose.spotPosition).toEqual([-2.4, 5, 2.5]);
    expect(pose.spotDirection).toEqual([2.4, -5, -2.5]);
  });
});

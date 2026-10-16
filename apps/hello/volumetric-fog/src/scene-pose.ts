export interface OfficialScenePose {
  readonly pointPosition: [number, number, number];
  readonly spotPosition: [number, number, number];
  readonly spotDirection: [number, number, number];
  readonly teapotRotationY: number;
}

/**
 * Project the pinned Three.js animation at a deterministic capture time.
 * Three updates only the spot X coordinate; its authored Y/Z remain 5/2.5.
 */
export function deriveOfficialScenePose(time: number): OfficialScenePose {
  const scale = 2.4;
  const spotX = Math.cos(time * 0.3) * scale;
  const spotY = 5;
  const spotZ = 2.5;
  return {
    pointPosition: [
      Math.sin(time * 0.7) * scale,
      Math.cos(time * 0.5) * scale,
      Math.cos(time * 0.3) * scale,
    ],
    spotPosition: [spotX, spotY, spotZ],
    spotDirection: [-spotX, -spotY, -spotZ],
    teapotRotationY: time * 0.2,
  };
}

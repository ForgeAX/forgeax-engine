export const MESH_IO_LOGICAL_FRAMES = 60;

/** CI samples the same two-second trajectory and exact final pose at lower fill cost. */
export function meshIoFrameIndices(lightweight: boolean): number[] {
  const frames = Array.from({ length: MESH_IO_LOGICAL_FRAMES }, (_, index) => index);
  return lightweight
    ? frames.filter((index) => index % 4 === 0 || index === MESH_IO_LOGICAL_FRAMES - 1)
    : frames;
}

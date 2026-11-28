import { POOL_SIM_SIZE } from './identity';

/** One bounded height/velocity authority, shared by the surface and optical pass. */
export class PoolRipples {
  readonly size: number;
  readonly bytes: Uint8Array;
  readonly height: Float32Array;
  private readonly velocity: Float32Array;
  private readonly next: Float32Array;
  revision = 0;

  constructor(size = POOL_SIM_SIZE) {
    this.size = size;
    this.height = new Float32Array(size * size);
    this.velocity = new Float32Array(size * size);
    this.next = new Float32Array(size * size);
    this.bytes = new Uint8Array(this.height.buffer);
  }

  reset() {
    this.height.fill(0);
    this.velocity.fill(0);
    this.next.fill(0);
    this.revision++;
  }

  disturb(x: number, z: number, radius = 0.06, strength = 0.01) {
    const size = this.size;
    const minX = Math.max(0, Math.floor(((x - radius + 1) * size) / 2));
    const maxX = Math.min(size - 1, Math.ceil(((x + radius + 1) * size) / 2));
    const minZ = Math.max(0, Math.floor(((z - radius + 1) * size) / 2));
    const maxZ = Math.min(size - 1, Math.ceil(((z + radius + 1) * size) / 2));
    for (let j = minZ; j <= maxZ; j++) {
      for (let i = minX; i <= maxX; i++) {
        const distance = Math.hypot(((i + 0.5) * 2) / size - 1 - x, ((j + 0.5) * 2) / size - 1 - z);
        if (distance >= radius) continue;
        const index = j * size + i;
        this.height[index] =
          (this.height[index] ?? 0) +
          strength * (1 + Math.cos((distance / radius) * Math.PI)) * 0.5;
      }
    }
    this.revision++;
  }

  /** Fixed 120 Hz, reflecting pool edges; damped finite-difference wave equation. */
  step() {
    const size = this.size;
    const h = this.height;
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const i = z * size + x;
        const center = h[i] ?? 0;
        const left = h[z * size + Math.max(0, x - 1)] ?? 0;
        const right = h[z * size + Math.min(size - 1, x + 1)] ?? 0;
        const back = h[Math.max(0, z - 1) * size + x] ?? 0;
        const front = h[Math.min(size - 1, z + 1) * size + x] ?? 0;
        const v =
          ((this.velocity[i] ?? 0) + (left + right + back + front - 4 * center) * 0.5) * 0.995;
        this.velocity[i] = v;
        this.next[i] = Math.max(-0.2, Math.min(0.2, center + v));
      }
    }
    h.set(this.next);
    this.revision++;
  }
}

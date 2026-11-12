/** Resource controls start between recordings, after only the draws preceding them.
 * Their asynchronous completion must not block the draws that prepare their PSOs. */
export class RenderWorkerControlBoundary {
  private admitted = 0;
  private recorded = 0;
  private readonly waiting: { through: number; start(): void }[] = [];

  get cut(): number {
    return this.admitted;
  }

  admitDraw(): void {
    this.admitted++;
  }

  recordedDraw(): void {
    this.recorded++;
    for (let index = 0; index < this.waiting.length; ) {
      const control = this.waiting[index];
      if (control === undefined) break;
      if (control.through > this.recorded) {
        index++;
        continue;
      }
      this.waiting.splice(index, 1);
      control.start();
    }
  }

  after(through: number, action: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = () => {
        try {
          resolve(action());
        } catch (cause) {
          reject(cause);
        }
      };
      if (through <= this.recorded) start();
      else this.waiting.push({ through, start });
    });
  }
}

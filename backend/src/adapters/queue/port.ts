/** Delivery only. The durable work record is the JOB# item; the sweep re-sends anything a lost message dropped. */
export interface Queue { send(jobId: string): Promise<void> }

export class MemoryQueue implements Queue {
  readonly pending: string[] = [];
  async send(jobId: string) { if (!this.pending.includes(jobId)) this.pending.push(jobId); }
  take(): string | undefined { return this.pending.shift(); }
}

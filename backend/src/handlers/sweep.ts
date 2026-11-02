// Sweep Lambda (EventBridge rate(1 minute)). Emits UnknownEffectsOlderThan15m as an EMF metric.
import { sweep } from '../jobs/sweep.ts';
import { now, queue, store } from './runtime.ts';

export const handler = async () => {
  const r = await sweep({ store, queue, now });
  console.log(JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'Headroom/dev', Dimensions: [[]], Metrics: [{ Name: 'UnknownEffectsOlderThan15m', Unit: 'Count' }] }] }, UnknownEffectsOlderThan15m: r.unknownOlderThan15m }));
  return r;
};

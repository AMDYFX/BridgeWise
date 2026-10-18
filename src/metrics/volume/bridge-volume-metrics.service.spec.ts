/**
 * File: src/metrics/volume/bridge-volume-metrics.service.spec.ts
 *
 * Unit tests for bridge volume metrics.
 */

import { BridgeVolumeMetrics } from './bridge-volume-metrics.service';
import type { BridgeVolumeEvent } from './bridge-volume-metrics.types';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function makeEvent(partial: Partial<BridgeVolumeEvent> = {}): BridgeVolumeEvent {
  return {
    bridge: 'allbridge',
    asset: 'USDC',
    amount: '100',
    sourceChain: 'ethereum',
    destinationChain: 'stellar',
    success: true,
    timestamp: T0,
    ...partial,
  };
}

describe('BridgeVolumeMetrics', () => {
  let clock = T0;
  const make = (config = {}) => new BridgeVolumeMetrics({ now: () => clock, ...config });

  beforeEach(() => {
    clock = T0;
  });

  it('returns zeroed metrics when nothing has been recorded', () => {
    const metrics = make().getMetrics();

    expect(metrics).toMatchObject({
      count: 0,
      totalVolume: '0',
      successRate: null,
      averageSize: '0',
      largestTransfer: '0',
    });
  });

  it('aggregates volume, success rate, average and largest transfer', () => {
    const service = make();
    service.record(makeEvent({ amount: '100.5' }));
    service.record(makeEvent({ amount: '200' }));
    service.record(makeEvent({ amount: '699.5', success: false }));

    expect(service.getMetrics()).toMatchObject({
      count: 3,
      successCount: 2,
      failureCount: 1,
      totalVolume: '1000',
      successfulVolume: '300.5',
      failedVolume: '699.5',
      averageSize: '333.33333333',
      largestTransfer: '699.5',
    });
    expect(service.getMetrics().successRate).toBeCloseTo(2 / 3);
  });

  it('sums large and fractional amounts without floating-point drift', () => {
    const service = make();
    service.record(makeEvent({ amount: '0.1' }));
    service.record(makeEvent({ amount: '0.2' }));
    service.record(makeEvent({ amount: '123456789012345678.000000001' }));

    expect(service.getMetrics().totalVolume).toBe('123456789012345678.300000001');
  });

  it('filters by bridge, asset and chain case-insensitively', () => {
    const service = make();
    service.record(makeEvent({ bridge: 'allbridge', amount: '10' }));
    service.record(makeEvent({ bridge: 'squid', amount: '20' }));
    service.record(makeEvent({ asset: 'XLM', amount: '30' }));
    service.record(makeEvent({ destinationChain: 'solana', amount: '40' }));

    expect(service.getMetrics({ bridge: 'SQUID' }).totalVolume).toBe('20');
    expect(service.getMetrics({ asset: 'xlm' }).totalVolume).toBe('30');
    expect(service.getMetrics({ destinationChain: 'Solana' }).totalVolume).toBe('40');
    expect(service.getMetrics({ bridge: 'unknown' }).count).toBe(0);
  });

  it('treats `from` as inclusive and `to` as exclusive (boundary)', () => {
    const service = make();
    service.record(makeEvent({ amount: '1', timestamp: T0 - 2000 }));
    service.record(makeEvent({ amount: '2', timestamp: T0 - 1000 }));
    service.record(makeEvent({ amount: '4', timestamp: T0 }));

    expect(service.getMetrics({ from: T0 - 1000, to: T0 }).totalVolume).toBe('2');
    expect(service.getMetrics({ from: T0 - 1000, to: T0 + 1 }).totalVolume).toBe('6');
  });

  it('breaks volume down by bridge, asset and route, largest first', () => {
    const service = make();
    service.record(makeEvent({ bridge: 'allbridge', amount: '100' }));
    service.record(makeEvent({ bridge: 'squid', amount: '300' }));
    service.record(makeEvent({ bridge: 'squid', asset: 'XLM', amount: '50', destinationChain: 'solana' }));

    expect(service.getBreakdown('bridge').map((e) => [e.key, e.metrics.totalVolume])).toEqual([
      ['SQUID', '350'],
      ['ALLBRIDGE', '100'],
    ]);
    expect(service.getBreakdown('asset').map((e) => e.key)).toEqual(['USDC', 'XLM']);
    expect(service.getBreakdown('route').map((e) => e.key)).toEqual([
      'ETHEREUM->STELLAR',
      'ETHEREUM->SOLANA',
    ]);
  });

  it('builds a continuous time series including empty buckets', () => {
    const service = make();
    service.record(makeEvent({ amount: '10', timestamp: T0 - 3 * HOUR + 1 }));
    service.record(makeEvent({ amount: '20', timestamp: T0 - 1 * HOUR }));

    const series = service.getTimeSeries(HOUR, { from: T0 - 3 * HOUR, to: T0 });

    expect(series).toHaveLength(3);
    expect(series.map((b) => b.metrics.totalVolume)).toEqual(['10', '0', '20']);
    expect(series[0].start).toBe(T0 - 3 * HOUR);
    expect(series[2].end).toBe(T0);
  });

  it('rejects malformed events and counts them instead of recording', () => {
    const service = make();

    expect(service.record(makeEvent({ amount: 'abc' }))).toEqual({
      recorded: false,
      reason: 'INVALID_AMOUNT',
    });
    expect(service.record(makeEvent({ amount: '-5' })).reason).toBe('INVALID_AMOUNT');
    expect(service.record(makeEvent({ bridge: '  ' })).reason).toBe('INVALID_IDENTIFIER');
    expect(service.record(makeEvent({ timestamp: Number.NaN })).reason).toBe('INVALID_TIMESTAMP');
    expect(service.record(makeEvent({ timestamp: T0 + HOUR })).reason).toBe('FUTURE_TIMESTAMP');

    expect(service.getMetrics().count).toBe(0);
    expect(service.getStats().rejectedEvents).toBe(5);
  });

  it('tolerates small clock skew but not large (boundary)', () => {
    const service = make({ maxFutureSkewMs: 1000 });

    expect(service.record(makeEvent({ timestamp: T0 + 1000 })).recorded).toBe(true);
    expect(service.record(makeEvent({ timestamp: T0 + 1001 })).reason).toBe('FUTURE_TIMESTAMP');
  });

  it('expires events older than the retention window', () => {
    const service = make({ retentionMs: HOUR });
    service.record(makeEvent({ amount: '10' }));

    clock = T0 + HOUR - 1;
    expect(service.getMetrics().count).toBe(1);

    clock = T0 + HOUR; // event is now exactly retentionMs old → evicted
    expect(service.getMetrics().count).toBe(0);
    expect(service.getStats().evictedEvents).toBe(1);
  });

  it('caps memory by evicting the oldest events past maxEvents', () => {
    const service = make({ maxEvents: 2 });
    service.record(makeEvent({ amount: '1', timestamp: T0 - 3000 }));
    service.record(makeEvent({ amount: '2', timestamp: T0 - 2000 }));
    service.record(makeEvent({ amount: '4', timestamp: T0 - 1000 }));

    expect(service.getStats()).toMatchObject({ retainedEvents: 2, evictedEvents: 1 });
    expect(service.getMetrics().totalVolume).toBe('6');
  });

  it('throws on an invalid time series request', () => {
    const service = make();

    expect(() => service.getTimeSeries(0)).toThrow(RangeError);
    expect(() => service.getTimeSeries(HOUR, { from: T0, to: T0 })).toThrow(RangeError);
    expect(() => service.getTimeSeries(1, { from: 0, to: T0 })).toThrow(RangeError);
  });

  it('supports an end-to-end flow: record → breakdown → series → reset', () => {
    const service = make();
    const flows: Array<[string, string, string, boolean, number]> = [
      ['allbridge', 'USDC', '500', true, T0 - 2 * HOUR],
      ['allbridge', 'USDC', '250', false, T0 - 2 * HOUR + 10],
      ['squid', 'USDC', '1000', true, T0 - HOUR],
    ];
    for (const [bridge, asset, amount, success, timestamp] of flows) {
      service.record(makeEvent({ bridge, asset, amount, success, timestamp }));
    }

    const [top] = service.getBreakdown('bridge', { asset: 'usdc' });
    expect(top.key).toBe('SQUID');
    expect(top.metrics.successRate).toBe(1);

    const allbridge = service.getMetrics({ bridge: 'allbridge' });
    expect(allbridge.successRate).toBeCloseTo(0.5);
    expect(allbridge.failedVolume).toBe('250');

    const series = service.getTimeSeries(HOUR, { from: T0 - 2 * HOUR, to: T0 });
    expect(series.map((b) => b.metrics.count)).toEqual([2, 1]);

    service.reset();
    expect(service.getStats()).toEqual({ retainedEvents: 0, rejectedEvents: 0, evictedEvents: 0 });
  });
});

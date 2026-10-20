export interface Route {
  fromChain: string;
  toChain: string;
  asset: string;
}

export interface RouteUtilization {
  route: Route;
  /** Reserved / total of the destination pool, in basis points (0-10000). */
  utilizationBps: number;
  reserved: bigint;
  total: bigint;
  samples: number;
}

const routeKey = (r: Route) => `${r.fromChain}->${r.toChain}:${r.asset}`;

/** Records the destination-pool liquidity seen by each route and exposes utilization per route. */
export class RouteLiquidityMetrics {
  private readonly latest = new Map<string, RouteUtilization>();

  record(route: Route, reserved: bigint, total: bigint): RouteUtilization {
    if (total < 0n || reserved < 0n) throw new Error('amounts must not be negative');
    const key = routeKey(route);
    const bps = total === 0n ? 10_000 : Number(((reserved > total ? total : reserved) * 10_000n) / total);
    const entry: RouteUtilization = {
      route,
      utilizationBps: bps,
      reserved,
      total,
      samples: (this.latest.get(key)?.samples ?? 0) + 1,
    };
    this.latest.set(key, entry);
    return entry;
  }

  get(route: Route): RouteUtilization | undefined {
    return this.latest.get(routeKey(route));
  }

  /** Routes at or above `thresholdBps`, most utilized first. */
  hot(thresholdBps: number): RouteUtilization[] {
    return [...this.latest.values()]
      .filter((u) => u.utilizationBps >= thresholdBps)
      .sort((a, b) => b.utilizationBps - a.utilizationBps);
  }

  /** Prometheus-style lines: bridgewise_route_liquidity_utilization_bps{from,to,asset} N */
  toPrometheus(): string {
    return [...this.latest.values()]
      .map(
        (u) =>
          `bridgewise_route_liquidity_utilization_bps{from="${u.route.fromChain}",to="${u.route.toChain}",asset="${u.route.asset}"} ${u.utilizationBps}`,
      )
      .join('\n');
  }
}

export type CancellableState = 'created' | 'quoted' | 'reserved';

const CANCELLABLE: ReadonlySet<string> = new Set<CancellableState>(['created', 'quoted', 'reserved']);

export interface CancellableExecution {
  id: string;
  state: string;
  reservationId?: string;
}

export type CancellationResult =
  | { cancelled: true; alreadyCancelled: boolean; releasedReservation: boolean }
  | { cancelled: false; reason: 'irreversible' | 'terminal' | 'not_found' };

/**
 * Cancels an execution only while nothing irreversible has happened. Once a transaction is submitted
 * (or the execution is terminal) cancellation is refused. Cancelling twice is a no-op, and the held
 * liquidity reservation is released exactly once.
 */
export class ExecutionCancellation {
  constructor(
    private readonly load: (id: string) => CancellableExecution | undefined,
    private readonly save: (execution: CancellableExecution) => void,
    private readonly releaseReservation: (reservationId: string) => void,
  ) {}

  cancel(id: string): CancellationResult {
    const execution = this.load(id);
    if (!execution) return { cancelled: false, reason: 'not_found' };
    if (execution.state === 'cancelled') {
      return { cancelled: true, alreadyCancelled: true, releasedReservation: false };
    }
    if (execution.state === 'submitted') return { cancelled: false, reason: 'irreversible' };
    if (!CANCELLABLE.has(execution.state)) return { cancelled: false, reason: 'terminal' };

    let releasedReservation = false;
    if (execution.reservationId) {
      this.releaseReservation(execution.reservationId);
      releasedReservation = true;
    }
    this.save({ ...execution, state: 'cancelled', reservationId: undefined });
    return { cancelled: true, alreadyCancelled: false, releasedReservation };
  }
}

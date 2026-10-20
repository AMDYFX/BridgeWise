import { filterSubscribers, matchesEventFilter } from './webhook-event-filter';

describe('matchesEventFilter', () => {
  it('empty list matches any event (catch-all)', () => {
    expect(matchesEventFilter([], 'transaction.completed')).toBe(true);
    expect(matchesEventFilter([], 'gas.spike')).toBe(true);
  });

  it('exact match', () => {
    expect(matchesEventFilter(['transaction.completed'], 'transaction.completed')).toBe(true);
    expect(matchesEventFilter(['transaction.completed'], 'transaction.failed')).toBe(false);
  });

  it('wildcard "transaction.*" matches events with that prefix', () => {
    expect(matchesEventFilter(['transaction.*'], 'transaction.completed')).toBe(true);
    expect(matchesEventFilter(['transaction.*'], 'transaction.failed')).toBe(true);
    expect(matchesEventFilter(['transaction.*'], 'transaction')).toBe(true);
    expect(matchesEventFilter(['transaction.*'], 'gas.spike')).toBe(false);
  });

  it('"*" matches everything', () => {
    expect(matchesEventFilter(['*'], 'anything')).toBe(true);
  });

  it('multiple patterns — any match is sufficient', () => {
    expect(matchesEventFilter(['gas.spike', 'transaction.*'], 'transaction.completed')).toBe(true);
    expect(matchesEventFilter(['gas.spike', 'transaction.*'], 'gas.spike')).toBe(true);
    expect(matchesEventFilter(['gas.spike', 'transaction.*'], 'user.created')).toBe(false);
  });
});

describe('filterSubscribers', () => {
  const make = (events: string[], isActive = true) => ({ events, isActive });

  it('returns only active subscribers matching the event', () => {
    const hooks = [
      make(['transaction.*']),
      make(['gas.spike']),
      make(['transaction.*'], false), // inactive — excluded
      make([]),                        // catch-all
    ];

    const result = filterSubscribers(hooks, 'transaction.completed');
    expect(result).toHaveLength(2); // transaction.* active + catch-all
  });

  it('excludes inactive webhooks even if they match', () => {
    const hooks = [make(['*'], false)];
    expect(filterSubscribers(hooks, 'anything')).toHaveLength(0);
  });
});

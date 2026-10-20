/**
 * Webhook event filtering.
 *
 * A webhook with an empty `events` array is a catch-all — it receives every event.
 * A webhook with a non-empty `events` array only receives listed events.
 * Wildcards are also supported: "transaction.*" matches "transaction.completed", etc.
 */

/**
 * Returns true if a webhook subscribed to `subscribedEvents` should receive `event`.
 *
 * @param subscribedEvents  The webhook's event filter list (empty = all events).
 * @param event             The event being dispatched.
 */
export function matchesEventFilter(
  subscribedEvents: string[],
  event: string,
): boolean {
  // Empty list = catch-all
  if (!subscribedEvents.length) return true;

  return subscribedEvents.some((pattern) => matchesPattern(pattern, event));
}

/**
 * Simple wildcard matching:
 *   "transaction.*"  → matches any event starting with "transaction."
 *   "*"              → matches everything
 *   exact string     → exact match only
 */
function matchesPattern(pattern: string, event: string): boolean {
  if (pattern === '*') return true;
  if (pattern === event) return true;

  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2); // strip ".*"
    return event === prefix || event.startsWith(`${prefix}.`);
  }

  return false;
}

/**
 * Filters a list of webhooks to those that should receive the given event.
 * Keeps webhooks whose `isActive` is true (caller should pre-filter, but
 * this acts as a safety net).
 */
export function filterSubscribers<T extends { events: string[]; isActive: boolean }>(
  webhooks: T[],
  event: string,
): T[] {
  return webhooks.filter(
    (w) => w.isActive && matchesEventFilter(w.events, event),
  );
}

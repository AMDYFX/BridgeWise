export interface RequestLimits {
  maxBytes: number;
  maxDepth: number;
  maxArrayLength: number;
  maxKeysPerObject: number;
  maxStringLength: number;
}

export const DEFAULT_REQUEST_LIMITS: RequestLimits = {
  maxBytes: 256 * 1024,
  maxDepth: 10,
  maxArrayLength: 1_000,
  maxKeysPerObject: 200,
  maxStringLength: 64 * 1024,
};

export class RequestLimitError extends Error {
  constructor(
    readonly limit: keyof RequestLimits,
    readonly path: string,
  ) {
    super(`request exceeds ${limit} at ${path}`);
    this.name = 'RequestLimitError';
  }
}

/**
 * Walks a parsed JSON body iteratively (no recursion, so hostile nesting cannot overflow the stack) and
 * throws RequestLimitError naming the first limit broken and where.
 */
export function assertWithinRequestLimits(
  body: unknown,
  limits: RequestLimits = DEFAULT_REQUEST_LIMITS,
  rawBytes?: number,
): void {
  if (rawBytes !== undefined && rawBytes > limits.maxBytes) throw new RequestLimitError('maxBytes', '$');

  const stack: Array<{ value: unknown; depth: number; path: string }> = [{ value: body, depth: 1, path: '$' }];
  const seen = new WeakSet<object>();

  while (stack.length > 0) {
    const { value, depth, path } = stack.pop() as { value: unknown; depth: number; path: string };
    if (typeof value === 'string') {
      if (value.length > limits.maxStringLength) throw new RequestLimitError('maxStringLength', path);
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    if (depth > limits.maxDepth) throw new RequestLimitError('maxDepth', path);
    if (seen.has(value)) throw new RequestLimitError('maxDepth', path); // cycle
    seen.add(value);

    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayLength) throw new RequestLimitError('maxArrayLength', path);
      value.forEach((item, i) => stack.push({ value: item, depth: depth + 1, path: `${path}[${i}]` }));
    } else {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > limits.maxKeysPerObject) throw new RequestLimitError('maxKeysPerObject', path);
      for (const [key, item] of entries) stack.push({ value: item, depth: depth + 1, path: `${path}.${key}` });
    }
  }
}

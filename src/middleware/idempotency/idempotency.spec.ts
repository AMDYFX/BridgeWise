import { IdempotencyMiddleware, IdempotencyRequest, IdempotencyResponse } from './idempotency.middleware';
import { IdempotencyStorage } from './idempotency.storage';

describe('IdempotencyMiddleware', () => {
  let storage: IdempotencyStorage;
  let middleware: IdempotencyMiddleware;

  beforeEach(() => {
    storage = new IdempotencyStorage();
    middleware = new IdempotencyMiddleware(storage, {
      ttlMs: 60000,
      maxKeyLength: 64,
    });
  });

  const createMockResponse = () => {
    const headers: Record<string, string> = {};
    const res: IdempotencyResponse = {
      statusCode: 200,
      setHeader: jest.fn((k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      }),
      status: jest.fn(function (this: IdempotencyResponse, code: number) {
        this.statusCode = code;
        return this;
      }),
      json: jest.fn(),
      getHeaders: jest.fn(() => ({ ...headers })),
    };
    return { res, headers };
  };

  it('should ignore non-mutating requests (e.g. GET)', () => {
    const req: IdempotencyRequest = {
      method: 'GET',
      path: '/bridges',
      headers: { 'idempotency-key': 'test-key-1' },
    };
    const { res } = createMockResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(storage.get('test-key-1')).toBeUndefined();
  });

  it('should proceed normally without header on POST request', () => {
    const req: IdempotencyRequest = {
      method: 'POST',
      path: '/bridges/execute',
      headers: {},
      body: { amount: 100 },
    };
    const { res } = createMockResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('should return 400 when idempotency key exceeds max length', () => {
    const req: IdempotencyRequest = {
      method: 'POST',
      path: '/bridges/execute',
      headers: { 'idempotency-key': 'a'.repeat(65) },
      body: { amount: 100 },
    };
    const { res } = createMockResponse();
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        error: 'Bad Request',
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should record pending status on first execution and cache completed response', () => {
    const req: IdempotencyRequest = {
      method: 'POST',
      path: '/bridges/execute',
      headers: { 'idempotency-key': 'key-123' },
      body: { amount: 100 },
    };
    const { res, headers } = createMockResponse();
    let nextCalled = false;
    const next = jest.fn(() => {
      nextCalled = true;
      // Simulate route handler completing
      res.status(201).json({ success: true, txId: '0xabc' });
    });

    middleware.use(req, res, next);

    expect(nextCalled).toBe(true);
    expect(headers['x-cache']).toBe('MISS');

    const record = storage.get('key-123');
    expect(record).toBeDefined();
    expect(record?.status).toBe('completed');
    expect(record?.statusCode).toBe(201);
    expect(record?.responseBody).toEqual({ success: true, txId: '0xabc' });
  });

  it('should return 409 Conflict if same idempotency key is concurrently in-flight', () => {
    const req1: IdempotencyRequest = {
      method: 'POST',
      path: '/bridges/execute',
      headers: { 'idempotency-key': 'concurrent-key' },
      body: { amount: 100 },
    };
    const { res: res1 } = createMockResponse();
    const next1 = jest.fn(); // Doesn't finish yet

    middleware.use(req1, res1, next1);

    const req2: IdempotencyRequest = {
      method: 'POST',
      path: '/bridges/execute',
      headers: { 'idempotency-key': 'concurrent-key' },
      body: { amount: 100 },
    };
    const { res: res2, headers: headers2 } = createMockResponse();
    const next2 = jest.fn();

    middleware.use(req2, res2, next2);

    expect(res2.status).toHaveBeenCalledWith(409);
    expect(headers2['retry-after']).toBe('1');
    expect(res2.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 409,
        error: 'Conflict',
      }),
    );
    expect(next2).not.toHaveBeenCalled();
  });

  it('should return cached response with X-Cache: HIT on replay', () => {
    const req: IdempotencyRequest = {
      method: 'POST',
      path: '/bridges/execute',
      headers: { 'idempotency-key': 'replay-key' },
      body: { amount: 100 },
    };
    const { res: res1 } = createMockResponse();
    middleware.use(req, res1, () => {
      res1.status(200).json({ status: 'confirmed', hash: '0x123' });
    });

    const { res: res2, headers: headers2 } = createMockResponse();
    const next2 = jest.fn();
    middleware.use(req, res2, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(headers2['x-cache']).toBe('HIT');
    expect(headers2['idempotent-replayed']).toBe('true');
    expect(res2.status).toHaveBeenCalledWith(200);
    expect(res2.json).toHaveBeenCalledWith({ status: 'confirmed', hash: '0x123' });
  });

  it('should reject reuse of key with mismatched payload with 422', () => {
    const req1: IdempotencyRequest = {
      method: 'POST',
      path: '/bridges/execute',
      headers: { 'idempotency-key': 'payload-key' },
      body: { amount: 100 },
    };
    const { res: res1 } = createMockResponse();
    middleware.use(req1, res1, () => {
      res1.status(200).json({ status: 'confirmed' });
    });

    const req2: IdempotencyRequest = {
      method: 'POST',
      path: '/bridges/execute',
      headers: { 'idempotency-key': 'payload-key' },
      body: { amount: 999 }, // Mismatched body!
    };
    const { res: res2 } = createMockResponse();
    const next2 = jest.fn();
    middleware.use(req2, res2, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2.status).toHaveBeenCalledWith(422);
    expect(res2.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 422,
        error: 'Unprocessable Entity',
      }),
    );
  });
});

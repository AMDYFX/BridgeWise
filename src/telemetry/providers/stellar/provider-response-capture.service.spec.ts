import {
  ProviderResponseCaptureService,
} from './provider-response-capture.service';

describe('ProviderResponseCaptureService', () => {
  let service: ProviderResponseCaptureService;

  beforeEach(() => {
    service = new ProviderResponseCaptureService(50);
  });

  describe('captureResponse', () => {
    it('should capture response and sanitize sensitive fields', () => {
      const record = service.captureResponse({
        providerId: 'stellar-allbridge',
        endpoint: '/api/v1/bridge/quote',
        method: 'POST',
        statusCode: 200,
        latencyMs: 120,
        requestHeaders: {
          Authorization: 'Bearer super-secret-token',
          'Content-Type': 'application/json',
        },
        requestBody: {
          asset: 'USDC',
          apiKey: 'secret-api-key-123',
          amount: '1000',
        },
        responseHeaders: {
          'x-request-id': 'req-999',
        },
        responseBody: {
          estimatedAmount: '998',
          fee: '2',
        },
      });

      expect(record.id).toBeDefined();
      expect(record.providerId).toBe('stellar-allbridge');
      expect(record.endpoint).toBe('/api/v1/bridge/quote');
      expect(record.method).toBe('POST');
      expect(record.statusCode).toBe(200);
      expect(record.latencyMs).toBe(120);

      expect(record.requestHeaders?.['Authorization']).toBe('[REDACTED]');
      expect(record.requestHeaders?.['Content-Type']).toBe('application/json');

      const body = record.requestBody as Record<string, unknown>;
      expect(body['apiKey']).toBe('[REDACTED]');
      expect(body['asset']).toBe('USDC');
      expect(body['amount']).toBe('1000');
    });

    it('should respect maximum records capacity', () => {
      const miniService = new ProviderResponseCaptureService(3);
      for (let i = 1; i <= 5; i++) {
        miniService.captureResponse({
          providerId: `provider-${i}`,
          endpoint: '/ping',
          method: 'GET',
          statusCode: 200,
          latencyMs: 10,
        });
      }

      const records = miniService.getRecords();
      expect(records.length).toBe(3);
      expect(records[0].providerId).toBe('provider-3');
      expect(records[2].providerId).toBe('provider-5');
    });
  });

  describe('wrapRequest', () => {
    it('should successfully execute requestFn and capture telemetry', async () => {
      const mockFn = jest.fn().mockResolvedValue({
        statusCode: 200,
        body: { status: 'ok', routeId: 'rt-1' },
        headers: { 'x-powered-by': 'Stellar' },
      });

      const { result, record } = await service.wrapRequest(
        'stellar-dex',
        '/swap',
        'POST',
        mockFn,
        { requestBody: { amount: 50 } },
      );

      expect(result).toEqual({ status: 'ok', routeId: 'rt-1' });
      expect(record.providerId).toBe('stellar-dex');
      expect(record.statusCode).toBe(200);
      expect(record.latencyMs).toBeGreaterThanOrEqual(0);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should capture failure and rethrow when requestFn fails', async () => {
      const mockFn = jest.fn().mockRejectedValue(new Error('Connection timed out'));

      await expect(
        service.wrapRequest('stellar-dex', '/swap', 'POST', mockFn),
      ).rejects.toThrow('Connection timed out');

      const records = service.getRecords({ providerId: 'stellar-dex' });
      expect(records.length).toBe(1);
      expect(records[0].statusCode).toBe(500);
      expect(records[0].error).toBe('Connection timed out');
    });
  });

  describe('filtering and stats', () => {
    beforeEach(() => {
      service.captureResponse({
        providerId: 'stellar-fast',
        endpoint: '/quote',
        method: 'GET',
        statusCode: 200,
        latencyMs: 50,
      });
      service.captureResponse({
        providerId: 'stellar-fast',
        endpoint: '/execute',
        method: 'POST',
        statusCode: 201,
        latencyMs: 150,
      });
      service.captureResponse({
        providerId: 'stellar-slow',
        endpoint: '/quote',
        method: 'GET',
        statusCode: 504,
        latencyMs: 2000,
        error: 'Gateway Timeout',
      });
    });

    it('should filter by providerId and status code', () => {
      const fastRecords = service.getRecords({ providerId: 'stellar-fast' });
      expect(fastRecords.length).toBe(2);

      const errors = service.getRecords({ hasError: true });
      expect(errors.length).toBe(1);
      expect(errors[0].providerId).toBe('stellar-slow');
    });

    it('should compute aggregated metrics', () => {
      const stats = service.getStats();
      expect(stats.totalCaptured).toBe(3);
      expect(stats.successCount).toBe(2);
      expect(stats.failureCount).toBe(1);
      expect(stats.averageLatencyMs).toBe(Math.round((50 + 150 + 2000) / 3));
      expect(stats.statusCodes[200]).toBe(1);
      expect(stats.statusCodes[201]).toBe(1);
      expect(stats.statusCodes[504]).toBe(1);

      const fastStats = service.getStats('stellar-fast');
      expect(fastStats.totalCaptured).toBe(2);
      expect(fastStats.successCount).toBe(2);
      expect(fastStats.failureCount).toBe(0);
      expect(fastStats.averageLatencyMs).toBe(100);
    });

    it('should clear all records', () => {
      service.clear();
      expect(service.getRecords().length).toBe(0);
      expect(service.getStats().totalCaptured).toBe(0);
    });
  });
});

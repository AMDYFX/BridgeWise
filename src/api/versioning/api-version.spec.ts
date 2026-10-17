import { ApiVersionService } from './api-version.service';
import { ApiVersionMiddleware, RequestLike, ResponseLike } from './api-version.middleware';

describe('ApiVersioning', () => {
  describe('ApiVersionService', () => {
    let service: ApiVersionService;

    beforeEach(() => {
      service = new ApiVersionService();
      service.registerVersion({
        version: 'v0',
        status: 'sunset',
        releaseDate: '2024-01-01',
        sunsetDate: '2024-12-31T00:00:00.000Z',
        successorVersion: 'v1',
      });
      service.registerVersion({
        version: 'v1',
        status: 'deprecated',
        releaseDate: '2025-01-01',
        sunsetDate: '2027-01-01T00:00:00.000Z',
        successorVersion: 'v2',
      });
      service.registerVersion({
        version: 'v2',
        status: 'active',
        releaseDate: '2026-01-01',
      });
    });

    it('should resolve version from URL path', () => {
      const res = service.resolveVersion({ path: '/api/v2/bridges' });
      expect(res.valid).toBe(true);
      expect(res.version).toBe('v2');
      expect(res.status).toBe('active');
    });

    it('should resolve version from header when not in path', () => {
      const res = service.resolveVersion({
        path: '/bridges',
        headers: { 'x-api-version': 'v1' },
      });
      expect(res.valid).toBe(true);
      expect(res.version).toBe('v1');
      expect(res.status).toBe('deprecated');
    });

    it('should resolve version from query param when allowed', () => {
      const res = service.resolveVersion({
        path: '/bridges',
        query: { version: '2' },
      });
      expect(res.valid).toBe(true);
      expect(res.version).toBe('v2');
    });

    it('should return error for unsupported version', () => {
      const res = service.resolveVersion({ path: '/api/v99/bridges' });
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Unsupported API version "v99"');
    });

    it('should return error for sunsetted version', () => {
      const res = service.resolveVersion({ path: '/api/v0/bridges' });
      expect(res.valid).toBe(false);
      expect(res.status).toBe('sunset');
      expect(res.error).toContain('is sunsetted and no longer accessible');
    });

    it('should provide deprecation headers for deprecated versions', () => {
      const res = service.resolveVersion({ path: '/api/v1/bridges' });
      const headers = service.getResponseHeaders(res);
      expect(headers['X-API-Version']).toBe('v1');
      expect(headers['X-API-Deprecated']).toBe('true');
      expect(headers['Sunset']).toBeDefined();
      expect(headers['Link']).toContain('rel="successor-version"');
    });
  });

  describe('ApiVersionMiddleware', () => {
    let service: ApiVersionService;
    let middleware: ApiVersionMiddleware;

    beforeEach(() => {
      service = new ApiVersionService();
      service.registerVersion({
        version: 'v0',
        status: 'sunset',
        releaseDate: '2024-01-01',
        sunsetDate: '2024-12-31T00:00:00.000Z',
        successorVersion: 'v1',
      });
      middleware = new ApiVersionMiddleware(service);
    });

    it('should set version headers and call next() on valid request', () => {
      const req: RequestLike = { path: '/api/v1/quotes' };
      const headersSet: Record<string, string> = {};
      const res: ResponseLike = {
        setHeader: jest.fn((k, v) => {
          headersSet[k] = v;
        }),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(req.apiVersion).toBe('v1');
      expect(headersSet['X-API-Version']).toBe('v1');
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should return 410 Gone for sunset version', () => {
      const req: RequestLike = { path: '/api/v0/quotes' };
      const resJson = jest.fn();
      const resStatus = jest.fn().mockReturnValue({ json: resJson });
      const res: ResponseLike = {
        setHeader: jest.fn(),
        status: resStatus,
        json: resJson,
      };
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(resStatus).toHaveBeenCalledWith(410);
      expect(resJson).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 410,
          error: 'Gone',
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 400 Bad Request for unsupported version', () => {
      const req: RequestLike = { path: '/api/v999/quotes' };
      const resJson = jest.fn();
      const resStatus = jest.fn().mockReturnValue({ json: resJson });
      const res: ResponseLike = {
        setHeader: jest.fn(),
        status: resStatus,
        json: resJson,
      };
      const next = jest.fn();

      middleware.use(req, res, next);

      expect(resStatus).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });
  });
});

import { EnvironmentValidator, ENV_SCHEMA } from './env-schema';

describe('EnvironmentValidator', () => {
  const originalEnv = { ...process.env };
  const validEnvironment = {
    NODE_ENV: 'production',
    DB_HOST: 'db.example.com',
    DB_PORT: '5432',
    DB_USERNAME: 'bridgewise',
    DB_PASSWORD: 'synthetic-test-password',
    DB_NAME: 'bridgewise_test',
    DB_SSL: 'true',
    FORCE_HTTPS: 'true',
    CORS_ORIGIN: 'https://app.example.com',
    API_KEY: 'synthetic-test-key',
    RPC_ETHEREUM: 'https://eth.example.com',
    RPC_POLYGON: 'https://polygon.example.com',
    RPC_BSC: 'https://bsc.example.com',
    RPC_ARBITRUM: 'https://arbitrum.example.com',
    RPC_OPTIMISM: 'https://optimism.example.com',
    RPC_BASE: 'https://base.example.com',
    VAULT_ENCRYPTION_KEY: 'synthetic-test-key',
  };

  beforeEach(() => {
    // Reset to a clean state
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('validate', () => {
    it('should pass validation for development environment with required vars', () => {
      process.env.DB_HOST = 'localhost';
      process.env.DB_USERNAME = 'postgres';
      process.env.DB_PASSWORD = 'password';
      process.env.DB_NAME = 'test_db';
      process.env.API_KEY = 'test_key';
      process.env.RPC_ETHEREUM = 'https://eth.example.com';
      process.env.RPC_POLYGON = 'https://polygon.example.com';
      process.env.RPC_BSC = 'https://bsc.example.com';
      process.env.RPC_ARBITRUM = 'https://arbitrum.example.com';
      process.env.RPC_OPTIMISM = 'https://optimism.example.com';
      process.env.RPC_BASE = 'https://base.example.com';
      process.env.NODE_ENV = 'development';

      const result = EnvironmentValidator.validate('development');

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail when required variables are missing', () => {
      delete process.env.DB_HOST;
      delete process.env.DB_USERNAME;

      const result = EnvironmentValidator.validate('development');

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.key === 'DB_HOST')).toBe(true);
    });

    it('should validate number types', () => {
      process.env.PORT = 'not-a-number';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USERNAME = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';
      process.env.API_KEY = 'key';

      const result = EnvironmentValidator.validate('development');

      const portError = result.errors.find((e) => e.key === 'PORT');
      expect(portError).toBeDefined();
    });

    it('should validate URL types', () => {
      process.env.RPC_ETHEREUM = 'not-a-url';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USERNAME = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';
      process.env.API_KEY = 'key';

      const result = EnvironmentValidator.validate('development');

      const uriError = result.errors.find((e) => e.key === 'RPC_ETHEREUM');
      expect(uriError).toBeDefined();
    });

    it('should validate boolean types', () => {
      process.env.DB_SSL = 'maybe';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USERNAME = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';
      process.env.API_KEY = 'key';

      const result = EnvironmentValidator.validate('development');

      const boolError = result.errors.find((e) => e.key === 'DB_SSL');
      expect(boolError).toBeDefined();
    });

    it('should validate allowed values', () => {
      process.env.NODE_ENV = 'invalid_env';
      process.env.DB_HOST = 'localhost';
      process.env.DB_USERNAME = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';
      process.env.API_KEY = 'key';

      const result = EnvironmentValidator.validate('development');

      const envError = result.errors.find((e) => e.key === 'NODE_ENV');
      expect(envError).toBeDefined();
    });

    it('should provide warnings for production configuration', () => {
      process.env.DB_HOST = 'localhost';
      process.env.DB_USERNAME = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';
      process.env.API_KEY = 'key';
      process.env.RPC_ETHEREUM = 'https://eth.example.com';
      process.env.RPC_POLYGON = 'https://polygon.example.com';
      process.env.RPC_BSC = 'https://bsc.example.com';
      process.env.RPC_ARBITRUM = 'https://arbitrum.example.com';
      process.env.RPC_OPTIMISM = 'https://optimism.example.com';
      process.env.VAULT_ENCRYPTION_KEY = 'key';

      const result = EnvironmentValidator.validate('production');

      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should require VAULT_ENCRYPTION_KEY in production', () => {
      delete process.env.VAULT_ENCRYPTION_KEY;
      process.env.DB_HOST = 'localhost';
      process.env.DB_USERNAME = 'user';
      process.env.DB_PASSWORD = 'pass';
      process.env.DB_NAME = 'db';
      process.env.API_KEY = 'key';
      process.env.RPC_ETHEREUM = 'https://eth.example.com';
      process.env.RPC_POLYGON = 'https://polygon.example.com';
      process.env.RPC_BSC = 'https://bsc.example.com';
      process.env.RPC_ARBITRUM = 'https://arbitrum.example.com';
      process.env.RPC_OPTIMISM = 'https://optimism.example.com';

      const result = EnvironmentValidator.validate('production');

      expect(result.errors.some((e) => e.key === 'VAULT_ENCRYPTION_KEY')).toBe(
        true,
      );
    });

    it('should validate the supplied configuration without reading process.env', () => {
      const result = EnvironmentValidator.validate(
        'production',
        validEnvironment,
      );

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject whitespace-only required values and invalid numeric boundaries', () => {
      const result = EnvironmentValidator.validate('production', {
        ...validEnvironment,
        DB_HOST: '   ',
        PORT: '65536',
        API_TIMEOUT: 'Infinity',
      });

      expect(result.errors.some((error) => error.key === 'DB_HOST')).toBe(true);
      expect(result.errors.some((error) => error.key === 'PORT')).toBe(true);
      expect(result.errors.some((error) => error.key === 'API_TIMEOUT')).toBe(
        true,
      );
    });

    it('should reject fractional port values', () => {
      const result = EnvironmentValidator.validate('production', {
        ...validEnvironment,
        PORT: '3000.5',
      });

      expect(result.errors.some((error) => error.key === 'PORT')).toBe(true);
    });

    it('should reject environment mismatches and unsafe production settings', () => {
      const result = EnvironmentValidator.validate('production', {
        ...validEnvironment,
        NODE_ENV: 'staging',
        FORCE_HTTPS: 'false',
        DB_SSL: 'false',
        CORS_ORIGIN: '*',
      });

      expect(result.valid).toBe(false);
      expect(result.errors.map((error) => error.key)).toEqual(
        expect.arrayContaining([
          'NODE_ENV',
          'FORCE_HTTPS',
          'DB_SSL',
          'CORS_ORIGIN',
        ]),
      );
    });

    it('should reject production placeholders and insecure URLs without exposing values', () => {
      const result = EnvironmentValidator.validate('production', {
        ...validEnvironment,
        API_KEY: 'your_production_api_key_here',
        RPC_ETHEREUM: 'http://rpc.example.com',
        RPC_BSC: 'https://rpc.example.com/YOUR_PROJECT_ID',
        CORS_ORIGIN: 'https://app.example.com, *',
      });

      expect(result.errors.map((error) => error.key)).toEqual(
        expect.arrayContaining([
          'API_KEY',
          'RPC_ETHEREUM',
          'RPC_BSC',
          'CORS_ORIGIN',
        ]),
      );
      expect(JSON.stringify(result.errors)).not.toContain(
        'your_production_api_key_here',
      );
    });
  });

  describe('generateReport', () => {
    it('should generate an environment report', () => {
      process.env.NODE_ENV = 'development';

      const report = EnvironmentValidator.generateReport();

      expect(report.environment).toBe('development');
      expect(report.timestamp).toBeDefined();
      expect(report.variables).toBeDefined();
      expect(report.total).toBeGreaterThan(0);
      expect(report.configured).toBeDefined();
    });

    it('should redact sensitive values in report', () => {
      process.env.API_KEY = 'secret_key_value';

      const report = EnvironmentValidator.generateReport();

      const apiKeyVar = report.variables.find((v) => v.name === 'API_KEY');
      expect(apiKeyVar?.currentValue).toBe('***REDACTED***');
    });
  });
});

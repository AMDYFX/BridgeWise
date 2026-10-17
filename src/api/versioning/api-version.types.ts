export type ApiVersionStatus = 'active' | 'deprecated' | 'sunset';

export interface ApiVersionDefinition {
  version: string; // e.g. 'v1', 'v2'
  status: ApiVersionStatus;
  releaseDate: string;
  sunsetDate?: string; // ISO date string
  successorVersion?: string;
  description?: string;
}

export interface VersionResolutionResult {
  valid: boolean;
  version?: string;
  status?: ApiVersionStatus;
  sunsetDate?: string;
  successorVersion?: string;
  error?: string;
}

export interface ApiVersioningOptions {
  defaultVersion?: string;
  supportedVersions?: ApiVersionDefinition[];
  headerNames?: string[]; // default ['x-api-version', 'accept-version']
  allowQueryParam?: boolean;
}

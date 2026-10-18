import { Injectable } from '@nestjs/common';
import {
  ApiVersionDefinition,
  ApiVersioningOptions,
  VersionResolutionResult,
} from './api-version.types';

@Injectable()
export class ApiVersionService {
  private versions: Map<string, ApiVersionDefinition> = new Map();
  private defaultVersion: string;
  private headerNames: string[];
  private allowQueryParam: boolean;

  constructor(options?: ApiVersioningOptions) {
    this.defaultVersion = options?.defaultVersion ?? 'v1';
    this.headerNames = (options?.headerNames ?? ['x-api-version', 'accept-version']).map(h =>
      h.toLowerCase(),
    );
    this.allowQueryParam = options?.allowQueryParam ?? true;

    // Register initial default versions if provided, else standard defaults
    const initialVersions = options?.supportedVersions ?? [
      {
        version: 'v1',
        status: 'active',
        releaseDate: '2025-01-01',
        description: 'Initial public stable API',
      },
      {
        version: 'v2',
        status: 'active',
        releaseDate: '2026-01-01',
        description: 'V2 high-throughput API with unified cross-chain routing',
      },
    ];

    for (const v of initialVersions) {
      this.registerVersion(v);
    }
  }

  registerVersion(def: ApiVersionDefinition): void {
    const normalized = this.normalizeVersion(def.version);
    this.versions.set(normalized, {
      ...def,
      version: normalized,
    });
  }

  normalizeVersion(raw: string): string {
    const trimmed = raw.trim().toLowerCase();
    return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
  }

  getAllVersions(): ApiVersionDefinition[] {
    return Array.from(this.versions.values());
  }

  getVersion(version: string): ApiVersionDefinition | undefined {
    return this.versions.get(this.normalizeVersion(version));
  }

  extractVersionFromUrl(path: string): string | null {
    // Matches /api/v1/..., /v1/..., /api/v2/...
    const match = path.match(/(?:\/api)?\/(v\d+)(?:\/|$)/i);
    return match ? this.normalizeVersion(match[1]) : null;
  }

  resolveVersion(request: {
    path?: string;
    headers?: Record<string, string | string[] | undefined>;
    query?: Record<string, string | string[] | undefined>;
  }): VersionResolutionResult {
    let requestedVersion: string | null = null;

    // 1. Try URL path
    if (request.path) {
      requestedVersion = this.extractVersionFromUrl(request.path);
    }

    // 2. Try headers if not found in path
    if (!requestedVersion && request.headers) {
      for (const h of this.headerNames) {
        const val = request.headers[h];
        if (val) {
          const strVal = Array.isArray(val) ? val[0] : val;
          if (strVal && typeof strVal === 'string') {
            requestedVersion = this.normalizeVersion(strVal);
            break;
          }
        }
      }
    }

    // 3. Try query param if allowed
    if (!requestedVersion && this.allowQueryParam && request.query) {
      const qVal = request.query['version'] || request.query['v'] || request.query['api-version'];
      if (qVal) {
        const strVal = Array.isArray(qVal) ? qVal[0] : qVal;
        if (strVal && typeof strVal === 'string') {
          requestedVersion = this.normalizeVersion(strVal);
        }
      }
    }

    // 4. Fallback to default version
    const finalVersion = requestedVersion ?? this.defaultVersion;
    const def = this.versions.get(finalVersion);

    if (!def) {
      return {
        valid: false,
        version: finalVersion,
        error: `Unsupported API version "${finalVersion}". Supported versions: ${Array.from(this.versions.keys()).join(', ')}`,
      };
    }

    if (def.status === 'sunset') {
      return {
        valid: false,
        version: finalVersion,
        status: 'sunset',
        sunsetDate: def.sunsetDate,
        successorVersion: def.successorVersion,
        error: `API version "${finalVersion}" is sunsetted and no longer accessible.${def.successorVersion ? ` Please upgrade to ${def.successorVersion}.` : ''}`,
      };
    }

    return {
      valid: true,
      version: finalVersion,
      status: def.status,
      sunsetDate: def.sunsetDate,
      successorVersion: def.successorVersion,
    };
  }

  getResponseHeaders(resolution: VersionResolutionResult): Record<string, string> {
    const headers: Record<string, string> = {};

    if (resolution.version) {
      headers['X-API-Version'] = resolution.version;
    }

    if (resolution.status === 'deprecated') {
      headers['X-API-Deprecated'] = 'true';
      if (resolution.sunsetDate) {
        headers['Sunset'] = new Date(resolution.sunsetDate).toUTCString();
      }
      if (resolution.successorVersion) {
        headers['Link'] = `</api/${resolution.successorVersion}>; rel="successor-version"`;
      }
    }

    return headers;
  }
}

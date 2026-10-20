/**
 * Versioned message schema adapters — public API.
 *
 * @example
 * ```ts
 * import {
 *   defaultSchemaRegistry,
 *   SchemaRegistry,
 *   schemaAdapterV1,
 *   schemaAdapterV2,
 * } from '@bridgewise/verification/schema-adapters';
 * import type { MessageSchemaAdapter, WireMessage } from '@bridgewise/verification/schema-adapters';
 *
 * // Serialise to v2 wire format
 * const wire = defaultSchemaRegistry.toWire(message, 2);
 *
 * // Migrate a v1 wire message to v2
 * const upgraded = defaultSchemaRegistry.migrateToVersion(v1Wire, 2);
 *
 * // Deserialise using the version embedded in the wire object
 * const decoded = defaultSchemaRegistry.fromWire(wire);
 * ```
 */

export { SchemaRegistry, defaultSchemaRegistry } from "./registry";
export { SchemaAdapterV1, SchemaAdapterV2, schemaAdapterV1, schemaAdapterV2 } from "./adapters";
export { SchemaAdapterError } from "./types";
export type {
  MessageSchemaAdapter,
  WireMessage,
  ResolvedAdapter,
  SchemaAdapterErrorKind,
  SchemaRegistryConfig,
} from "./types";

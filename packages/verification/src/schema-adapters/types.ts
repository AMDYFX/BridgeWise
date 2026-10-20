/**
 * Types for versioned message schema adapters.
 *
 * Background
 * ----------
 * Cross-chain messaging protocols evolve over time.  A v1 message sent by an
 * older relayer must still be processable by a v2-aware destination chain — and
 * vice-versa.  Schema adapters solve this by providing a per-version
 * encode/decode contract plus a registry that selects the right adapter
 * automatically.
 *
 * Design constraints
 * ------------------
 * - Each schema version is an integer ≥ 1.
 * - Adapters are stateless and pure.
 * - The registry rejects unknown versions rather than silently degrading.
 * - Migration helpers allow upgrading a message from vN to vN+1 in one step.
 * - Every failure is a typed error, never a silent data loss.
 */

import type { EncodableMessage } from "../payload-encoding/types";

// ─── Versioned wire format ────────────────────────────────────────────────────

/**
 * An opaque map representing the on-wire JSON object for a specific schema
 * version.  Adapters own the interpretation of these fields.
 */
export type WireMessage = Record<string, unknown>;

// ─── Adapter contract ─────────────────────────────────────────────────────────

/**
 * A schema adapter handles serialisation and deserialisation for one specific
 * message schema version.
 *
 * Implementations MUST be stateless (no mutable state, no I/O).
 */
export interface MessageSchemaAdapter {
  /** Schema version this adapter handles (positive integer). */
  readonly schemaVersion: number;

  /**
   * Serialise a normalised `EncodableMessage` to the wire format for this
   * schema version.
   *
   * @throws {SchemaAdapterError} if the message is incompatible with this version.
   */
  toWire(message: EncodableMessage): WireMessage;

  /**
   * Deserialise a wire-format object into a normalised `EncodableMessage`.
   *
   * @throws {SchemaAdapterError} if the wire object is malformed or missing
   *   required fields for this schema version.
   */
  fromWire(wire: WireMessage): EncodableMessage;

  /**
   * Upgrade a wire-format object from the *previous* schema version to this
   * one.  Returns `null` if this is version 1 (no predecessor exists).
   *
   * @throws {SchemaAdapterError} if the migration cannot be completed.
   */
  migrateFromPrevious(previous: WireMessage): WireMessage | null;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Result of a registry lookup, bundling the resolved version with its adapter.
 */
export interface ResolvedAdapter {
  schemaVersion: number;
  adapter: MessageSchemaAdapter;
}

// ─── Error types ─────────────────────────────────────────────────────────────

export type SchemaAdapterErrorKind =
  | "unknown-version"
  | "missing-field"
  | "invalid-field"
  | "migration-not-supported"
  | "downgrade-not-supported"
  | "duplicate-version";

export class SchemaAdapterError extends Error {
  constructor(
    public readonly kind: SchemaAdapterErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "SchemaAdapterError";
  }
}

// ─── Registry configuration ───────────────────────────────────────────────────

export interface SchemaRegistryConfig {
  /**
   * When true (default) the registry will also accept the latest registered
   * version when no explicit version is requested.
   */
  allowLatestFallback?: boolean;
}

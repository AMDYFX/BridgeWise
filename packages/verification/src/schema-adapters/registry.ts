/**
 * Schema adapter registry.
 *
 * Maintains a map of schemaVersion → MessageSchemaAdapter and exposes
 * helpers for version resolution, round-trip conversion, and step-wise
 * migration from any registered version to the latest.
 *
 * Failure semantics
 * -----------------
 * - `unknown-version`          — requested version is not registered.
 * - `duplicate-version`        — two adapters share the same schemaVersion.
 * - `downgrade-not-supported`  — caller asked to migrate from a higher to
 *                                a lower version (not supported).
 * - `migration-not-supported`  — a gap in the version chain prevents step-wise
 *                                migration (e.g. v1 → v3 with no v2 adapter).
 *
 * Idempotency
 * -----------
 * `resolve()` is pure — calling it with the same version always returns the
 * same adapter.  The registry itself is immutable after construction when
 * built from the factory; the mutable `SchemaRegistry` class is provided for
 * dynamic registration in tests and operator tooling.
 */

import { schemaAdapterV1, schemaAdapterV2 } from "./adapters";
import {
  MessageSchemaAdapter,
  ResolvedAdapter,
  SchemaAdapterError,
  SchemaRegistryConfig,
  WireMessage,
} from "./types";
import type { EncodableMessage } from "../payload-encoding/types";

export class SchemaRegistry {
  private readonly adapters = new Map<number, MessageSchemaAdapter>();
  private readonly config: Required<SchemaRegistryConfig>;

  constructor(config: SchemaRegistryConfig = {}) {
    this.config = {
      allowLatestFallback: config.allowLatestFallback ?? true,
    };
  }

  // ── Registration ────────────────────────────────────────────────────────────

  /**
   * Register an adapter.  Each schema version may only be registered once.
   *
   * @throws {SchemaAdapterError} with kind `duplicate-version` on conflict.
   */
  register(adapter: MessageSchemaAdapter): this {
    if (this.adapters.has(adapter.schemaVersion)) {
      throw new SchemaAdapterError(
        "duplicate-version",
        `Schema version ${adapter.schemaVersion} is already registered`,
      );
    }
    this.adapters.set(adapter.schemaVersion, adapter);
    return this;
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  /**
   * Resolve an adapter by version number.
   *
   * @throws {SchemaAdapterError} with kind `unknown-version` if not registered.
   */
  resolve(version: number): ResolvedAdapter {
    const adapter = this.adapters.get(version);
    if (!adapter) {
      throw new SchemaAdapterError(
        "unknown-version",
        `No adapter registered for schema version ${version}. ` +
          `Registered versions: ${this.registeredVersions().join(", ") || "none"}`,
      );
    }
    return { schemaVersion: version, adapter };
  }

  /**
   * Return the adapter for the highest registered version.
   *
   * @throws {SchemaAdapterError} if no adapters are registered.
   */
  resolveLatest(): ResolvedAdapter {
    const latest = this.latestVersion();
    if (latest === null) {
      throw new SchemaAdapterError("unknown-version", "No adapters are registered");
    }
    return this.resolve(latest);
  }

  /**
   * Resolve an adapter by version, falling back to the latest when
   * `version` is undefined and `allowLatestFallback` is true.
   */
  resolveOrLatest(version?: number): ResolvedAdapter {
    if (version === undefined) {
      if (!this.config.allowLatestFallback) {
        throw new SchemaAdapterError(
          "unknown-version",
          "No version specified and allowLatestFallback is disabled",
        );
      }
      return this.resolveLatest();
    }
    return this.resolve(version);
  }

  // ── Conversion helpers ──────────────────────────────────────────────────────

  /**
   * Serialise a normalised message to the wire format for `targetVersion`.
   * If the message carries a different schemaVersion the registry does NOT
   * automatically migrate — call `migrateToVersion` first.
   */
  toWire(message: EncodableMessage, targetVersion?: number): WireMessage {
    const { adapter } = this.resolveOrLatest(targetVersion);
    return adapter.toWire(message);
  }

  /**
   * Deserialise a wire object using the adapter whose version matches the
   * `schemaVersion` field embedded in the object.  Falls back to the latest
   * registered adapter when the field is absent and `allowLatestFallback` is
   * true.
   */
  fromWire(wire: WireMessage): EncodableMessage {
    const v = typeof wire.schemaVersion === "number" ? wire.schemaVersion : undefined;
    const { adapter } = this.resolveOrLatest(v);
    return adapter.fromWire(wire);
  }

  // ── Migration ───────────────────────────────────────────────────────────────

  /**
   * Migrate a wire message step-by-step from its current version to
   * `targetVersion` using each adapter's `migrateFromPrevious` method.
   *
   * Rules:
   * - Downgrade (current > target) is rejected.
   * - If current === target the message is returned unchanged.
   * - Every intermediate version must be registered.
   *
   * @throws {SchemaAdapterError} on downgrade, unknown version, or a gap in
   *   the migration chain.
   */
  migrateToVersion(wire: WireMessage, targetVersion: number): WireMessage {
    const currentVersion =
      typeof wire.schemaVersion === "number" ? wire.schemaVersion : null;

    if (currentVersion === null) {
      throw new SchemaAdapterError(
        "missing-field",
        "Cannot migrate: wire message has no schemaVersion field",
      );
    }

    if (currentVersion === targetVersion) return wire;

    if (currentVersion > targetVersion) {
      throw new SchemaAdapterError(
        "downgrade-not-supported",
        `Cannot migrate from v${currentVersion} to v${targetVersion}: downgrade is not supported`,
      );
    }

    // Step forward one version at a time
    let current = wire;
    for (let v = currentVersion + 1; v <= targetVersion; v++) {
      const { adapter } = this.resolve(v);
      const migrated = adapter.migrateFromPrevious(current);
      if (migrated === null) {
        throw new SchemaAdapterError(
          "migration-not-supported",
          `Adapter for v${v} returned null from migrateFromPrevious — ` +
            `migration path from v${currentVersion} to v${targetVersion} is broken`,
        );
      }
      current = migrated;
    }

    return current;
  }

  /**
   * Migrate a wire message to the latest registered version.
   */
  migrateToLatest(wire: WireMessage): WireMessage {
    const latest = this.latestVersion();
    if (latest === null) {
      throw new SchemaAdapterError("unknown-version", "No adapters are registered");
    }
    return this.migrateToVersion(wire, latest);
  }

  // ── Introspection ───────────────────────────────────────────────────────────

  /** Returns all registered version numbers in ascending order. */
  registeredVersions(): number[] {
    return [...this.adapters.keys()].sort((a, b) => a - b);
  }

  /** Returns the highest registered version, or null if none are registered. */
  latestVersion(): number | null {
    const versions = this.registeredVersions();
    return versions.length > 0 ? versions[versions.length - 1]! : null;
  }

  /** Returns true if the given version is registered. */
  isRegistered(version: number): boolean {
    return this.adapters.has(version);
  }
}

// ─── Default registry ─────────────────────────────────────────────────────────

/**
 * Pre-populated registry containing v1 and v2 adapters.
 * Importers may add further versions by calling `.register()`.
 */
export const defaultSchemaRegistry = new SchemaRegistry()
  .register(schemaAdapterV1)
  .register(schemaAdapterV2);

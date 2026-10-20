/**
 * Versioned message schema adapter tests.
 *
 * All tests use deterministic in-memory fixtures — no I/O, no clock.
 *
 * Coverage:
 *   - SchemaAdapterV1: toWire, fromWire, migrateFromPrevious, error cases
 *   - SchemaAdapterV2: toWire, fromWire, migrateFromPrevious, v2 extension fields
 *   - SchemaRegistry: register, resolve, resolveLatest, resolveOrLatest,
 *     toWire, fromWire, migrateToVersion, migrateToLatest, introspection
 *   - Failure cases: every SchemaAdapterErrorKind is exercised
 *   - Idempotency: same input → same output for all pure methods
 *   - Simulated dependency failures: registry survives bad adapter throws
 *   - defaultSchemaRegistry: pre-populated, functional out of the box
 */

import {
  SchemaAdapterV1,
  SchemaAdapterV2,
  schemaAdapterV1,
  schemaAdapterV2,
} from "../adapters";
import { SchemaRegistry, defaultSchemaRegistry } from "../registry";
import { SchemaAdapterError } from "../types";
import type { EncodableMessage } from "../../payload-encoding/types";
import type { MessageSchemaAdapter, WireMessage } from "../types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function baseMessage(overrides: Partial<EncodableMessage> = {}): EncodableMessage {
  return {
    messageId: "msg-001",
    sourceChainId: 101,
    destinationChainId: 109,
    sender: "0xSender",
    recipient: "0xRecipient",
    payload: "0xdeadbeef",
    ...overrides,
  };
}

function v1Wire(overrides: Partial<WireMessage> = {}): WireMessage {
  return {
    schemaVersion: 1,
    messageId: "msg-001",
    sourceChainId: 101,
    destinationChainId: 109,
    sender: "0xSender",
    recipient: "0xRecipient",
    payload: "0xdeadbeef",
    ...overrides,
  };
}

function v2Wire(overrides: Partial<WireMessage> = {}): WireMessage {
  return {
    schemaVersion: 2,
    messageId: "msg-001",
    sourceChainId: 101,
    destinationChainId: 109,
    sender: "0xSender",
    recipient: "0xRecipient",
    payload: "0xdeadbeef",
    ...overrides,
  };
}

// ─── SchemaAdapterV1 ──────────────────────────────────────────────────────────

describe("SchemaAdapterV1", () => {
  const adapter = new SchemaAdapterV1();

  it("schemaVersion is 1", () => {
    expect(adapter.schemaVersion).toBe(1);
  });

  describe("toWire", () => {
    it("serialises all required fields", () => {
      const wire = adapter.toWire(baseMessage({ schemaVersion: 1 }));
      expect(wire.schemaVersion).toBe(1);
      expect(wire.messageId).toBe("msg-001");
      expect(wire.sourceChainId).toBe(101);
      expect(wire.destinationChainId).toBe(109);
      expect(wire.sender).toBe("0xSender");
      expect(wire.recipient).toBe("0xRecipient");
      expect(wire.payload).toBe("0xdeadbeef");
    });

    it("includes nonce when present", () => {
      const wire = adapter.toWire(baseMessage({ nonce: 5, schemaVersion: 1 }));
      expect(wire.nonce).toBe(5);
    });

    it("omits nonce when absent", () => {
      const wire = adapter.toWire(baseMessage({ schemaVersion: 1 }));
      expect(wire.nonce).toBeUndefined();
    });

    it("accepts a message without an explicit schemaVersion", () => {
      expect(() => adapter.toWire(baseMessage())).not.toThrow();
    });

    it("rejects a message with schemaVersion=2", () => {
      expect(() => adapter.toWire(baseMessage({ schemaVersion: 2 }))).toThrow(SchemaAdapterError);
    });
  });

  describe("fromWire", () => {
    it("deserialises a valid v1 wire object", () => {
      const msg = adapter.fromWire(v1Wire());
      expect(msg.messageId).toBe("msg-001");
      expect(msg.schemaVersion).toBe(1);
    });

    it("round-trips nonce", () => {
      const msg = adapter.fromWire(v1Wire({ nonce: 7 }));
      expect(msg.nonce).toBe(7);
    });

    it("returns undefined nonce when absent", () => {
      const msg = adapter.fromWire(v1Wire());
      expect(msg.nonce).toBeUndefined();
    });

    it("throws missing-field when messageId is absent", () => {
      const wire = v1Wire();
      delete wire.messageId;
      expect(() => adapter.fromWire(wire)).toThrow(SchemaAdapterError);
      try { adapter.fromWire(wire); } catch (e) {
        expect((e as SchemaAdapterError).kind).toBe("missing-field");
      }
    });

    it("throws missing-field when sourceChainId is absent", () => {
      const wire = v1Wire();
      delete wire.sourceChainId;
      expect(() => adapter.fromWire(wire)).toThrow(SchemaAdapterError);
    });

    it("throws missing-field when payload is absent", () => {
      const wire = v1Wire();
      delete wire.payload;
      expect(() => adapter.fromWire(wire)).toThrow(SchemaAdapterError);
    });
  });

  describe("migrateFromPrevious", () => {
    it("returns null (v1 has no predecessor)", () => {
      expect(adapter.migrateFromPrevious({})).toBeNull();
    });
  });

  describe("idempotency", () => {
    it("toWire → fromWire → toWire produces identical output", () => {
      const m = baseMessage({ nonce: 3, schemaVersion: 1 });
      const wire1 = adapter.toWire(m);
      const decoded = adapter.fromWire(wire1);
      const wire2 = adapter.toWire(decoded);
      expect(wire2).toEqual(wire1);
    });
  });
});

// ─── SchemaAdapterV2 ──────────────────────────────────────────────────────────

describe("SchemaAdapterV2", () => {
  const adapter = new SchemaAdapterV2();

  it("schemaVersion is 2", () => {
    expect(adapter.schemaVersion).toBe(2);
  });

  describe("toWire", () => {
    it("serialises base fields with schemaVersion=2", () => {
      const wire = adapter.toWire(baseMessage({ schemaVersion: 2 }));
      expect(wire.schemaVersion).toBe(2);
      expect(wire.messageId).toBe("msg-001");
    });

    it("includes gasLimit extension field when present", () => {
      const m = Object.assign(baseMessage({ schemaVersion: 2 }), { gasLimit: 200000 });
      const wire = adapter.toWire(m);
      expect(wire.gasLimit).toBe(200000);
    });

    it("includes memo extension field when present", () => {
      const m = Object.assign(baseMessage({ schemaVersion: 2 }), { memo: "transfer note" });
      const wire = adapter.toWire(m);
      expect(wire.memo).toBe("transfer note");
    });

    it("omits gasLimit and memo when absent", () => {
      const wire = adapter.toWire(baseMessage({ schemaVersion: 2 }));
      expect(wire.gasLimit).toBeUndefined();
      expect(wire.memo).toBeUndefined();
    });

    it("rejects a message with schemaVersion=1", () => {
      expect(() => adapter.toWire(baseMessage({ schemaVersion: 1 }))).toThrow(SchemaAdapterError);
    });
  });

  describe("fromWire", () => {
    it("deserialises a valid v2 wire object", () => {
      const msg = adapter.fromWire(v2Wire());
      expect(msg.schemaVersion).toBe(2);
    });

    it("round-trips gasLimit", () => {
      const msg = adapter.fromWire(v2Wire({ gasLimit: 300000 })) as EncodableMessage & { gasLimit?: number };
      expect(msg.gasLimit).toBe(300000);
    });

    it("round-trips memo", () => {
      const msg = adapter.fromWire(v2Wire({ memo: "hello" })) as EncodableMessage & { memo?: string };
      expect(msg.memo).toBe("hello");
    });

    it("returns undefined gasLimit when absent", () => {
      const msg = adapter.fromWire(v2Wire()) as EncodableMessage & { gasLimit?: number };
      expect(msg.gasLimit).toBeUndefined();
    });

    it("throws missing-field when recipient is absent", () => {
      const wire = v2Wire();
      delete wire.recipient;
      expect(() => adapter.fromWire(wire)).toThrow(SchemaAdapterError);
    });
  });

  describe("migrateFromPrevious", () => {
    it("upgrades a v1 wire message to v2", () => {
      const upgraded = adapter.migrateFromPrevious(v1Wire());
      expect(upgraded).not.toBeNull();
      expect(upgraded!.schemaVersion).toBe(2);
    });

    it("preserves all v1 fields during migration", () => {
      const upgraded = adapter.migrateFromPrevious(v1Wire({ nonce: 9 }))!;
      expect(upgraded.messageId).toBe("msg-001");
      expect(upgraded.nonce).toBe(9);
    });

    it("throws migration-not-supported if source is not v1", () => {
      expect(() => adapter.migrateFromPrevious(v2Wire())).toThrow(SchemaAdapterError);
      try { adapter.migrateFromPrevious(v2Wire()); } catch (e) {
        expect((e as SchemaAdapterError).kind).toBe("migration-not-supported");
      }
    });
  });

  describe("idempotency", () => {
    it("toWire → fromWire → toWire produces identical output", () => {
      const m = Object.assign(baseMessage({ schemaVersion: 2, nonce: 1 }), { gasLimit: 100000, memo: "test" });
      const wire1 = adapter.toWire(m);
      const decoded = adapter.fromWire(wire1);
      const wire2 = adapter.toWire(decoded);
      expect(wire2).toEqual(wire1);
    });
  });
});

// ─── SchemaRegistry ───────────────────────────────────────────────────────────

describe("SchemaRegistry", () => {
  function freshRegistry(): SchemaRegistry {
    return new SchemaRegistry().register(schemaAdapterV1).register(schemaAdapterV2);
  }

  describe("register", () => {
    it("registers adapters and allows chaining", () => {
      const r = new SchemaRegistry().register(schemaAdapterV1);
      expect(r.isRegistered(1)).toBe(true);
    });

    it("throws duplicate-version when the same version is registered twice", () => {
      const r = new SchemaRegistry().register(schemaAdapterV1);
      expect(() => r.register(new SchemaAdapterV1())).toThrow(SchemaAdapterError);
      try { r.register(new SchemaAdapterV1()); } catch (e) {
        expect((e as SchemaAdapterError).kind).toBe("duplicate-version");
      }
    });
  });

  describe("resolve", () => {
    it("returns the correct adapter for a registered version", () => {
      const r = freshRegistry();
      expect(r.resolve(1).schemaVersion).toBe(1);
      expect(r.resolve(2).schemaVersion).toBe(2);
    });

    it("throws unknown-version for an unregistered version", () => {
      const r = freshRegistry();
      expect(() => r.resolve(99)).toThrow(SchemaAdapterError);
      try { r.resolve(99); } catch (e) {
        expect((e as SchemaAdapterError).kind).toBe("unknown-version");
        expect((e as SchemaAdapterError).message).toMatch(/99/);
      }
    });
  });

  describe("resolveLatest", () => {
    it("returns the highest registered version", () => {
      const r = freshRegistry();
      expect(r.resolveLatest().schemaVersion).toBe(2);
    });

    it("throws unknown-version when no adapters are registered", () => {
      expect(() => new SchemaRegistry().resolveLatest()).toThrow(SchemaAdapterError);
    });
  });

  describe("resolveOrLatest", () => {
    it("resolves a specific version when provided", () => {
      expect(freshRegistry().resolveOrLatest(1).schemaVersion).toBe(1);
    });

    it("falls back to latest when version is undefined", () => {
      expect(freshRegistry().resolveOrLatest(undefined).schemaVersion).toBe(2);
    });

    it("throws unknown-version when allowLatestFallback=false and no version given", () => {
      const r = new SchemaRegistry({ allowLatestFallback: false })
        .register(schemaAdapterV1);
      expect(() => r.resolveOrLatest(undefined)).toThrow(SchemaAdapterError);
    });
  });

  describe("toWire", () => {
    it("serialises to the specified version", () => {
      const wire = freshRegistry().toWire(baseMessage({ schemaVersion: 1 }), 1);
      expect(wire.schemaVersion).toBe(1);
    });

    it("defaults to the latest version when none specified", () => {
      const wire = freshRegistry().toWire(baseMessage({ schemaVersion: 2 }));
      expect(wire.schemaVersion).toBe(2);
    });
  });

  describe("fromWire", () => {
    it("deserialises using the version embedded in the wire object", () => {
      const msg = freshRegistry().fromWire(v1Wire());
      expect(msg.schemaVersion).toBe(1);
    });

    it("falls back to latest when wire has no schemaVersion", () => {
      const wire: WireMessage = { messageId: "msg-001", sourceChainId: 101, destinationChainId: 109, sender: "0xS", recipient: "0xR", payload: "0x" };
      const msg = freshRegistry().fromWire(wire);
      expect(msg.schemaVersion).toBe(2); // latest
    });

    it("throws unknown-version for an unregistered version in wire", () => {
      expect(() => freshRegistry().fromWire(v1Wire({ schemaVersion: 99 }))).toThrow(SchemaAdapterError);
    });
  });

  describe("migrateToVersion", () => {
    it("migrates a v1 wire message to v2", () => {
      const upgraded = freshRegistry().migrateToVersion(v1Wire(), 2);
      expect(upgraded.schemaVersion).toBe(2);
    });

    it("returns the message unchanged when source === target version", () => {
      const wire = v1Wire();
      const result = freshRegistry().migrateToVersion(wire, 1);
      expect(result).toBe(wire); // same reference
    });

    it("throws downgrade-not-supported when target < current version", () => {
      expect(() => freshRegistry().migrateToVersion(v2Wire(), 1)).toThrow(SchemaAdapterError);
      try { freshRegistry().migrateToVersion(v2Wire(), 1); } catch (e) {
        expect((e as SchemaAdapterError).kind).toBe("downgrade-not-supported");
      }
    });

    it("throws unknown-version when target version is not registered", () => {
      expect(() => freshRegistry().migrateToVersion(v1Wire(), 99)).toThrow(SchemaAdapterError);
    });

    it("throws missing-field when wire has no schemaVersion", () => {
      const wire: WireMessage = { messageId: "x" };
      expect(() => freshRegistry().migrateToVersion(wire, 2)).toThrow(SchemaAdapterError);
    });
  });

  describe("migrateToLatest", () => {
    it("migrates a v1 message to the latest registered version", () => {
      const upgraded = freshRegistry().migrateToLatest(v1Wire());
      expect(upgraded.schemaVersion).toBe(2);
    });

    it("is a no-op when wire is already at the latest version", () => {
      const wire = v2Wire();
      const result = freshRegistry().migrateToLatest(wire);
      expect(result).toBe(wire);
    });
  });

  describe("introspection", () => {
    it("registeredVersions returns sorted ascending list", () => {
      expect(freshRegistry().registeredVersions()).toEqual([1, 2]);
    });

    it("latestVersion returns the highest version", () => {
      expect(freshRegistry().latestVersion()).toBe(2);
    });

    it("latestVersion returns null for empty registry", () => {
      expect(new SchemaRegistry().latestVersion()).toBeNull();
    });

    it("isRegistered returns true for registered versions", () => {
      const r = freshRegistry();
      expect(r.isRegistered(1)).toBe(true);
      expect(r.isRegistered(2)).toBe(true);
      expect(r.isRegistered(3)).toBe(false);
    });
  });

  describe("custom adapter registration", () => {
    it("accepts a third-party adapter for an unknown version", () => {
      const customAdapter: MessageSchemaAdapter = {
        schemaVersion: 3,
        toWire: (m) => ({ schemaVersion: 3, ...m }),
        fromWire: (w) => ({
          messageId: String(w.messageId ?? ""),
          sourceChainId: Number(w.sourceChainId),
          destinationChainId: Number(w.destinationChainId),
          sender: String(w.sender ?? ""),
          recipient: String(w.recipient ?? ""),
          payload: String(w.payload ?? "0x"),
          schemaVersion: 3,
        }),
        migrateFromPrevious: (prev) => ({ ...prev, schemaVersion: 3 }),
      };

      const r = freshRegistry().register(customAdapter);
      expect(r.isRegistered(3)).toBe(true);
      expect(r.latestVersion()).toBe(3);

      const upgraded = r.migrateToLatest(v1Wire());
      expect(upgraded.schemaVersion).toBe(3);
    });
  });
});

// ─── Simulated dependency failures ───────────────────────────────────────────

describe("simulated dependency failures", () => {
  it("registry remains functional after a failed resolve", () => {
    const r = new SchemaRegistry().register(schemaAdapterV1);
    expect(() => r.resolve(99)).toThrow(SchemaAdapterError);
    // Registry must still work for valid version
    expect(r.resolve(1).schemaVersion).toBe(1);
  });

  it("registry remains functional after a failed migration", () => {
    const r = new SchemaRegistry().register(schemaAdapterV1).register(schemaAdapterV2);
    expect(() => r.migrateToVersion(v2Wire(), 1)).toThrow(SchemaAdapterError);
    // Should still migrate v1→v2 correctly
    expect(r.migrateToVersion(v1Wire(), 2).schemaVersion).toBe(2);
  });

  it("adapter toWire failure does not corrupt the adapter singleton", () => {
    expect(() => schemaAdapterV1.toWire(baseMessage({ schemaVersion: 2 }))).toThrow(SchemaAdapterError);
    // Singleton must still work for valid input
    const wire = schemaAdapterV1.toWire(baseMessage({ schemaVersion: 1 }));
    expect(wire.schemaVersion).toBe(1);
  });
});

// ─── defaultSchemaRegistry ────────────────────────────────────────────────────

describe("defaultSchemaRegistry", () => {
  it("has v1 and v2 registered", () => {
    expect(defaultSchemaRegistry.isRegistered(1)).toBe(true);
    expect(defaultSchemaRegistry.isRegistered(2)).toBe(true);
  });

  it("latest version is 2", () => {
    expect(defaultSchemaRegistry.latestVersion()).toBe(2);
  });

  it("can round-trip a v1 message", () => {
    const wire = defaultSchemaRegistry.toWire(baseMessage({ schemaVersion: 1 }), 1);
    const msg = defaultSchemaRegistry.fromWire(wire);
    expect(msg.schemaVersion).toBe(1);
    expect(msg.messageId).toBe("msg-001");
  });

  it("can round-trip a v2 message with extension fields", () => {
    const m = Object.assign(baseMessage({ schemaVersion: 2 }), { gasLimit: 150000, memo: "note" });
    const wire = defaultSchemaRegistry.toWire(m, 2);
    const msg = defaultSchemaRegistry.fromWire(wire) as EncodableMessage & { gasLimit?: number; memo?: string };
    expect(msg.schemaVersion).toBe(2);
    expect(msg.gasLimit).toBe(150000);
    expect(msg.memo).toBe("note");
  });

  it("full migration pipeline: v1 wire → migrate → v2 decode → re-encode", () => {
    const wire1 = v1Wire({ nonce: 42 });
    const wire2 = defaultSchemaRegistry.migrateToLatest(wire1);
    const msg = defaultSchemaRegistry.fromWire(wire2);
    expect(msg.schemaVersion).toBe(2);
    expect(msg.nonce).toBe(42);
    const reEncoded = defaultSchemaRegistry.toWire(msg, 2);
    expect(reEncoded.schemaVersion).toBe(2);
    expect(reEncoded.nonce).toBe(42);
  });
});

// ─── SchemaAdapterError ──────────────────────────────────────────────────────

describe("SchemaAdapterError", () => {
  it("name is 'SchemaAdapterError'", () => {
    const e = new SchemaAdapterError("unknown-version", "test");
    expect(e.name).toBe("SchemaAdapterError");
  });

  it("exposes kind", () => {
    const e = new SchemaAdapterError("duplicate-version", "test");
    expect(e.kind).toBe("duplicate-version");
  });

  it("message is human-readable", () => {
    const e = new SchemaAdapterError("missing-field", "field X is required");
    expect(e.message).toContain("field X is required");
  });
});

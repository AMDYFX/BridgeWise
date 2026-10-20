/**
 * Built-in versioned message schema adapters.
 *
 * v1 — baseline schema (all required fields, no optional extensions)
 * v2 — adds `gasLimit` and `memo` optional fields; backward-compatible with v1
 *
 * Both adapters are stateless singletons.  New versions follow the same
 * pattern: implement `MessageSchemaAdapter`, register via `SchemaRegistry`.
 */

import type { EncodableMessage } from "../payload-encoding/types";
import {
  MessageSchemaAdapter,
  SchemaAdapterError,
  WireMessage,
} from "./types";

// ─── Shared validation helpers ────────────────────────────────────────────────

function requireString(wire: WireMessage, field: string, version: number): string {
  const v = wire[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw new SchemaAdapterError(
      "missing-field",
      `v${version} wire message is missing required string field "${field}"`,
    );
  }
  return v as string;
}

function requireNumber(wire: WireMessage, field: string, version: number): number {
  const v = wire[field];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new SchemaAdapterError(
      "missing-field",
      `v${version} wire message is missing required numeric field "${field}"`,
    );
  }
  return v as number;
}

function optionalNumber(wire: WireMessage, field: string): number | undefined {
  const v = wire[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return v as number;
}

function optionalString(wire: WireMessage, field: string): string | undefined {
  const v = wire[field];
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "string" ? v : undefined;
}

// ─── Schema v1 adapter ────────────────────────────────────────────────────────

/**
 * v1 wire format:
 * {
 *   schemaVersion: 1,
 *   messageId: string,
 *   sourceChainId: number,
 *   destinationChainId: number,
 *   sender: string,
 *   recipient: string,
 *   payload: string,
 *   nonce?: number,
 * }
 */
export class SchemaAdapterV1 implements MessageSchemaAdapter {
  readonly schemaVersion = 1;

  toWire(message: EncodableMessage): WireMessage {
    this.assertCompatible(message);
    const wire: WireMessage = {
      schemaVersion: 1,
      messageId: message.messageId,
      sourceChainId: message.sourceChainId,
      destinationChainId: message.destinationChainId,
      sender: message.sender,
      recipient: message.recipient,
      payload: message.payload,
    };
    if (message.nonce !== undefined) wire.nonce = message.nonce;
    return wire;
  }

  fromWire(wire: WireMessage): EncodableMessage {
    const messageId       = requireString(wire, "messageId", 1);
    const sourceChainId   = requireNumber(wire, "sourceChainId", 1);
    const destinationChainId = requireNumber(wire, "destinationChainId", 1);
    const sender          = requireString(wire, "sender", 1);
    const recipient       = requireString(wire, "recipient", 1);
    const payload         = requireString(wire, "payload", 1);
    const nonce           = optionalNumber(wire, "nonce");

    return {
      messageId,
      sourceChainId,
      destinationChainId,
      sender,
      recipient,
      payload,
      ...(nonce !== undefined ? { nonce } : {}),
      schemaVersion: 1,
    };
  }

  /** v1 has no predecessor. */
  migrateFromPrevious(_previous: WireMessage): null {
    return null;
  }

  private assertCompatible(message: EncodableMessage): void {
    if (message.schemaVersion !== undefined && message.schemaVersion !== 1) {
      throw new SchemaAdapterError(
        "invalid-field",
        `SchemaAdapterV1 cannot serialise a message with schemaVersion=${message.schemaVersion}`,
      );
    }
  }
}

// ─── Schema v2 adapter ────────────────────────────────────────────────────────

/**
 * v2 wire format (backward-compatible superset of v1):
 * {
 *   schemaVersion: 2,
 *   messageId: string,
 *   sourceChainId: number,
 *   destinationChainId: number,
 *   sender: string,
 *   recipient: string,
 *   payload: string,
 *   nonce?: number,
 *   gasLimit?: number,   ← new in v2
 *   memo?: string,       ← new in v2
 * }
 *
 * Migration from v1: gasLimit defaults to undefined, memo defaults to undefined.
 */
export class SchemaAdapterV2 implements MessageSchemaAdapter {
  readonly schemaVersion = 2;

  toWire(message: EncodableMessage): WireMessage {
    this.assertCompatible(message);
    const wire: WireMessage = {
      schemaVersion: 2,
      messageId: message.messageId,
      sourceChainId: message.sourceChainId,
      destinationChainId: message.destinationChainId,
      sender: message.sender,
      recipient: message.recipient,
      payload: message.payload,
    };
    if (message.nonce !== undefined) wire.nonce = message.nonce;
    // v2 extension fields — carried through the EncodableMessage extensions map
    const ext = (message as EncodableMessage & { gasLimit?: number; memo?: string });
    if (ext.gasLimit !== undefined) wire.gasLimit = ext.gasLimit;
    if (ext.memo !== undefined) wire.memo = ext.memo;
    return wire;
  }

  fromWire(wire: WireMessage): EncodableMessage {
    const messageId          = requireString(wire, "messageId", 2);
    const sourceChainId      = requireNumber(wire, "sourceChainId", 2);
    const destinationChainId = requireNumber(wire, "destinationChainId", 2);
    const sender             = requireString(wire, "sender", 2);
    const recipient          = requireString(wire, "recipient", 2);
    const payload            = requireString(wire, "payload", 2);
    const nonce              = optionalNumber(wire, "nonce");
    const gasLimit           = optionalNumber(wire, "gasLimit");
    const memo               = optionalString(wire, "memo");

    const msg: EncodableMessage & { gasLimit?: number; memo?: string } = {
      messageId,
      sourceChainId,
      destinationChainId,
      sender,
      recipient,
      payload,
      schemaVersion: 2,
    };
    if (nonce     !== undefined) msg.nonce     = nonce;
    if (gasLimit  !== undefined) msg.gasLimit  = gasLimit;
    if (memo      !== undefined) msg.memo      = memo;
    return msg;
  }

  /**
   * Migrate a v1 wire message to v2 by setting schemaVersion=2.
   * v2-only fields (gasLimit, memo) are left absent — callers may populate them.
   */
  migrateFromPrevious(previous: WireMessage): WireMessage {
    if (previous.schemaVersion !== 1) {
      throw new SchemaAdapterError(
        "migration-not-supported",
        `SchemaAdapterV2.migrateFromPrevious expects schemaVersion=1, got ${previous.schemaVersion}`,
      );
    }
    return { ...previous, schemaVersion: 2 };
  }

  private assertCompatible(message: EncodableMessage): void {
    if (message.schemaVersion !== undefined && message.schemaVersion !== 2) {
      throw new SchemaAdapterError(
        "invalid-field",
        `SchemaAdapterV2 cannot serialise a message with schemaVersion=${message.schemaVersion}`,
      );
    }
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────────

export const schemaAdapterV1 = new SchemaAdapterV1();
export const schemaAdapterV2 = new SchemaAdapterV2();

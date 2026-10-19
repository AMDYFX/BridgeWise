/**
 * File: src/release/compatibility-gate/contract-abi-compatibility.ts
 *
 * Contract-level half of the release compatibility gate (#1384).
 *
 * Compares a baseline contract ABI against a candidate ABI and reports every
 * change that can break an existing consumer — an integration contract in
 * the same sense as the OpenAPI document: callers sign selectors, decode
 * outputs, and index events, so any of those changing is a break.
 *
 * Classification (upgrade implications):
 *   - breaking:  a previously-valid external interaction stops working or
 *                 silently changes meaning — removed/renamed functions,
 *                 changed inputs (new selector), changed outputs (decode
 *                 failure), removed payable, changed event signatures
 *                 (indexer breakage), changed constructor args (deploy and
 *                 upgrade scripts), removed contract.
 *   - warning:   still callable but semantics move under callers — view/pure
 *                 becoming state-changing, removed custom errors (clients
 *                 can no longer decode the revert), fallback changes.
 *   - info:      additive-only changes — new functions/events/errors, added
 *                 payable, nonpayable→view, contract additions.
 *
 * Gas/resource impact: the gate is a static, off-chain check — it reads ABIs
 * and never submits transactions, so it consumes no gas and changes no
 * on-chain state. Deployed bytecode is accepted as evidence and compared for
 * equality only; bytecode churn is expected and never gates a release.
 *
 * Untrusted input: ABIs are validated entry by entry. A malformed artifact
 * fails closed with {@link CompatibilityGateError} — it is never skipped,
 * because a skipped contract is an unaudited contract.
 */

import { CompatibilityGateError } from './release-compatibility-gate.types';
import type { GateChange } from './release-compatibility-gate.types';

type Json = Record<string, unknown>;

const FUNCTION_TYPES = [
  'function',
  'constructor',
  'event',
  'error',
  'fallback',
  'receive',
] as const;
type AbiEntryType = (typeof FUNCTION_TYPES)[number];

interface NormalizedParam {
  readonly name: string;
  readonly type: string;
  readonly indexed?: boolean;
}

interface NormalizedEntry {
  readonly type: AbiEntryType;
  readonly name: string;
  readonly inputs: readonly NormalizedParam[];
  readonly outputs: readonly NormalizedParam[];
  readonly stateMutability: string;
  readonly anonymous: boolean;
}

interface NormalizedAbi {
  readonly contract: string;
  readonly functions: ReadonlyMap<string, NormalizedEntry>;
  /** Functions keyed by bare name — used to detect re-typed overloads. */
  readonly functionsByName: ReadonlyMap<string, NormalizedEntry[]>;
  readonly events: ReadonlyMap<string, NormalizedEntry>;
  readonly errors: ReadonlyMap<string, NormalizedEntry>;
  readonly constructors: NormalizedEntry[];
  readonly fallbacks: NormalizedEntry[];
  readonly bytecode?: string;
}

/** Max ABI entries accepted from an untrusted artifact. */
const MAX_ABI_ENTRIES = 2000;

/**
 * Extract and validate a normalized ABI from an untrusted artifact.
 * Accepts either a bare ABI array or an artifact object with an `abi` array
 * (Hardhat/Foundry style) plus optional `bytecode`.
 */
export function normalizeContractAbi(
  contract: string,
  artifact: unknown,
  baselineBytecode?: string,
  candidateBytecode?: string,
): NormalizedAbi {
  if (!contract || typeof contract !== 'string' || !contract.trim()) {
    malformedArtifact(contract, 'contract name must be a non-empty string');
  }
  const trimmedContract = contract.trim();

  let rawAbi: unknown;
  let bytecode: string | undefined;
  if (Array.isArray(artifact)) {
    rawAbi = artifact;
    bytecode =
      typeof candidateBytecode === 'string' ? candidateBytecode : undefined;
  } else if (isObject(artifact)) {
    rawAbi = artifact.abi;
    const rawBytecode = artifact.bytecode;
    bytecode =
      typeof candidateBytecode === 'string'
        ? candidateBytecode
        : typeof rawBytecode === 'string'
          ? rawBytecode
          : undefined;
  } else {
    malformedArtifact(
      contract,
      'artifact must be an ABI array or an object with an `abi` array',
    );
  }

  if (!Array.isArray(rawAbi))
    malformedArtifact(contract, '`abi` must be an array');
  if (rawAbi.length > MAX_ABI_ENTRIES) {
    malformedArtifact(contract, `ABI has more than ${MAX_ABI_ENTRIES} entries`);
  }

  // Narrowing above is done with direct throws; the alias below carries the
  // same fail-closed behavior into the entry loop and the param helpers.
  const malformed = (message: string): never =>
    malformedArtifact(contract, message);

  const functions = new Map<string, NormalizedEntry>();
  const functionsByName = new Map<string, NormalizedEntry[]>();
  const events = new Map<string, NormalizedEntry>();
  const errors = new Map<string, NormalizedEntry>();
  const constructors: NormalizedEntry[] = [];
  const fallbacks: NormalizedEntry[] = [];

  rawAbi.forEach((raw, index) => {
    const at = `abi[${index}]`;
    if (!isObject(raw)) malformed(`${at} must be an object`);

    const entry = raw as Json;
    const type = entry.type;
    if (
      typeof type !== 'string' ||
      !(FUNCTION_TYPES as readonly string[]).includes(type)
    ) {
      malformed(`${at}.type must be one of ${FUNCTION_TYPES.join(', ')}`);
    }
    const entryType = type as AbiEntryType;

    const name =
      entryType === 'constructor' ||
      entryType === 'fallback' ||
      entryType === 'receive'
        ? entryType
        : readName(entry, at, malformed);

    const inputs = readParams(entry.inputs, `${at}.inputs`, malformed);
    const outputs =
      entryType === 'function' || entryType === 'error'
        ? readParams(entry.outputs, `${at}.outputs`, malformed)
        : [];
    const stateMutability = readMutability(entry, entryType, at, malformed);
    const anonymous = entryType === 'event' ? entry.anonymous === true : false;

    const normalized: NormalizedEntry = {
      type: entryType,
      name,
      inputs,
      outputs,
      stateMutability,
      anonymous,
    };

    switch (entryType) {
      case 'function': {
        const signature = signatureOf(name, inputs);
        if (functions.has(signature)) {
          malformed(`${at} duplicates function signature ${signature}`);
        }
        functions.set(signature, normalized);
        const byName = functionsByName.get(name) ?? [];
        byName.push(normalized);
        functionsByName.set(name, byName);
        break;
      }
      case 'event': {
        const signature = signatureOf(name, inputs);
        if (events.has(signature))
          malformed(`${at} duplicates event signature ${signature}`);
        events.set(signature, normalized);
        break;
      }
      case 'error': {
        const signature = signatureOf(name, inputs);
        if (errors.has(signature))
          malformed(`${at} duplicates error signature ${signature}`);
        errors.set(signature, normalized);
        break;
      }
      case 'constructor':
        constructors.push(normalized);
        break;
      case 'fallback':
      case 'receive':
        fallbacks.push(normalized);
        break;
    }
  });

  return {
    contract: trimmedContract,
    functions,
    functionsByName,
    events,
    errors,
    constructors,
    fallbacks,
    bytecode: bytecode ?? baselineBytecode,
  };
}

/**
 * Diff a normalized baseline/candidate pair into severity-classified changes.
 * Pure and deterministic: the same inputs always produce the same findings.
 */
export function diffContractAbis(
  baseline: NormalizedAbi,
  candidate: NormalizedAbi,
): GateChange[] {
  const changes: GateChange[] = [];
  const contract = candidate.contract;
  const at = (section: string, key: string) =>
    key
      ? `contracts.${contract}.${section}.${key}`
      : `contracts.${contract}.${section}`;
  const retypedFunctions = new Set<string>();
  const removedEvents = new Set<string>();
  const add = (
    rule: string,
    severity: GateChange['severity'],
    message: string,
    location: string,
  ) => changes.push({ rule, severity, message, location });

  // ── Functions ─────────────────────────────────────────────────────────────
  for (const [signature, baseFn] of baseline.functions) {
    const candFn = candidate.functions.get(signature);
    if (!candFn) {
      // Maybe the same function was re-typed (selector change) — say so.
      const sameName = candidate.functionsByName.get(baseFn.name) ?? [];
      if (sameName.length > 0) {
        const newSignature = signatureOf(sameName[0].name, sameName[0].inputs);
        retypedFunctions.add(newSignature);
        add(
          'function-inputs-changed',
          'breaking',
          `Function ${baseFn.name} changed inputs: ${signature} → ${newSignature}; the old selector no longer exists.`,
          at('functions', signature),
        );
      } else {
        add(
          'function-removed',
          'breaking',
          `Function ${baseFn.name} was removed; existing callers of ${signature} will revert.`,
          at('functions', signature),
        );
      }
      continue;
    }

    if (paramsKey(baseFn.outputs) !== paramsKey(candFn.outputs)) {
      add(
        'function-outputs-changed',
        'breaking',
        `Function ${baseFn.name} changed outputs; existing callers will fail to decode the result.`,
        at('functions', `${signature}.outputs`),
      );
    }

    const mutability = mutabilityChange(
      baseFn.stateMutability,
      candFn.stateMutability,
    );
    if (mutability)
      add(
        mutability.rule,
        mutability.severity,
        mutability.message(baseFn.name),
        at('functions', `${signature}.stateMutability`),
      );
  }

  for (const [signature, candFn] of candidate.functions) {
    if (
      !baseline.functions.has(signature) &&
      !retypedFunctions.has(signature)
    ) {
      add(
        'function-added',
        'info',
        `New function ${candFn.name} (${signature}).`,
        at('functions', signature),
      );
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────
  for (const [signature, baseEvent] of baseline.events) {
    const candEvent = candidate.events.get(signature);
    if (!candEvent) {
      const sameName = [...candidate.events.values()].filter(
        (event) => event.name === baseEvent.name,
      );
      if (sameName.length > 0) {
        removedEvents.add(signature);
        add(
          'event-inputs-changed',
          'breaking',
          `Event ${baseEvent.name} changed its signature; indexers decoding ${signature} will break.`,
          at('events', signature),
        );
      } else {
        add(
          'event-removed',
          'breaking',
          `Event ${baseEvent.name} was removed; indexers and relayers listening for ${signature} will stop receiving it.`,
          at('events', signature),
        );
      }
      continue;
    }
    if (baseEvent.anonymous !== candEvent.anonymous) {
      add(
        'event-anonymous-changed',
        'breaking',
        `Event ${baseEvent.name} changed its anonymous flag; log topics will not line up.`,
        at('events', `${signature}.anonymous`),
      );
    }
  }

  for (const [signature, candEvent] of candidate.events) {
    if (!baseline.events.has(signature) && !removedEvents.has(signature)) {
      add(
        'event-added',
        'info',
        `New event ${candEvent.name} (${signature}).`,
        at('events', signature),
      );
    }
  }

  // ── Custom errors ─────────────────────────────────────────────────────────
  for (const [signature, baseError] of baseline.errors) {
    if (!candidate.errors.has(signature)) {
      add(
        'error-removed',
        'warning',
        `Custom error ${baseError.name} was removed; clients matching on ${signature} will see a generic revert.`,
        at('errors', signature),
      );
    }
  }
  for (const [signature, candError] of candidate.errors) {
    if (!baseline.errors.has(signature)) {
      add(
        'error-added',
        'info',
        `New custom error ${candError.name} (${signature}).`,
        at('errors', signature),
      );
    }
  }

  // ── Constructor (deploy and upgrade scripts) ─────────────────────────────
  const baseCtor = baseline.constructors[0];
  const candCtor = candidate.constructors[0];
  if (baseCtor && !candCtor) {
    add(
      'constructor-removed',
      'breaking',
      'The contract no longer declares a constructor; deployment scripts passing arguments will fail.',
      at('constructor', ''),
    );
  } else if (!baseCtor && candCtor) {
    add(
      'constructor-added',
      'warning',
      'A constructor was added; deployment and upgrade scripts must pass its arguments.',
      at('constructor', ''),
    );
  } else if (
    baseCtor &&
    candCtor &&
    paramsKey(baseCtor.inputs) !== paramsKey(candCtor.inputs)
  ) {
    add(
      'constructor-inputs-changed',
      'breaking',
      'Constructor arguments changed; existing deployment and upgrade scripts will fail.',
      at('constructor', 'inputs'),
    );
  }

  // ── Fallback / receive ───────────────────────────────────────────────────
  const baseFallback = fallbackKey(baseline.fallbacks);
  const candFallback = fallbackKey(candidate.fallbacks);
  if (baseFallback !== candFallback) {
    add(
      'fallback-changed',
      baseFallback === '' || candFallback === '' ? 'warning' : 'warning',
      baseFallback === ''
        ? 'A fallback/receive function was added; plain transfers now execute code.'
        : candFallback === ''
          ? 'The fallback/receive function was removed; plain transfers will revert.'
          : 'The fallback/receive mutability changed.',
      at('fallback', ''),
    );
  }

  return changes;
}

/** Entry point used by the gate: validate + diff in one call. */
export function checkContractCompatibility(
  contract: string,
  baselineArtifact: unknown,
  candidateArtifact: unknown,
  extra: { baselineBytecode?: string; candidateBytecode?: string } = {},
): GateChange[] {
  const baseline = normalizeContractAbi(
    contract,
    baselineArtifact,
    extra.baselineBytecode,
    undefined,
  );
  const candidate = normalizeContractAbi(
    contract,
    candidateArtifact,
    undefined,
    extra.candidateBytecode,
  );
  return diffContractAbis(baseline, candidate);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type Malformed = (message: string) => never;

/**
 * Fail closed: a malformed artifact is rejected, never skipped — a skipped
 * contract would be an unaudited contract.
 */
function malformedArtifact(contract: string, message: string): never {
  throw new CompatibilityGateError(
    'MALFORMED_CONTRACT_ARTIFACT',
    `contract "${contract}": ${message}`,
  );
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readName(entry: Json, at: string, malformed: Malformed): string {
  const name = entry.name;
  if (typeof name !== 'string' || !name.trim()) {
    malformed(`${at}.name must be a non-empty string`);
  }
  return name.trim();
}

function readParams(
  raw: unknown,
  at: string,
  malformed: Malformed,
): NormalizedParam[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) malformed(`${at} must be an array`);
  if (raw.length > 256) malformed(`${at} has more than 256 parameters`);

  return raw.map((param, index) => {
    const where = `${at}[${index}]`;
    if (!isObject(param)) malformed(`${where} must be an object`);
    const type = param.type;
    if (typeof type !== 'string' || !type.trim())
      malformed(`${where}.type must be a non-empty string`);
    const normalizedType = expandType(
      type.trim(),
      param.components,
      where,
      malformed,
    );
    const name = typeof param.name === 'string' ? param.name.trim() : '';
    const indexed = param.indexed === true ? true : undefined;
    return { name, type: normalizedType, indexed };
  });
}

/**
 * Canonicalize a parameter type. Solidity tuples arrive as `type: 'tuple'`
 * with a `components` array; inline forms like `(uint256,address)` are also
 * accepted. Both are flattened to the same canonical shape so two ABIs
 * describing the same tuple compare equal.
 */
function expandType(
  type: string,
  components: unknown,
  at: string,
  malformed: Malformed,
): string {
  if (type === 'tuple' || type.startsWith('tuple[')) {
    if (!Array.isArray(components) || components.length === 0) {
      malformed(
        `${at}.type "${type}" requires a non-empty \`components\` array`,
      );
    }
    const inner = components.map((component, index) => {
      if (!isObject(component))
        malformed(`${at}.components[${index}] must be an object`);
      const componentType = component.type;
      if (typeof componentType !== 'string' || !componentType.trim()) {
        malformed(`${at}.components[${index}].type must be a non-empty string`);
      }
      return expandType(
        componentType.trim(),
        component.components,
        `${at}.components[${index}]`,
        malformed,
      );
    });
    return `(${inner.join(',')})${type.slice('tuple'.length)}`;
  }
  return normalizeType(type, at, malformed);
}

/** Expand inline tuple types into the canonical signature form. */
function normalizeType(type: string, at: string, malformed: Malformed): string {
  if (type.includes('(')) {
    // Canonical form for tuples: (type1,type2) with arrays suffix-preserved.
    const match = /^(.*)\((.*)\)(.*)$/.exec(type);
    if (!match) malformed(`${at}.type "${type}" is not a valid tuple type`);
    const inner = match[2]
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (inner.length === 0)
      malformed(`${at}.type "${type}" has an empty tuple`);
    return `${match[1]}(${inner.join(',')})${match[3]}`;
  }
  if (!/^[a-zA-Z0-9_[\]]+$/.test(type)) {
    malformed(`${at}.type "${type}" contains unsupported characters`);
  }
  return type;
}

function readMutability(
  entry: Json,
  type: AbiEntryType,
  at: string,
  malformed: Malformed,
): string {
  if (type !== 'function' && type !== 'fallback' && type !== 'receive')
    return 'nonpayable';
  const value = entry.stateMutability;
  if (value === undefined) {
    // Legacy ABI format: derive from constant/payable flags.
    if (entry.constant === true) return 'view';
    return entry.payable === true ? 'payable' : 'nonpayable';
  }
  if (
    typeof value !== 'string' ||
    !['pure', 'view', 'nonpayable', 'payable'].includes(value)
  ) {
    malformed(`${at}.stateMutability must be pure|view|nonpayable|payable`);
  }
  return value;
}

function signatureOf(name: string, inputs: readonly NormalizedParam[]): string {
  return `${name}(${inputs.map((input) => input.type).join(',')})`;
}

function paramsKey(params: readonly NormalizedParam[]): string {
  return params
    .map((param) => `${param.type}:${param.indexed === true}`)
    .join('|');
}

function fallbackKey(entries: readonly NormalizedEntry[]): string {
  return entries
    .map((entry) => `${entry.name}:${entry.stateMutability}`)
    .sort()
    .join('|');
}

function mutabilityChange(
  from: string,
  to: string,
):
  | {
      rule: string;
      severity: GateChange['severity'];
      message: (name: string) => string;
    }
  | undefined {
  if (from === to) return undefined;

  const wasPayable = from === 'payable';
  const isPayable = to === 'payable';
  if (wasPayable && !isPayable) {
    return {
      rule: 'function-payable-removed',
      severity: 'breaking',
      message: (name) =>
        `Function ${name} is no longer payable; value-sending calls to it will revert.`,
    };
  }
  if (!wasPayable && isPayable) {
    return {
      rule: 'function-payable-added',
      severity: 'info',
      message: (name) => `Function ${name} now accepts value.`,
    };
  }

  const wasRead = from === 'view' || from === 'pure';
  const isRead = to === 'view' || to === 'pure';
  if (wasRead && !isRead) {
    return {
      rule: 'function-mutability-relaxed',
      severity: 'warning',
      message: (name) =>
        `Function ${name} changed from ${from} to ${to}; clients that treated it as read-only will now send transactions.`,
    };
  }
  if (!wasRead && isRead) {
    return {
      rule: 'function-mutability-tightened',
      severity: 'info',
      message: (name) =>
        `Function ${name} changed from ${from} to ${to}; calls remain valid.`,
    };
  }
  return {
    rule: 'function-mutability-changed',
    severity: 'info',
    message: (name) => `Function ${name} changed from ${from} to ${to}.`,
  };
}

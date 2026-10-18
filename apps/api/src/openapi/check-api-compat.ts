#!/usr/bin/env node
/**
 * CLI for OpenAPI backward compatibility checking.
 *
 *   node dist/openapi/check-api-compat.js <baseline.json> <current.json>
 *        [--allow-deprecated-removal] [--allow-major-bump] [--strict]
 *
 * Exits non-zero when the current spec would break clients built against the
 * baseline, so it can gate CI.
 *
 *   0  compatible
 *   1  incompatible (breaking changes, or warnings under --strict)
 *   2  usage or parse failure
 */
import {
  checkBackwardCompatibility,
  formatCompatibilityReport,
  type CompatibilityOptions,
} from './openapi-compatibility-checker';
import { loadSpec } from './validate-openapi';

interface ParsedArgs {
  baselinePath?: string;
  currentPath?: string;
  options: CompatibilityOptions;
  unknownFlags: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const options: CompatibilityOptions = {};
  const positional: string[] = [];
  const unknownFlags: string[] = [];

  for (const arg of argv) {
    if (arg === '--allow-deprecated-removal') {
      options.allowDeprecatedRemoval = true;
    } else if (arg === '--allow-major-bump') {
      options.allowBreakingOnMajorBump = true;
    } else if (arg === '--strict') {
      options.strictWarnings = true;
    } else if (arg.startsWith('--')) {
      unknownFlags.push(arg);
    } else {
      positional.push(arg);
    }
  }

  return {
    baselinePath: positional[0],
    currentPath: positional[1],
    options,
    unknownFlags,
  };
}

/* istanbul ignore next — entry point, exercised via the exported helpers. */
function main(): void {
  const { baselinePath, currentPath, options, unknownFlags } = parseArgs(
    process.argv.slice(2),
  );

  if (!baselinePath || !currentPath || unknownFlags.length > 0) {
    if (unknownFlags.length > 0) {
      process.stderr.write(`Unknown option(s): ${unknownFlags.join(', ')}\n`);
    }
    process.stderr.write(
      'Usage: check-api-compat <baseline.json> <current.json> [--allow-deprecated-removal] [--allow-major-bump] [--strict]\n',
    );
    process.exit(2);
    return;
  }

  let baseline: unknown;
  let current: unknown;
  try {
    baseline = loadSpec(baselinePath);
    current = loadSpec(currentPath);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
    return;
  }

  const report = checkBackwardCompatibility(baseline, current, options);
  process.stdout.write(formatCompatibilityReport(report));
  process.exit(report.compatible ? 0 : 1);
}

/* istanbul ignore next */
if (require.main === module) {
  main();
}

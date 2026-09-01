import { DuplicateRegistrationError, ValidationError } from "./errors.js";

const SEGMENT = /^[a-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$/;
const RESERVED = new Set(["embody"]);

export function parseTarget(target: string): readonly string[] {
  if (target.length === 0 || target.length > 200) throw new ValidationError("Invalid target");
  const segments = target.split(".");
  if (segments.length < 2 || segments.some((segment) => !isValidSegment(segment))) {
    throw new ValidationError("Invalid target");
  }
  return segments;
}

export function formatTarget(segments: readonly string[]): string {
  const target = segments.join(".");
  parseTarget(target);
  return target;
}

function isValidSegment(segment: string): boolean {
  return SEGMENT.test(segment) && !segment.startsWith("__") && !RESERVED.has(segment);
}

function snakeCase(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/-/g, "_")
    .toLowerCase();
}

export function targetToMcpName(
  target: string,
  options: { readonly appId: string; readonly scoped: boolean },
): string {
  const mapped = parseTarget(target).map(snakeCase).join("_");
  if (options.scoped) return mapped;
  if (!SEGMENT.test(options.appId)) throw new ValidationError("Invalid app ID");
  return `${snakeCase(options.appId)}__${mapped}`;
}

export function assertUniqueMappedTargets(targets: readonly string[]): void {
  const owners = new Map<string, string>();
  for (const target of targets) {
    const mapped = parseTarget(target).map(snakeCase).join("_");
    const owner = owners.get(mapped);
    if (owner !== undefined) {
      throw new DuplicateRegistrationError(
        `MCP target collision: ${JSON.stringify(owner)} and ${JSON.stringify(target)} both map to ${JSON.stringify(mapped)}`,
      );
    }
    owners.set(mapped, target);
  }
}

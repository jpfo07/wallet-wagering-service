import { InvariantViolationError } from "../shared/domain-error.ts";

/** Numbers and null are deliberately absent: money is always a string, and `1` vs `1.0` is ambiguous. */
export type CanonicalJsonValue =
  | string
  | boolean
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue | undefined };

export class CanonicalJsonError extends InvariantViolationError {
  constructor(path: string, kind: string) {
    super("CANONICAL_JSON_UNSUPPORTED_VALUE", `unsupported ${kind} at ${path} in canonical JSON`);
  }
}

/**
 * Canonical JSON: object keys sorted recursively (UTF-16 code unit order, the default JS sort), no
 * whitespace, strings escaped by JSON.stringify, undefined object properties omitted. Only plain
 * objects, arrays, strings and booleans are accepted.
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      if (item === undefined) {
        throw new CanonicalJsonError(`${path}[${index}]`, "undefined array item");
      }
      items.push(serialize(item, `${path}[${index}]`));
    }
    return `[${items.join(",")}]`;
  }
  if (isPlainObject(value)) {
    const members = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(value[key], `${path}.${key}`)}`);
    return `{${members.join(",")}}`;
  }
  throw new CanonicalJsonError(path, describe(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return "non-plain object";
  }
  return typeof value;
}

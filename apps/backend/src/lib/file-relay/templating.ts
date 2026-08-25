import { getExposableSecretNames } from "./config";
import { FileRelayError } from "./errors";
import { StagedFile } from "./staging-store";

export type TemplateValue = string | number;
export type TemplateVars = Record<string, TemplateValue>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/;

/** Variables a destination may reference in its arguments. */
export function buildTemplateVars(file: StagedFile): TemplateVars {
  return {
    "file.handle": file.handle,
    "file.name": file.fileName,
    "file.mimeType": file.mimeType,
    "file.size": file.size,
    "file.sha256": file.sha256,
  };
}

/**
 * Resolve a single placeholder. `env.*` is served from an explicit allow-list
 * so a client cannot template arbitrary process secrets (a database URL, an
 * API key) into an outbound request.
 */
function resolvePlaceholder(key: string, vars: TemplateVars): TemplateValue {
  const direct = vars[key];
  if (direct !== undefined) {
    return direct;
  }

  if (key.startsWith("env.")) {
    const name = key.slice("env.".length);
    if (!getExposableSecretNames().includes(name)) {
      throw new FileRelayError(
        `Environment variable "${name}" is not exposed to the file relay. Add it to FILE_RELAY_SECRET_ENV to allow it.`,
      );
    }

    const value = process.env[name];
    if (value === undefined) {
      throw new FileRelayError(
        `Environment variable "${name}" is allow-listed but not set on the MetaMCP server.`,
      );
    }

    return value;
  }

  throw new FileRelayError(
    `Unknown template placeholder "{{${key}}}". Known placeholders: ${Object.keys(vars).join(", ")}, env.<ALLOWED_NAME>.`,
  );
}

/**
 * Substitute `{{...}}` placeholders throughout a JSON-ish structure. A string
 * consisting of exactly one placeholder adopts the placeholder's type, so
 * `"{{file.size}}"` reaches the destination tool as a number.
 */
export function interpolateDeep<T>(value: T, vars: TemplateVars): T {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_PLACEHOLDER);
    if (whole?.[1]) {
      return resolvePlaceholder(whole[1], vars) as unknown as T;
    }

    return value.replace(PLACEHOLDER, (_match, key: string) =>
      String(resolvePlaceholder(key, vars)),
    ) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => interpolateDeep(entry, vars)) as unknown as T;
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = interpolateDeep(entry, vars);
    }
    return result as unknown as T;
  }

  return value;
}

/**
 * Assign into a nested object using dot notation ("payload.file.data"), so a
 * destination tool that nests its content argument can still be targeted.
 */
export function setAtPath(
  target: Record<string, unknown>,
  dottedPath: string,
  value: unknown,
): void {
  const segments = dottedPath
    .split(".")
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    throw new FileRelayError("Argument path must not be empty.");
  }

  if (
    segments.some(
      (segment) =>
        segment === "__proto__" ||
        segment === "constructor" ||
        segment === "prototype",
    )
  ) {
    throw new FileRelayError(`Unsafe argument path: ${dottedPath}`);
  }

  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  const leaf = segments[segments.length - 1] as string;
  cursor[leaf] = value;
}

/** Read a nested value using the same dot notation as {@link setAtPath}. */
export function getAtPath(source: unknown, dottedPath: string): unknown {
  const segments = dottedPath
    .split(".")
    .filter((segment) => segment.length > 0);

  let cursor: unknown = source;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") {
      return undefined;
    }

    cursor = Array.isArray(cursor)
      ? cursor[Number.parseInt(segment, 10)]
      : (cursor as Record<string, unknown>)[segment];
  }

  return cursor;
}

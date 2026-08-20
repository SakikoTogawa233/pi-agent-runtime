export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function valueType(value: unknown): string {
  return value === null ? "null" : typeof value;
}

function failJson(path: string, detail: string): never {
  throw new TypeError(`JSON value at ${path} is unsupported: ${detail}`);
}

function assertArray(value: unknown[], path: string, ancestors: Set<object>): asserts value is JsonValue[] {
  const expectedKeys = Array.from({ length: value.length }, (_unused, index) => String(index));
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    failJson(path, "arrays must be dense and contain no extra properties");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length + 1 ||
    ownKeys.some((key) => key !== "length" && (typeof key !== "string" || !expectedKeys.includes(key)))
  ) {
    failJson(path, "arrays must contain only indexed JSON elements");
  }
  for (let index = 0; index < value.length; index += 1) {
    assertJsonValueAt(value[index], `${path}[${String(index)}]`, ancestors);
  }
}

function assertObject(
  value: Record<string, unknown>,
  path: string,
  ancestors: Set<object>,
): asserts value is { [key: string]: JsonValue } {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    failJson(path, "objects must have Object.prototype or null prototype");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") failJson(path, "symbol properties are not JSON properties");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      failJson(`${path}.${key}`, "properties must be enumerable data properties");
    }
    assertJsonValueAt(descriptor.value, `${path}.${key}`, ancestors);
  }
}

function assertJsonValueAt(value: unknown, path: string, ancestors: Set<object>): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) failJson(path, "numbers must be finite");
    return;
  }
  if (typeof value !== "object") failJson(path, `received ${valueType(value)}`);
  if (ancestors.has(value)) failJson(path, "cyclic references are not supported");
  ancestors.add(value);
  if (Array.isArray(value)) assertArray(value, path, ancestors);
  else assertObject(value as Record<string, unknown>, path, ancestors);
  ancestors.delete(value);
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  assertJsonValueAt(value, "$", new Set<object>());
}

export function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key] as JsonValue)]),
  );
}

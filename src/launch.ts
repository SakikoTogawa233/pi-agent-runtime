import {
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { Stats } from "node:fs";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PiLaunchSpec {
  readonly executable: string;
  readonly argvPrefix: readonly string[];
  readonly kind: "path" | "package-node-cli";
}

export interface PiLaunchDependencies {
  readonly platform?: NodeJS.Platform;
  readonly execPath?: string;
  readonly resolvePackageJson?: (specifier: string) => string;
  readonly readFile?: (path: string) => string | Buffer;
  readonly realpath?: (path: string) => string;
  readonly stat?: (path: string) => Pick<Stats, "isFile">;
}

export class PiLaunchResolutionError extends Error {
  readonly code = "pi_executable_resolution_failed";

  constructor(message: string) {
    super(`pi_executable_resolution_failed: ${message}`);
    this.name = "PiLaunchResolutionError";
  }
}

export class PiCommandLineLimitError extends Error {
  readonly code = "pi_command_line_too_long";
  readonly stage: string;
  readonly measuredLength: number;
  readonly limit: number;

  constructor(stage: string, measuredLength: number, limit: number) {
    super(
      `pi_command_line_too_long: ${stage} measured UTF-16 command line length ${String(measuredLength)} exceeds limit ${String(limit)}`,
    );
    this.name = "PiCommandLineLimitError";
    this.stage = stage;
    this.measuredLength = measuredLength;
    this.limit = limit;
  }
}

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_MANIFEST = `${PI_PACKAGE_NAME}/package.json`;
const WINDOWS_COMMAND_LINE_LIMIT = 32767;

interface JsonRecord {
  readonly [key: string]: unknown;
}

function nativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function defaultResolvePackageJson(specifier: string): string {
  if (specifier !== PI_PACKAGE_MANIFEST) {
    throw new Error(`unsupported package manifest specifier: ${specifier}`);
  }
  const packageEntry = fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME));
  let dir = dirname(packageEntry);
  for (;;) {
    const candidate = join(dir, "package.json");
    try {
      if (statSync(candidate).isFile()) return candidate;
      throw new Error(`${candidate} is not a regular file`);
    } catch (error) {
      const code = nativeErrorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package manifest not found above ${packageEntry}`);
    dir = parent;
  }
}

function failResolution(message: string): never {
  throw new PiLaunchResolutionError(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPath<T>(label: string, path: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    failResolution(`${label} failed for ${path}: ${errorMessage(error)}`);
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(raw: string | Buffer, manifestPath: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
  } catch (error) {
    failResolution(`manifest JSON is invalid at ${manifestPath}: ${errorMessage(error)}`);
  }
  if (!isJsonRecord(parsed)) failResolution(`manifest is not an object at ${manifestPath}`);
  return parsed;
}

function readPiBin(manifest: JsonRecord, manifestPath: string): string {
  const bin = manifest["bin"];
  if (typeof bin === "string" && bin.trim().length > 0) return bin;
  if (isJsonRecord(bin)) {
    const pi = bin["pi"];
    if (typeof pi === "string" && pi.trim().length > 0) return pi;
  }
  failResolution(`manifest bin.pi is missing or malformed at ${manifestPath}`);
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function resolvePiLaunch(deps: PiLaunchDependencies = {}): PiLaunchSpec {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { executable: "pi", argvPrefix: [], kind: "path" };

  const resolvePackageJson = deps.resolvePackageJson ?? defaultResolvePackageJson;
  const readFile = deps.readFile ?? readFileSync;
  const realpath = deps.realpath ?? realpathSync;
  const stat = deps.stat ?? statSync;
  const execPath = deps.execPath ?? process.execPath;

  let manifestPath: string;
  try {
    manifestPath = resolvePackageJson(PI_PACKAGE_MANIFEST);
  } catch (error) {
    failResolution(
      `package manifest resolve failed for ${PI_PACKAGE_MANIFEST}: ${errorMessage(error)}`,
    );
  }

  const packageRoot = dirname(manifestPath);
  const packageRootReal = readPath("package root realpath", packageRoot, () =>
    realpath(packageRoot),
  );
  const manifest = parseManifest(
    readPath("manifest read", manifestPath, () => readFile(manifestPath)),
    manifestPath,
  );
  const bin = readPiBin(manifest, manifestPath);
  const targetCandidate = join(packageRoot, bin);
  const targetReal = readPath("bin target realpath", targetCandidate, () =>
    realpath(targetCandidate),
  );
  if (!pathInside(packageRootReal, targetReal)) {
    failResolution("Pi package bin target resolves outside the package root");
  }
  const targetStat = readPath("bin target stat", targetReal, () => stat(targetReal));
  if (!targetStat.isFile()) failResolution("Pi package bin target is not a regular file");

  const extension = extname(targetReal).toLowerCase();
  if (extension === ".js" || extension === ".cjs" || extension === ".mjs") {
    return { executable: execPath, argvPrefix: [targetReal], kind: "package-node-cli" };
  }
  if (extension === ".exe" || extension === ".com") {
    return { executable: targetReal, argvPrefix: [], kind: "package-node-cli" };
  }
  failResolution(`Pi package bin target extension is unsupported: ${extension || "<none>"}`);
}

export function piLaunchArgv(launch: PiLaunchSpec, piArgs: readonly string[]): string[] {
  return [...launch.argvPrefix, ...piArgs];
}

function renderWindowsArgument(value: string): string {
  if (value.length > 0 && !/[ \t"]/.test(value)) return value;
  let rendered = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      rendered += "\\".repeat(backslashes * 2 + 1);
      rendered += '"';
      backslashes = 0;
      continue;
    }
    if (backslashes > 0) {
      rendered += "\\".repeat(backslashes);
      backslashes = 0;
    }
    rendered += char;
  }
  if (backslashes > 0) rendered += "\\".repeat(backslashes * 2);
  rendered += '"';
  return rendered;
}

function renderWindowsCommandLine(parts: readonly string[]): string {
  return parts.map(renderWindowsArgument).join(" ");
}

export function assertWindowsCommandLineWithinLimit(
  launch: PiLaunchSpec,
  piArgs: readonly string[],
  platform: NodeJS.Platform,
  stage: string,
): void {
  if (platform !== "win32") return;
  const measuredLength =
    renderWindowsCommandLine([launch.executable, ...launch.argvPrefix, ...piArgs]).length + 1;
  if (measuredLength > WINDOWS_COMMAND_LINE_LIMIT) {
    throw new PiCommandLineLimitError(stage, measuredLength, WINDOWS_COMMAND_LINE_LIMIT);
  }
}

export type PiChildSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"]; shell: false },
) => ChildProcessWithoutNullStreams;

export interface SpawnPiChildInput {
  readonly piArgs: readonly string[];
  readonly stdin: Buffer;
  readonly spawnOptions: SpawnOptionsWithoutStdio;
  readonly platform: NodeJS.Platform;
  readonly launch?: PiLaunchSpec;
  readonly spawn?: PiChildSpawn;
  readonly stage?: string;
}

export interface PiChildCompletion {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface PiChildCapture {
  readonly child: ChildProcessWithoutNullStreams;
  readonly completed: Promise<PiChildCompletion>;
}

export function spawnPiChild(input: SpawnPiChildInput): PiChildCapture {
  const launch = input.launch ?? resolvePiLaunch({ platform: input.platform });
  assertWindowsCommandLineWithinLimit(
    launch,
    input.piArgs,
    input.platform,
    input.stage ?? "pi-child",
  );
  const spawn = input.spawn ?? nodeSpawn;
  const child = spawn(launch.executable, piLaunchArgv(launch, input.piArgs), {
    ...input.spawnOptions,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
  });
  const completed = new Promise<PiChildCompletion>((resolvePromise, reject) => {
    let stdinFinished = false;
    let childCompletion: Pick<PiChildCompletion, "code" | "signal"> | undefined;
    const resolveWhenComplete = (): void => {
      if (!stdinFinished || childCompletion === undefined) return;
      resolvePromise({
        ...childCompletion,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    };
    child.once("error", reject);
    child.stdin.on("error", reject);
    child.stdin.once("finish", () => {
      stdinFinished = true;
      resolveWhenComplete();
    });
    child.stdin.once("close", () => {
      if (!stdinFinished) reject(new Error("Pi child stdin closed before the input finished"));
    });
    child.once("close", (code, signal) => {
      childCompletion = { code, signal };
      resolveWhenComplete();
    });
    child.stdin.end(input.stdin);
  });
  return { child, completed };
}

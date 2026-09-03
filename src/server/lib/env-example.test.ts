import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

/**
 * The two directions ask different questions, so they scan different trees.
 *
 * "Is every read documented?" is about the knobs an operator supplies to the
 * running server, so it scans `src/`. A one-off script's own env surface has no
 * business in a deployment's env file.
 *
 * "Is this entry dead?" is about whether anything at all reads the name, so it
 * spans every tree that ships or runs — including files at the repo root, which
 * is where the container healthcheck lives.
 */
const SERVER_ROOTS = ["src"];
const ALL_ROOTS = ["src", "scripts", "."];

const SOURCE_FILE = /\.(?:[mc]?[jt]sx?)$/;
const TEST_FILE = /\.test\.[mc]?[jt]sx?$/;
const SKIP_DIR = /^(?:node_modules|build|dist|coverage|\.git)$/;

/**
 * Files that hand the env object itself to a reader static extraction cannot
 * follow, each with the names that reader supplies.
 */
const ENV_HANDOFFS: Record<string, string[]> = {
  "src/server/lib/push.ts": ["PUSH_VAPID_PUBLIC_KEY", "PUSH_VAPID_PRIVATE_KEY"],
};

/** `readdirSync` / `statSync` have no `Bun.*` equivalent; file contents are read
 *  through `Bun.file` because two sibling suites mock `fs` process-globally. */
const sourceFiles = (dir: string, recurse: boolean): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      return recurse && !SKIP_DIR.test(entry) ? sourceFiles(full, true) : [];
    }
    if (!SOURCE_FILE.test(entry) || TEST_FILE.test(entry)) return [];
    return [full];
  });

const filesUnder = (roots: string[]): string[] =>
  roots.flatMap((root) => {
    const dir = path.join(REPO_ROOT, root);
    if (!existsSync(dir)) return [];
    return sourceFiles(dir, root !== ".");
  });

/** JSX is legal in `.js` here, and a `.ts` cast (`<T>value`) is not JSX, so no
 *  single kind parses every extension. */
const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};

const isEnvObject = (node: ts.Node): node is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(node) &&
  node.name.text === "env" &&
  ts.isIdentifier(node.expression) &&
  (node.expression.text === "process" || node.expression.text === "Bun");

/** A variable the server assigns to itself is not a surface an operator
 *  supplies, whatever the operator. */
const isWrite = (access: ts.Node): boolean => {
  const { parent } = access;
  if (ts.isDeleteExpression(parent)) return true;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === access &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
};

const bindingNames = (pattern: ts.ObjectBindingPattern): string[] =>
  pattern.elements.flatMap((element) => {
    const key = element.propertyName ?? element.name;
    return ts.isIdentifier(key) ? [key.text] : [];
  });

const literalNames = (pattern: ts.ObjectLiteralExpression): string[] =>
  pattern.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
    return ts.isIdentifier(property.name) ? [property.name.text] : [];
  });

/**
 * Names the parent expression takes off the env object, or `undefined` when the
 * object itself is handed on to a reader this file cannot follow.
 */
const namesTakenFrom = (env: ts.PropertyAccessExpression): string[] | undefined => {
  const { parent } = env;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === env) {
    return isWrite(parent) ? [] : [parent.name.text];
  }
  if (ts.isElementAccessExpression(parent) && parent.expression === env) {
    const key = parent.argumentExpression;
    const literal = ts.isStringLiteralLike(key) ? key.text : undefined;
    return literal === undefined || isWrite(parent) ? [] : [literal];
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === env) {
    return ts.isObjectBindingPattern(parent.name) ? bindingNames(parent.name) : undefined;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === env &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isObjectLiteralExpression(parent.left)
  ) {
    return literalNames(parent.left);
  }
  return undefined;
};

interface Extracted {
  names: string[];
  /** 1-based lines of the handoffs this file cannot follow. */
  escapes: number[];
}

const extract = (file: string, source: string): Extracted => {
  const kind = SCRIPT_KINDS[path.extname(file)] ?? ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const names: string[] = [];
  const escapes: number[] = [];
  const visit = (node: ts.Node) => {
    if (isEnvObject(node)) {
      const taken = namesTakenFrom(node);
      if (taken) names.push(...taken);
      else escapes.push(parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1);
    }
    node.forEachChild(visit);
  };
  visit(parsed);
  return { names, escapes };
};

const collect = async (roots: string[]) => {
  const read = new Set<string>();
  const undeclaredEscapes: string[] = [];
  const declaredHandoffs = new Set<string>();
  for (const file of filesUnder(roots)) {
    const relative = path.relative(REPO_ROOT, file);
    const { names, escapes } = extract(relative, await Bun.file(file).text());
    for (const name of names) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(name)) read.add(name);
    }
    if (!escapes.length) continue;
    const declared = ENV_HANDOFFS[relative];
    if (!declared) {
      for (const line of escapes) undeclaredEscapes.push(`${relative}:${line}`);
      continue;
    }
    declaredHandoffs.add(relative);
    for (const name of declared) read.add(name);
  }
  return { read, undeclaredEscapes, declaredHandoffs };
};

const scans = new Map<string, ReturnType<typeof collect>>();
const collectOnce = (roots: string[]) => {
  const key = roots.join(",");
  const cached = scans.get(key);
  if (cached) return cached;
  const pending = collect(roots);
  scans.set(key, pending);
  return pending;
};

const documentedVariables = async (): Promise<Set<string>> => {
  const source = await Bun.file(path.join(REPO_ROOT, ".env.example")).text();
  return new Set([...source.matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)=/gm)].map((match) => match[1]));
};

describe(".env.example", () => {
  it("documents every variable the server reads", async () => {
    const documented = await documentedVariables();
    const { read } = await collectOnce(SERVER_ROOTS);
    const undocumented = [...read].filter((name) => !documented.has(name)).sort();
    expect(undocumented).toEqual([]);
  });

  it("documents no variable that is never read", async () => {
    const { read } = await collectOnce(ALL_ROOTS);
    const documented = await documentedVariables();
    const dead = [...documented].filter((name) => !read.has(name)).sort();
    expect(dead).toEqual([]);
  });

  it("has no env handoff it cannot follow", async () => {
    const { undeclaredEscapes } = await collectOnce(ALL_ROOTS);
    expect(undeclaredEscapes.sort()).toEqual([]);
  });

  it("declares no env handoff that has gone away", async () => {
    const { declaredHandoffs } = await collectOnce(ALL_ROOTS);
    const stale = Object.keys(ENV_HANDOFFS)
      .filter((file) => !declaredHandoffs.has(file))
      .sort();
    expect(stale).toEqual([]);
  });
});

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [full];
  });

/**
 * `process.env.NAME` on the right-hand side only. `config.ts` *assigns*
 * `process.env.NODE_PATH`, which is not a configuration surface an operator
 * supplies, so an assignment must not be counted as a read.
 */
const directReads = (source: string): string[] =>
  [...source.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)\s*(?!=[^=])/g)]
    .filter((m) => !/^\s*=[^=]/.test(source.slice(m.index! + m[0].length)))
    .map((m) => m[1]);

/**
 * `const { A, B = "fallback" } = process.env`, single- or multi-line. Missing
 * this form is how a hand-run audit concludes that `ADMIN_PASSWORD` and every
 * `POSTGRES_*` variable are documented-but-unread.
 */
const destructuredReads = (source: string): string[] =>
  [...source.matchAll(/\{([^{}]*)\}\s*=\s*process\.env/g)].flatMap((m) =>
    m[1]
      .split(",")
      .map((part) => part.split(/[=:]/)[0].trim())
      .filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name))
  );

const readVariables = (): Set<string> => {
  const names = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const name of directReads(source)) names.add(name);
    for (const name of destructuredReads(source)) names.add(name);
  }
  return names;
};

const documentedVariables = (): Set<string> => {
  const example = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");
  return new Set(
    [...example.matchAll(/^#?\s*([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1])
  );
};

/**
 * The reverse direction asks "is this name dead?", not "how is it read?", so a
 * bare occurrence check is the right strength. `push.ts` takes `process.env` as
 * an injected `env` argument and destructures it one indirection away — no
 * `process.env.X` extraction can follow that, but the identifier is still
 * plainly there, and a variable that appears nowhere in source is dead.
 */
const mentionedAnywhere = (): Set<string> => {
  const names = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /\b[A-Z_][A-Z0-9_]{2,}\b/g
    )) {
      names.add(match[0]);
    }
  }
  return names;
};

describe(".env.example", () => {
  it("documents every variable the server reads", () => {
    const documented = documentedVariables();
    const undocumented = [...readVariables()]
      .filter((name) => !documented.has(name))
      .sort();
    expect(undocumented).toEqual([]);
  });

  it("documents no variable that appears nowhere in the source", () => {
    const mentioned = mentionedAnywhere();
    const dead = [...documentedVariables()]
      .filter((name) => !mentioned.has(name))
      .sort();
    expect(dead).toEqual([]);
  });
});

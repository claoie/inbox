import { describe, it, expect } from "bun:test";
import { existsSync, readdirSync, statSync } from "fs";
import path from "path";

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
 * follow, each with the names that reader supplies. The names are checked
 * against the documentation like any other read, and the file is checked for
 * still handing anything off, so neither half of the claim can rot unnoticed.
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

const ENV_OBJECT = /(?:process|Bun)\.env\s*(?:\?\.)?\[\s*$/;
const DELETE_ENV_OBJECT = /delete\s+(?:process|Bun)\.env\s*(?:\?\.)?\[\s*$/;
const ASSIGNMENT = /^\s*(?:\?\?|\|\||&&|\+|-|\*|\/|%|\*\*)?=(?!=)/;

interface Scanned {
  /** Comment bodies and string contents blanked to spaces. A `${…}` span in a
   *  template literal is code, so it survives the blanking. */
  code: string;
  /** `env["NAME"]` names, collected before blanking hides them. */
  bracketReads: string[];
}

const scan = (source: string): Scanned => {
  const out = source.split("");
  const bracketReads: string[] = [];
  const interpolations: number[] = [];
  let braceDepth = 0;
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let j = from; j < to; j++) if (out[j] !== "\n") out[j] = " ";
  };

  const recordBracketRead = (open: number, close: number, body: string) => {
    if (body.includes("\\") || !ENV_OBJECT.test(source.slice(0, open))) return;
    if (DELETE_ENV_OBJECT.test(source.slice(0, open))) return;
    const bracket = source.indexOf("]", close);
    if (bracket === -1 || ASSIGNMENT.test(source.slice(bracket + 1))) return;
    bracketReads.push(body);
  };

  /** Blanks template text up to the closing backtick or the next `${`, leaving
   *  the interpolation for the main loop to read as the code it is. */
  const blankTemplateText = (from: number): number => {
    let j = from;
    while (j < source.length) {
      if (source[j] === "\\") {
        j += 2;
        continue;
      }
      if (source[j] === "`") {
        blank(from, j);
        return j + 1;
      }
      if (source[j] === "$" && source[j + 1] === "{") {
        blank(from, j);
        interpolations.push(braceDepth);
        return j + 2;
      }
      j += 1;
    }
    blank(from, source.length);
    return source.length;
  };

  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (source[i] === '"' || source[i] === "'") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        if (source[j] === "\\") j += 1;
        j += 1;
      }
      recordBracketRead(i, j, source.slice(i + 1, j));
      blank(i + 1, j);
      i = j + 1;
    } else if (source[i] === "`") {
      const plain = /^`([^`\\$]*)`/.exec(source.slice(i));
      if (plain) recordBracketRead(i, i + plain[0].length - 1, plain[1]);
      i = blankTemplateText(i + 1);
    } else if (source[i] === "{") {
      braceDepth += 1;
      i += 1;
    } else if (source[i] === "}") {
      if (interpolations[interpolations.length - 1] === braceDepth) {
        interpolations.pop();
        i = blankTemplateText(i + 1);
      } else {
        braceDepth = Math.max(0, braceDepth - 1);
        i += 1;
      }
    } else {
      i += 1;
    }
  }

  return { code: out.join(""), bracketReads };
};

const DOT_READ = /(delete\s+)?(?:process|Bun)\.env\s*(?:\?\.|\.)\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;

/**
 * `env.NAME` on the right-hand side. A variable the server assigns to itself is
 * not a surface an operator supplies, so writes are excluded whatever their
 * operator.
 */
const dotReads = (code: string): string[] => {
  const names: string[] = [];
  for (const match of code.matchAll(DOT_READ)) {
    if (match[1]) continue;
    if (ASSIGNMENT.test(code.slice(match.index + match[0].length))) continue;
    names.push(match[2]);
  }
  return names;
};

/** `const { A, B = "fallback" } = env`, single- or multi-line. */
const destructuredReads = (code: string): string[] => {
  const names: string[] = [];
  for (const match of code.matchAll(/\}\s*=\s*(?:process|Bun)\.env\b/g)) {
    const close = code.indexOf("}", match.index);
    let depth = 0;
    let open = -1;
    for (let i = close; i >= 0; i--) {
      if (code[i] === "}") depth += 1;
      else if (code[i] === "{") {
        depth -= 1;
        if (depth === 0) {
          open = i;
          break;
        }
      }
    }
    if (open === -1) continue;
    for (const part of code.slice(open + 1, close).split(",")) {
      names.push(part.split(/[=:]/)[0].trim());
    }
  }
  return names;
};

const ENV_ESCAPE = /(?:process|Bun)\.env\b(?![.?[\w$])/g;

/**
 * A bare `process.env` — bound to a name, passed as an argument, spread — hands
 * the object to a reader this file cannot follow. Reporting the site is the only
 * honest option: skipping it would let an undocumented read through, and
 * guessing at the receiver's members would invent evidence.
 */
const escapes = (code: string): number[] =>
  [...code.matchAll(ENV_ESCAPE)]
    .filter((match) => !/\}\s*=\s*$/.test(code.slice(0, match.index)))
    .map((match) => match.index);

const lineOf = (code: string, offset: number): number =>
  code.slice(0, offset).split("\n").length;

const collect = async (roots: string[]) => {
  const read = new Set<string>();
  const undeclaredEscapes: string[] = [];
  const declaredHandoffs = new Set<string>();
  for (const file of filesUnder(roots)) {
    const relative = path.relative(REPO_ROOT, file);
    const { code, bracketReads } = scan(await Bun.file(file).text());
    for (const name of [...dotReads(code), ...destructuredReads(code), ...bracketReads]) {
      if (/^[A-Z_][A-Z0-9_]*$/.test(name)) read.add(name);
    }
    const sites = escapes(code);
    if (!sites.length) continue;
    const declared = ENV_HANDOFFS[relative];
    if (!declared) {
      for (const offset of sites) undeclaredEscapes.push(`${relative}:${lineOf(code, offset)}`);
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

/**
 * Help ↔ docs parity (wave 8 Definition of Done §6): walks the commander program from
 * buildProgram() (every subcommand, option and argument; nothing is spawned) and checks
 * docs/09-cli-and-api.md §1 both ways:
 * - every command path appears as `sw <path>` and every long option appears in the section of its
 *   top-level command (global options in "Global flags"), arguments in the command's section;
 * - every `sw <command…>` and every `--flag` named in §1 exists in the program.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, Option } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../../src/cli/main.js";
import { REPO_ROOT } from "../../helpers/cli.js";

const doc = readFileSync(join(REPO_ROOT, "docs", "09-cli-and-api.md"), "utf8").replace(/\r\n/g, "\n");
const cli = doc.slice(doc.indexOf("## 1. CLI"), doc.indexOf("## 2. Programmatic API"));

/** "### `sw bugs`" → section text until the next ### / ##. */
function section(heading: string): string {
  const at = cli.indexOf(heading);
  if (at < 0) return "";
  const rest = cli.slice(at + heading.length);
  const next = rest.search(/\n##+ /);
  return next < 0 ? rest : rest.slice(0, next);
}

interface Cmd {
  path: string[];
  cmd: Command;
}

function walk(c: Command, path: string[] = [], acc: Cmd[] = []): Cmd[] {
  for (const s of c.commands) {
    const p = [...path, s.name()];
    acc.push({ path: p, cmd: s });
    walk(s, p, acc);
  }
  return acc;
}

const program = buildProgram();
const commands = walk(program);
const longOf = (o: Option): string => o.long as string;
const globalLongs = [...program.options.map(longOf), "--help"];
const allLongs = new Set([...globalLongs, ...commands.flatMap((c) => c.cmd.options.map(longOf))]);
const hasFlag = (text: string, flag: string): boolean =>
  new RegExp(`${flag.replace(/-/g, "\\-")}(?![\\w-])`).test(text);

describe("sw --help ↔ docs/09-cli-and-api.md", () => {
  it("the program has the expected shape (sanity)", () => {
    expect(commands.length).toBeGreaterThan(30);
    expect(allLongs.has("--path-param")).toBe(true);
  });

  it("every global option is in the Global flags table", () => {
    const g = section("### Global flags");
    const missing = globalLongs.filter((f) => !hasFlag(g, f));
    expect(missing).toEqual([]);
  });

  it("every command and subcommand appears as `sw <path>`", () => {
    const missing = commands
      .map((c) => `sw ${c.path.join(" ")}`)
      .filter((p) => {
        // `sw history baseline set` or the grouped form `sw config print|validate|schema`
        if (cli.includes(p)) return false;
        const parent = p.slice(0, p.lastIndexOf(" "));
        const leaf = p.slice(p.lastIndexOf(" ") + 1);
        return !new RegExp(`${parent} [\\w|\\\\-]*\\b${leaf}\\b`).test(cli);
      });
    expect(missing).toEqual([]);
  });

  it("every top-level command has its own section, with each option and argument of it and its subcommands", () => {
    const missing: string[] = [];
    for (const top of program.commands) {
      const sec = section(`### \`sw ${top.name()}\``);
      if (!sec) {
        missing.push(`section ### \`sw ${top.name()}\``);
        continue;
      }
      for (const c of commands.filter((x) => x.path[0] === top.name())) {
        for (const o of c.cmd.options)
          if (!hasFlag(sec, longOf(o))) missing.push(`sw ${c.path.join(" ")} ${longOf(o)}`);
        for (const a of c.cmd.registeredArguments) {
          const form = a.required ? `<${a.name()}>` : `[${a.name()}${a.variadic ? "..." : ""}]`;
          if (!sec.includes(form)) missing.push(`sw ${c.path.join(" ")} ${form}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every `sw <command…>` named in the CLI section exists", () => {
    const unknown: string[] = [];
    for (const m of cli.matchAll(/`sw ([a-z][a-z-]*(?:[ |][a-z][a-z-]*)*)/g)) {
      const words = (m[1] as string).split(" ");
      let node: Command = program;
      for (const [i, w] of words.entries()) {
        // grouped form: `sw config print|validate|schema`
        const names = w.split("|");
        const found = names.map((n) => node.commands.find((c) => c.name() === n));
        if (found.every((f) => f === undefined)) {
          if (i === 0) unknown.push(`sw ${m[1]}`);
          break; // later words are arguments or values
        }
        if (found.some((f) => f === undefined)) {
          unknown.push(`sw ${m[1]}`);
          break;
        }
        if (names.length > 1) break;
        node = found[0] as Command;
      }
    }
    expect(unknown).toEqual([]);
  });

  it("every --flag named in the CLI section exists", () => {
    const flags = new Set([...cli.matchAll(/(?<![\w-])--[a-z][a-z-]*[a-z]/g)].map((m) => m[0]));
    const unknown = [...flags].filter((f) => !allLongs.has(f));
    expect(unknown).toEqual([]);
  });
});

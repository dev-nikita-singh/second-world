/**
 * Tiny glob → RegExp converter for layer maps (ARCH012) and path predicates.
 * Supports `**`, `*`, `?`, `{a,b}`. Paths are POSIX, relative to the project root.
 */

export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  let inBrace = false;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; trailing `**` matches anything.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      inBrace = true;
      re += "(?:";
    } else if (c === "}" && inBrace) {
      inBrace = false;
      re += ")";
    } else if (c === "," && inBrace) re += "|";
    else if ("\\^$.|+()[]".includes(c)) re += `\\${c}`;
    else re += c;
    i++;
  }
  return new RegExp(`^${re}$`);
}

export function createMatcher(globs: readonly string[]): (path: string) => boolean {
  const res = globs.map(globToRegExp);
  return (p) => res.some((r) => r.test(p));
}

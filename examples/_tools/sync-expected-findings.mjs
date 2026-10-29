#!/usr/bin/env node
/**
 * Refresh `location` (file + line) of every defect in <example>/expected-findings.json
 * from the `SEEDED-DEFECT:<id>` marker comments in <example>/src. The defect's
 * location is the line right AFTER its marker. Fails if a marker or entry is missing.
 *
 *   node examples/_tools/sync-expected-findings.mjs examples/shop-express [--check]
 */
import fs from "node:fs";
import path from "node:path";

const [root, flag] = process.argv.slice(2);
if (!root) throw new Error("usage: sync-expected-findings.mjs <example-dir> [--check]");
const file = path.join(root, "expected-findings.json");
const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const markers = new Map();
for (const f of walk(path.join(root, "src"))) {
  fs.readFileSync(f, "utf8")
    .split(/\r?\n/)
    .forEach((l, i) => {
      for (const m of l.matchAll(/SEEDED-DEFECT:([a-z0-9-]+)/g)) {
        markers.set(m[1], { file: path.relative(root, f).split(path.sep).join("/"), line: i + 2 });
      }
    });
}
const problems = [];
for (const d of doc.defects) {
  const loc = markers.get(d.id);
  if (!loc) problems.push(`no marker for ${d.id}`);
  else if (flag === "--check") {
    if (d.location?.file !== loc.file || d.location?.line !== loc.line) problems.push(`${d.id}: json ${d.location?.file}:${d.location?.line} != marker ${loc.file}:${loc.line}`);
  } else d.location = { ...d.location, file: loc.file, line: loc.line };
}
for (const id of markers.keys()) if (!doc.defects.some((d) => d.id === id)) problems.push(`marker ${id} has no entry`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
if (flag !== "--check") fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`${doc.defects.length} defects ${flag === "--check" ? "verified" : "synced"} in ${file}`);

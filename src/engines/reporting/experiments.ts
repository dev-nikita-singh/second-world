/**
 * What-If (ExperimentData) and Evolution (EvolutionData) rendering.
 * docs/03-engines/experiments.md §A.4 (verdicts with CI, Holm, effect size), §B.4 (Pareto front,
 * rejections). Honesty rules: projections are estimates in their own labelled section; outlier
 * runs are flagged (never dropped); inconclusive rows show how many repetitions would be needed.
 */
import type { MetricComparison } from "../experiments/analysis.js";
import type { EvolutionData, ExperimentData } from "../experiments/types.js";
import { type Block, type CellLike, fmtVal } from "./blocks.js";
import { fmtDuration, fmtMs, fmtPct } from "./model.js";

export function isExperimentData(d: unknown): d is ExperimentData {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    o.schema === 1 &&
    (o.mode === "compare" || o.mode === "aa") &&
    Array.isArray(o.comparisons) &&
    Array.isArray(o.verdicts) &&
    Array.isArray(o.arms) &&
    typeof o.design === "object" &&
    o.design !== null
  );
}

export function isEvolutionData(d: unknown): d is EvolutionData {
  if (typeof d !== "object" || d === null) return false;
  const o = d as Record<string, unknown>;
  return (
    o.schema === 1 &&
    Array.isArray(o.candidates) &&
    Array.isArray(o.paretoFront) &&
    Array.isArray(o.rejected) &&
    typeof o.workingTree === "object" &&
    o.workingTree !== null
  );
}

/** Value in its metric unit. */
export function fmtMetric(v: number | null | undefined, unit: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  if (unit === "ms") return fmtMs(v);
  if (unit === "ratio") return fmtPct(v);
  if (unit === "per_s") return `${fmtVal(v)}/s`;
  return fmtVal(v);
}

/** Signed relative change as a percentage with one decimal. */
export function fmtRel(x: number): string {
  if (!Number.isFinite(x)) return "-";
  const p = x * 100;
  return `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;
}

function verdictCell(v: MetricComparison["verdict"]): CellLike {
  if (v === "improved") return { text: v, tone: "good" };
  if (v === "regressed") return { text: v, tone: "bad" };
  if (v === "inconclusive") return { text: v, tone: "warn" };
  return { text: v, tone: "muted" };
}

function successCell(c: MetricComparison): CellLike {
  if (!c.success) return { text: "-", tone: "muted" };
  const t = `${c.success.status} (${c.success.criterion})`;
  return c.success.status === "met"
    ? { text: t, tone: "good" }
    : c.success.status === "not-met"
      ? { text: t, tone: "bad" }
      : { text: t, tone: "warn" };
}

const HYP_TONE = { supported: "good", rejected: "bad", inconclusive: "warn", untested: "muted" } as const;

export function experimentBlocks(d: ExperimentData): Block[] {
  const b: Block[] = [];
  const des = d.design;
  b.push({
    kind: "kv",
    items: [
      ["experiment", d.name],
      ["mode", d.mode === "aa" ? "A/A (baseline vs itself: noise floor)" : "compare"],
      ...(d.hypothesis ? ([["hypothesis", d.hypothesis]] as [string, CellLike][]) : []),
      [
        "design",
        `r=${des.repetitions} per arm, ${des.order}, lifecycle ${des.lifecycle}, seed ${des.seed}, α=${des.alpha}, bootstrap B=${des.bootstrap}, equivalence ±${fmtPct(des.equivalenceMargin)}`,
      ],
    ],
  });

  if (d.arms.length > 0) {
    b.push({
      kind: "table",
      title: "Arms",
      head: ["arm", "kind", "runs", "failed", "target / command"],
      align: ["l", "l", "r", "r", "l"],
      rows: d.arms.map((a) => [
        a.name,
        a.sharesProcessWith.length > 0
          ? `${a.kind} (shares process with ${a.sharesProcessWith.join(", ")})`
          : a.kind,
        String(a.runs),
        a.failedRuns > 0 ? { text: String(a.failedRuns), tone: "bad" } : "0",
        a.target ?? a.command ?? "-",
      ]),
    });
  }

  if (d.comparisons.length > 0) {
    b.push({
      kind: "table",
      title: "Verdicts per metric",
      head: [
        "variant",
        "metric",
        "baseline → variant (median)",
        "change",
        "CI",
        "p (Holm)",
        "Cliff's δ",
        "verdict",
        "success",
        "runs needed",
      ],
      align: ["l", "l", "l", "r", "r", "r", "l", "l", "l", "r"],
      rows: d.comparisons.map((c) => [
        c.variant,
        c.metric,
        `${fmtMetric(c.medians.baseline, c.unit)} → ${fmtMetric(c.medians.variant, c.unit)}`,
        fmtRel(c.relativeChange),
        `[${fmtRel(c.ci.lower)}, ${fmtRel(c.ci.upper)}]`,
        fmtVal(c.pAdjusted),
        `${c.cliffsDelta.delta.toFixed(2)} (${c.cliffsDelta.magnitude})`,
        verdictCell(c.verdict),
        successCell(c),
        c.verdict === "inconclusive" && c.recommendedRepetitions !== undefined
          ? `${c.recommendedRepetitions}/arm`
          : "",
      ]),
    });
    const ci = d.comparisons[0]?.ci;
    if (ci) {
      b.push({
        kind: "text",
        tone: "muted",
        text: `CI = ${Math.round(ci.level * 100)}% ${ci.method.toUpperCase()} bootstrap CI of the relative median change; p = Mann–Whitney, Holm-adjusted across ${d.comparisons.length} comparison(s).`,
      });
    }
  }

  if (d.verdicts.length > 0 && d.mode === "compare") {
    b.push({
      kind: "table",
      title: "Hypothesis per variant",
      head: ["variant", "hypothesis", "improved", "regressed", "inconclusive"],
      rows: d.verdicts.map((v) => [
        v.variant,
        { text: v.hypothesis, tone: HYP_TONE[v.hypothesis] },
        v.improved.join(", ") || "-",
        v.regressed.length > 0 ? { text: v.regressed.join(", "), tone: "bad" } : "-",
        v.inconclusive.join(", ") || "-",
      ]),
    });
  }

  if (d.noiseFloor && d.noiseFloor.length > 0) {
    b.push({
      kind: "table",
      title: "Noise floor (A/A): smallest detectable effect at this r",
      head: ["metric", "min. detectable effect", "relative SD", "runs/arm for 5%"],
      align: ["l", "r", "r", "r"],
      rows: d.noiseFloor.map((n) => [
        n.metric,
        fmtPct(n.mde),
        fmtPct(n.relativeSd),
        String(n.recommendedFor5pct),
      ]),
    });
  }

  const outliers = d.runs.filter(
    (r) => r.outlierMetrics.length > 0 || r.generatorSaturated || r.status !== "ok",
  );
  if (outliers.length > 0) {
    b.push({
      kind: "table",
      title: "Flagged runs (kept in the analysis)",
      head: ["run", "arm", "rep", "status", "flags"],
      align: ["r", "l", "r", "l", "l"],
      rows: outliers.map((r) => {
        const flags: string[] = [];
        if (r.outlierMetrics.length > 0) flags.push(`outlier (MAD z > 3.5): ${r.outlierMetrics.join(", ")}`);
        if (r.generatorSaturated) flags.push("generator saturated");
        if (r.error) flags.push(r.error);
        return [
          String(r.index),
          r.arm,
          String(r.rep),
          r.status === "ok" ? "ok" : { text: r.status, tone: "bad" },
          { text: flags.join("; "), tone: "warn" },
        ];
      }),
    });
  }

  const warnings = [
    ...(d.fingerprints.consistent ? [] : ["environment fingerprints differ between arms"]),
    ...d.fingerprints.warnings,
    ...d.warnings,
  ];
  for (const w of [...new Set(warnings)]) b.push({ kind: "text", tone: "warn", text: w });

  if (d.projections.length > 0) {
    b.push({ kind: "heading", level: 3, text: "Estimates (model, not measured)" });
    const mm1 = d.projections.filter((p) => p.method === "mm1");
    if (mm1.length > 0) {
      b.push({
        kind: "table",
        title: "M/M/1 queueing projection",
        head: ["arm", "rate", "utilisation", "mean", "p95", "basis"],
        align: ["l", "r", "r", "r", "r", "l"],
        rows: mm1.map((p) =>
          p.method === "mm1"
            ? [
                p.arm,
                `${fmtVal(p.rate)}/s`,
                p.saturated
                  ? { text: `${fmtPct(p.utilisation)} (saturated)`, tone: "bad" }
                  : fmtPct(p.utilisation),
                p.meanMs === null ? "-" : fmtMs(p.meanMs),
                p.p95Ms === null ? "-" : fmtMs(p.p95Ms),
                `measured ${fmtVal(p.basis.rate)}/s, mean ${fmtMs(p.basis.meanMs)}, service ${fmtMs(p.basis.serviceMs)}`,
              ]
            : [],
        ),
      });
      const a = mm1[0];
      if (a && a.method === "mm1")
        b.push({ kind: "text", tone: "muted", text: `Assumptions: ${a.assumptions}` });
    }
    const usl = d.projections.filter((p) => p.method === "usl");
    if (usl.length > 0) {
      b.push({
        kind: "table",
        title: "USL throughput projection",
        head: ["concurrency", "throughput", "σ", "κ", "r²", "note"],
        align: ["r", "r", "r", "r", "r", "l"],
        rows: usl.map((p) =>
          p.method === "usl"
            ? [
                String(p.concurrency),
                p.throughput === null ? "-" : `${fmtVal(p.throughput)}/s`,
                fmtVal(p.fit.sigma),
                fmtVal(p.fit.kappa),
                fmtVal(p.fit.r2),
                p.refused
                  ? { text: `refused: ${p.refused}`, tone: "muted" }
                  : p.extrapolated
                    ? { text: "extrapolated", tone: "warn" }
                    : "",
              ]
            : [],
        ),
      });
    }
  }
  return b;
}

const short = (sha: string): string => sha.slice(0, 10);

export function evolutionBlocks(d: EvolutionData): Block[] {
  const b: Block[] = [];
  const sb = d.sandbox;
  b.push({
    kind: "kv",
    items: [
      ["repository", d.repo],
      ["baseline", `${d.baseline.ref} @ ${short(d.baseline.commit)}`],
      ...(d.finding ? ([["finding", d.finding]] as [string, CellLike][]) : []),
      [
        "sandbox",
        [
          sb.kind,
          sb.image,
          sb.cpus !== undefined ? `${sb.cpus} cpu` : undefined,
          sb.memory,
          sb.network ? `network ${sb.network}` : undefined,
        ]
          .filter(Boolean)
          .join(", "),
      ],
      ["install", `${d.install.strategy} (${d.install.installed} installed, ${d.install.reused} reused)`],
      [
        "working tree",
        d.workingTree.unchanged
          ? { text: "unchanged (checksum verified)", tone: "good" }
          : { text: "CHANGED during the run", tone: "bad" },
      ],
      ["worktrees cleaned", d.worktreesCleaned ? "yes" : { text: "no", tone: "warn" }],
    ],
  });

  b.push({
    kind: "quote",
    title: "Pareto front (best first)",
    text:
      d.paretoFront.length > 0
        ? d.paretoFront.map((n, i) => `${i + 1}. ${n}`).join("   ")
        : "none: no candidate passed the gates and improved without regressing",
  });

  const metrics = d.rankBy.map((r) => r.metric);
  if (d.candidates.length > 0) {
    b.push({
      kind: "table",
      title: "Candidates",
      head: ["rank", "ref", "status", "diff", ...metrics.map((m) => `Δ ${m}`), "verdicts", "score"],
      align: ["r", "l", "l", "l", ...metrics.map(() => "r" as const), "l", "r"],
      rows: d.candidates.map((c) => [
        c.rank !== undefined ? String(c.rank) : "-",
        c.pareto ? { text: `${c.ref} ★`, tone: "good" } : c.ref,
        c.status === "accepted" ? { text: "accepted", tone: "good" } : { text: c.status, tone: "bad" },
        c.diff.stat || `${c.diff.files} files, +${c.diff.insertions}/-${c.diff.deletions}`,
        ...metrics.map((m): CellLike => {
          const v = c.improvement[m];
          if (v === undefined) return "-";
          return {
            text: fmtRel(v),
            ...(v > 0 ? { tone: "good" as const } : v < 0 ? { tone: "bad" as const } : {}),
          };
        }),
        Object.entries(c.verdicts)
          .map(([m, v]) => `${m}: ${v}`)
          .join(", ") || "-",
        c.score !== undefined ? fmtVal(c.score) : "-",
      ]),
    });
    b.push({
      kind: "text",
      tone: "muted",
      text: "Δ = oriented relative improvement (+ is better), only where the change is significant. ★ = on the Pareto front.",
    });
  }

  const gateRows: CellLike[][] = [];
  for (const c of d.candidates) {
    for (const g of c.gates) {
      gateRows.push([
        c.name,
        g.gate,
        g.name,
        g.skipped
          ? { text: "skipped", tone: "muted" }
          : g.ok
            ? { text: "ok", tone: "good" }
            : { text: "FAIL", tone: "bad" },
        fmtDuration(g.durationMs),
        g.detail ?? "",
      ]);
    }
  }
  if (gateRows.length > 0) {
    b.push({
      kind: "table",
      title: "Gates",
      head: ["candidate", "gate", "name", "result", "time", "detail"],
      align: ["l", "l", "l", "l", "r", "l"],
      rows: gateRows,
    });
  }

  if (d.rejected.length > 0) {
    b.push({
      kind: "table",
      title: "Rejected",
      head: ["candidate", "reasons"],
      rows: d.rejected.map((r) => [r.name, { text: r.reasons.join("; "), tone: "bad" }]),
    });
  }
  for (const w of d.warnings) b.push({ kind: "text", tone: "warn", text: w });

  if (d.experiment) {
    b.push({ kind: "heading", level: 3, text: "Benchmark (What-If: baseline vs accepted candidates)" });
    b.push(...experimentBlocks(d.experiment));
  }
  return b;
}

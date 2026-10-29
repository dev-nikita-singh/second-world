/**
 * Shared suite: for one example app, run every command listed in its expected-findings.json
 * `detectedBy` entries with exactly the example's sw.config.ts (copied to a temp dir, SW_* port
 * overrides) and assert recall = 1.0 over the detectable defects and precision = 1.0 (only
 * documented observation-level findings may appear besides the expected ones).
 * docs/12-testing-and-quality.md §3.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ExampleName, freePort, type RunningExample, startExample } from "../../helpers/examples.js";
import type { TmpDir } from "../../helpers/tmp.js";
import {
  cliArgs,
  copyExample,
  describeFindings,
  documentedCommands,
  groundTruth,
  hashExample,
  portOverrides,
  runFromConfig,
  scoreCommand,
} from "./from-config.js";

export function fromConfigSuite(app: ExampleName, expectedCommands: string[]): void {
  const truth = groundTruth(app);

  describe(`${app}: ground truth documents how each defect is found from sw.config.ts`, () => {
    it("every defect says whether it is detectable from the config, and how (or why not)", () => {
      for (const d of truth.defects) {
        expect(typeof d.detectableFromConfig, d.id).toBe("boolean");
        if (d.detectableFromConfig) expect(d.detectedBy?.length, d.id).toBeGreaterThan(0);
        else expect(d.detectableFromConfigReason, d.id).toBeTruthy();
        for (const x of d.detectedBy ?? [])
          expect(
            x.operation !== undefined ||
              x.location === true ||
              x.titleIncludes !== undefined ||
              x.ruleId.startsWith("reliability/"),
            `${d.id}: ${x.command}`,
          ).toBe(true);
      }
      expect(documentedCommands(truth)).toEqual(expectedCommands);
    });
  });

  describe(`${app}: engines run with exactly examples/${app}/sw.config.ts`, () => {
    const before = hashExample(app);
    afterAll(() => {
      // the CLI wrote reports/history into the temp copy only
      expect(hashExample(app)).toBe(before);
    });

    for (const command of expectedCommands) {
      describe(command, () => {
        let ex: RunningExample;
        let dir: TmpDir;
        let proxyPort: number | undefined;
        beforeAll(async () => {
          // Reliability: the shop calls payments through the fault proxy the engine starts on proxyPort.
          proxyPort = command.startsWith("sw reliability") ? await freePort() : undefined;
          ex = await startExample(app, proxyPort === undefined ? {} : { paymentsPort: proxyPort });
          dir = await copyExample(app);
        });
        afterAll(async () => {
          await ex?.close();
          await dir?.cleanup();
        });

        it("finds every detectable defect (recall 1.0) and nothing undocumented (precision 1.0)", async () => {
          const r = await runFromConfig(
            dir,
            cliArgs(command),
            portOverrides(ex, proxyPort === undefined ? {} : { proxyPort }),
          );
          const s = scoreCommand(truth, command, r.report.findings);
          process.stderr.write(
            `[sw-examples] ${app} \`${command}\`: recall ${s.matched.length}/${s.expected.length} precision ${s.precision.toFixed(2)} observations ${s.observations.length}\n${describeFindings(r.report)}\n`,
          );
          expect(r.report.limitations?.map((l) => l.code) ?? []).not.toContain("RELIABILITY_AUTH_UNRESOLVED");
          expect(s.expected.length).toBeGreaterThan(0);
          expect(s.missed).toEqual([]);
          expect(s.falsePositives).toEqual([]);
          expect(s.recall).toBe(1);
          expect(s.precision).toBe(1);
          // defects found → exit 1 (failOn high or a reproduced defect ≥ high in every command here)
          expect([0, 1]).toContain(r.exitCode);
        }, 150_000);
      });
    }
  });
}

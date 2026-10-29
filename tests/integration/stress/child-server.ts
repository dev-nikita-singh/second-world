/** Spawns the calibrated server in a separate Node process (no shell). */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ChildServer {
  url: string;
  close(): Promise<void>;
}

export async function startChildServer(): Promise<ChildServer> {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "server-child.ts");
  const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["pipe", "pipe", "inherit"] });
  const url = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("child server did not start in 15 s")), 15_000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`child server exited early (${code})`)));
    child.stdout.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        resolve((JSON.parse(buf.slice(0, nl)) as { url: string }).url);
      }
    });
  });
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        const t = setTimeout(() => child.kill(), 3_000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        child.stdin.end();
      }),
  };
}

// Spawns a grandchild that lives forever; prints "child <pid> grandchild <pid>" then waits.
import { spawn } from "node:child_process";

const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(`child ${process.pid} grandchild ${gc.pid}\n`);
setInterval(() => {}, 1000);

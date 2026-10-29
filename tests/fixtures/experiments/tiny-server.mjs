// Tiny HTTP app for What-If / Evolution tests. Env: PORT (required), DELAY_MS (per /work request, default 5),
// START_DELAY_MS (delay before listening), CRASH=1 (exit before listening).
import http from "node:http";

const port = Number(process.env.PORT ?? 0);
const delay = Number(process.env.DELAY_MS ?? 5);
if (process.env.CRASH === "1") {
  process.stderr.write("crashing on purpose\n");
  process.exit(3);
}
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, delay }));
    return;
  }
  if (req.url?.startsWith("/fast")) {
    res.end("fast");
    return;
  }
  setTimeout(() => res.end(`work ${delay}`), delay);
});
setTimeout(
  () => {
    server.listen(port, "127.0.0.1", () => process.stdout.write(`listening ${port}\n`));
  },
  Number(process.env.START_DELAY_MS ?? 0),
);

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
const directory = resolve(".local/development"),
  file = resolve(directory, "config.json");
if (existsSync(file))
  throw new Error(
    "Local configuration already exists; refusing to overwrite it",
  );
const config = JSON.parse(
  readFileSync(
    new URL("../config/cobuild.local.example.json", import.meta.url),
  ),
);
config.modules = ["platform", "kick"];
const reservations = [];
try {
  for (const app of ["platform", "makit", "weknow"]) {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    config.origins[app] = "http://127.0.0.1:" + server.address().port;
    reservations.push(server);
  }
} finally {
  await Promise.all(
    reservations.map((server) => new Promise((r) => server.close(r))),
  );
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
writeFileSync(file, JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(
  JSON.stringify({
    config: file,
    data: resolve(directory, "data"),
    platform: config.origins.platform,
    next: "npm run local:platform",
    note: "Platform preview only. Run npm run test:local-suite to verify all three disposable core services.",
  }),
);

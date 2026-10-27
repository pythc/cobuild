import { readFileSync } from "node:fs";
import { localApplicationEnvironment } from "../packages/config/local-environment.mjs";
const [filename, organizationId] = process.argv.slice(2);
const config = JSON.parse(readFileSync(filename, "utf8"));
console.log(
  JSON.stringify(
    Object.fromEntries(
      ["makit", "weknow"].map((id) => [
        id,
        localApplicationEnvironment(config, id, organizationId),
      ]),
    ),
  ),
);

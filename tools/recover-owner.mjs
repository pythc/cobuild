import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { validateConfig } from "../packages/config/index.mjs";
import { openSuiteAuth } from "../apps/platform/server/suite-auth-store.mjs";
if (!process.env.COBUILD_CONFIG || !process.env.COBUILD_DATA_DIR)
  throw Error("Explicit COBUILD_CONFIG and COBUILD_DATA_DIR required");
const directory = resolve(process.env.COBUILD_DATA_DIR);
if (!existsSync(join(directory, "identity.sqlite")))
  throw Error("Existing identity database required");
const config = validateConfig(
  JSON.parse(readFileSync(process.env.COBUILD_CONFIG, "utf8")),
);
const output = join(directory, "owner-recovery-" + Date.now() + ".private.txt");
const store = openSuiteAuth({ directory, config });
try {
  const result = store.recoverOwner();
  writeFileSync(
    output,
    config.origins.platform + "/reset-password#token=" + result.token + "\n",
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    JSON.stringify({
      recoveryFile: output,
      expiresAt: result.expiresAt,
      note: "Open privately; never paste this link into logs or chat. Previous recovery links are invalid.",
    }),
  );
} finally {
  store.close();
}

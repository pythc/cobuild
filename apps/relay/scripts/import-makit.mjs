import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RelayStore } from "../server/store.mjs";
const [directory, input] = process.argv.slice(2);
if (!directory || !input)
  throw Error("Expected private database directory and export folder");
const store = new RelayStore(directory);
try {
  const rows = (name) => {
    const value = JSON.parse(readFileSync(join(input, name + ".json"), "utf8"));
    if (!Array.isArray(value) || value.length >= 5000)
      throw Error("Incomplete migration export");
    return value;
  };
  const contacts = rows("relay_chatwoot_contact"),
    conversations = rows("relay_chatwoot_conversation"),
    operations = rows("relay_chatwoot_operation"),
    intents = rows("relay_ticket_intake");
  store.transaction(() => {
    if (
      store.db.prepare("SELECT count(*) AS n FROM conversations").get().n ||
      store.db.prepare("SELECT count(*) AS n FROM operations").get().n
    )
      throw Error("Migration requires an unused database");
    for (const r of contacts)
      store.db
        .prepare("INSERT INTO contacts VALUES(?,?,?,?)")
        .run(r.principal, r.app, r.source_id, Number(r.contact_id));
    for (const r of conversations)
      store.db
        .prepare("INSERT INTO conversations VALUES(?,?,?,?,?,?)")
        .run(
          r.id,
          r.principal,
          r.app,
          Number(r.remote_id),
          r.source_id,
          new Date(r.created_at).toISOString(),
        );
    for (const r of operations) {
      if (
        !["done", "preparing", "writing", "unknown", "failed"].includes(r.state)
      )
        throw Error("Unknown operation state");
      store.db
        .prepare("INSERT INTO operations VALUES(?,?,?,?,?,?,?)")
        .run(
          r.marker,
          r.payload_hash,
          r.state,
          r.lease_token,
          Date.parse(r.lease_expires_at),
          r.response_json,
          Date.parse(r.updated_at),
        );
    }
    for (const r of intents) {
      if (r.state !== "linked" || !r.requirement_id)
        throw Error("Unsettled native ticket needs explicit reconciliation");
      store.saveIntent(r);
    }
  });
  console.log(
    JSON.stringify({
      imported: {
        contacts: contacts.length,
        conversations: conversations.length,
        operations: operations.length,
        intents: intents.length,
      },
      historicalNotifications: 0,
    }),
  );
} finally {
  store.close();
}

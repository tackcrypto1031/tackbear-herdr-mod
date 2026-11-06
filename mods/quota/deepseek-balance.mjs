// Asks DeepSeek for the account balance and prints `{ status, body }` as JSON, or `{ login: false }`
// when no DeepSeek API key is set up. The key only goes to api.deepseek.com and is never printed.
// Run by the quota mod with node (22.5 or later, for node:sqlite).
//
// Where the key is looked for, first found wins:
//   DEEPSEEK_API_KEY
//   opencode's database: the `deepseek` row of its `credential` table (opencode 1.x)
//   opencode's auth.json: `deepseek.key` (older opencode)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");

function fromDatabase() {
  try {
    process.removeAllListeners("warning"); // node:sqlite is experimental on some versions and says so on stderr.
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(join(dataDir, "opencode.db"), { readOnly: true });
    try {
      const row = db.prepare("select value from credential where integration_id = 'deepseek' order by active desc, time_updated desc limit 1").get();
      return row ? JSON.parse(row.value)?.key ?? null : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function fromAuthFile() {
  try {
    return JSON.parse(readFileSync(join(dataDir, "auth.json"), "utf8"))?.deepseek?.key ?? null;
  } catch {
    return null;
  }
}

const key = process.env.DEEPSEEK_API_KEY || fromDatabase() || fromAuthFile();
if (!key) {
  console.log(JSON.stringify({ login: false }));
} else {
  try {
    const reply = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    console.log(JSON.stringify({ status: reply.status, body: reply.status === 200 ? await reply.text() : null }));
  } catch {
    console.log(JSON.stringify({ failed: true }));
  }
}

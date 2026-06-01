/**
 * Live smoke test — confirms the API key works and the server can talk to Draftboard.
 *
 *   DRAFTBOARD_API_KEY=... npm run smoke         # verifies get_me only
 *   DRAFTBOARD_API_KEY=... npm run smoke -- --full  # also runs intro_status_overview
 *
 * Never prints the API key.
 */
import { createClient, loadConfig } from "./config.js";
import { fullName } from "./normalize.js";
import { introStatusOverview } from "./tools/outcomes.js";

async function main(): Promise<void> {
  const full = process.argv.includes("--full");
  const client = createClient(loadConfig());

  process.stderr.write("→ get_me … ");
  const me = await client.getMe();
  const who = fullName(me.customer?.user) || me.customer?.name || me.customer?.id || "(unknown)";
  process.stderr.write(`ok: ${who}\n`);

  if (full) {
    process.stderr.write("→ intro_status_overview … ");
    const overview = await introStatusOverview(client, {});
    process.stderr.write(`ok: ${overview.total} target(s), byStatus=${JSON.stringify(overview.byStatus)}\n`);
  }

  process.stderr.write("smoke passed ✓\n");
}

main().catch((err) => {
  process.stderr.write(`smoke FAILED: ${(err as Error).message}\n`);
  process.exit(1);
});

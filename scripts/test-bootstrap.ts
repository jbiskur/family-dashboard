import { loadTestEnv, request, tokenFor } from "../tests/fixtures/auth";

await loadTestEnv();
const response = await request("access/admit", await tokenFor("owner"), {});
if (!response.ok)
  throw new Error(`Test household bootstrap failed: ${response.status}`);
console.log("Test household owner admitted for this isolated runner.");

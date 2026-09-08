import { createNodeTransport } from "@flowcore/pathways";

// A single API instance coordinates its pump through Postgres. Its unauthenticated
// cluster listener must never accept connections from another pod or host.
export function createLocalClusterTransport() {
  return createNodeTransport("127.0.0.1");
}

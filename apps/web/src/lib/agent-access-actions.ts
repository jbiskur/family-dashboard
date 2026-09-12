"use server";
import { getAgentAccessView } from "./oauth/server";

export async function loadAgentAccess() {
  try {
    return { ok: true as const, data: await getAgentAccessView() };
  } catch {
    return {
      ok: false as const,
      message:
        "Agent connections could not be loaded. Check your connection and sign in again if your session has ended.",
    };
  }
}

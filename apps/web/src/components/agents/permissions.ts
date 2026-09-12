import type { McpScope } from "@/lib/oauth/types";

export const permissions: Record<
  McpScope,
  { title: string; description: string }
> = {
  "heima.read": {
    title: "Read shopping and Work",
    description: "See the lists, tasks and household context available to you.",
  },
  "heima.shopping.write": {
    title: "Update shopping",
    description:
      "Add items, edit details, mark them bought and undo completion.",
  },
  "heima.work.write": {
    title: "Update Work",
    description:
      "Add tasks, edit details, mark them complete and undo completion.",
  },
  "heima.finance.read": {
    title: "Read finances",
    description:
      "See your permitted accounts, transactions and financial overview. No financial changes.",
  },
};

export function connectionTime(value: string) {
  return `${new Date(value).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

import type { ReactNode } from "react";
import { Authorized } from "@/components/shared/authorized";
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <Authorized>{children}</Authorized>;
}

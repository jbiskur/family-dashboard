import { AccountDetailPage } from "@/components/finance/accounts";
export default async function Page({
  params,
}: {
  params: Promise<{ accountId: string }>;
}) {
  return <AccountDetailPage id={(await params).accountId} />;
}

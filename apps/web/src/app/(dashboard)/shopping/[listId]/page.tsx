import { ShoppingDetailPage } from "@/components/shopping/shopping-pages";
export default async function Page({
  params,
}: {
  params: Promise<{ listId: string }>;
}) {
  return <ShoppingDetailPage id={(await params).listId} />;
}

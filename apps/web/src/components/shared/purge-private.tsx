"use client";
import { useEffect } from "react";
import { purgeOffline } from "@/lib/offline";
export function PurgePrivate() {
  useEffect(() => {
    purgeOffline();
  }, []);
  return null;
}

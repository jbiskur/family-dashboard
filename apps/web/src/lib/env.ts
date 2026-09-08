import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    AUTH_SECRET: z.string().min(32),
    AUTH_URL: z.string().url().default("http://localhost:3010"),
    DATABASE_URL: z.string().min(1),
    DATABASE_SCHEMA: z
      .string()
      .regex(/^heima_[a-z0-9_]+$/)
      .default("heima_dev"),
    HEIMA_API_URL: z.string().url().default("http://localhost:3211"),
    USABLE_CLIENT_ID: z
      .string()
      .uuid()
      .default("8030ec37-eeab-4f99-adf5-35424e7fee63"),
    USABLE_CLIENT_SECRET: z.string().min(1),
    USABLE_ISSUER: z
      .string()
      .url()
      .default("https://auth.flowcore.io/realms/memory-mesh"),
  },
  experimental__runtimeEnv: process.env,
  emptyStringAsUndefined: true,
  skipValidation: process.env.NEXT_PHASE === "phase-production-build",
});

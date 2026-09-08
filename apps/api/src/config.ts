import { z } from "zod";

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).default(3211),
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: z
    .string()
    .regex(/^heima_[a-z0-9_]{1,30}$/)
    .default("heima_dev"),
  USABLE_APP_ID: z
    .string()
    .uuid()
    .default("8030ec37-eeab-4f99-adf5-35424e7fee63"),
  USABLE_OIDC_ISSUER: z
    .string()
    .url()
    .default("https://auth.flowcore.io/realms/memory-mesh"),
  USABLE_API_BASE_URL: z.string().url().default("https://usable.dev"),
  APP_OWNER_USER_ID: z
    .string()
    .uuid()
    .default("4c681d95-26f0-4702-b33a-2d452aca2ec4"),
  HOUSEHOLD_ID: z
    .string()
    .uuid()
    .default("f78b38cf-27b5-4b46-984b-8bc115e9f910"),
  FLOWCORE_API_KEY: z.string().min(1),
  FLOWCORE_TENANT: z.string().min(1).default("jbiskur"),
  FLOWCORE_DATA_CORE: z.string().min(1).default("heima-development"),
  FLOWCORE_WEBHOOK_BASE_URL: z
    .string()
    .url()
    .default("https://webhook.api.flowcore.io"),
  PATHWAYS_ENCRYPTION_KEY: z.string().min(32),
  PATHWAYS_CLUSTER_PORT: z.coerce.number().int().default(9091),
  PATHWAYS_CLUSTER_ADVERTISED_ADDRESS: z
    .literal("127.0.0.1")
    .default("127.0.0.1"),
  TEST_TRANSFORMER_SECRET: z.string().optional(),
  TEST_MAINTENANCE_CLOCK_URL: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname) &&
        url.pathname === "/__maintenance-clock" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, "Maintenance clock fixture must be a local test dependency")
    .optional(),
  AUTH_SECRET: z.string().min(32).optional(),
  USABLE_CLIENT_SECRET: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:julius@flowcore.io"),
});

export const config = schema.parse(process.env);
if (config.NODE_ENV !== "test" && config.TEST_MAINTENANCE_CLOCK_URL)
  throw new Error("Maintenance clock fixture is test-only");
if (
  config.NODE_ENV !== "test" &&
  (config.USABLE_API_BASE_URL !== "https://usable.dev" ||
    config.USABLE_OIDC_ISSUER !== "https://auth.flowcore.io/realms/memory-mesh")
)
  throw new Error("Custom identity providers are test-only");
if (config.NODE_ENV === "production" && config.DATABASE_SCHEMA !== "heima_prod")
  throw new Error("Production requires heima_prod schema");
if (
  config.NODE_ENV === "production" &&
  config.APP_OWNER_USER_ID !== "4c681d95-26f0-4702-b33a-2d452aca2ec4"
)
  throw new Error(
    "Production owner differs from the configured household owner",
  );

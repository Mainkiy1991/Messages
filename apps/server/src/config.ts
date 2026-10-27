import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1).optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid server configuration: ${issues}`);
  }
  const parsed = result.data;
  const production = parsed.NODE_ENV === "production";
  if (production && !parsed.DATABASE_URL)
    throw new Error(
      "Invalid server configuration: DATABASE_URL is required in production",
    );
  const origins = (
    parsed.ALLOWED_ORIGINS ?? (production ? "" : "http://localhost:5173")
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (production && origins.length === 0)
    throw new Error(
      "Invalid server configuration: ALLOWED_ORIGINS is required in production",
    );
  const validatedOrigins = z.array(z.string().url()).safeParse(origins);
  if (!validatedOrigins.success)
    throw new Error(
      "Invalid server configuration: ALLOWED_ORIGINS must contain valid URLs",
    );
  return {
    HOST: parsed.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    PORT: parsed.PORT,
    DATABASE_URL: parsed.DATABASE_URL ?? "",
    ALLOWED_ORIGINS: validatedOrigins.data,
    TRUST_PROXY: parsed.TRUST_PROXY,
  };
}

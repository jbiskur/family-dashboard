// Explicitly isolated verification process only; never loaded by the app.
if (process.env.DATABASE_SCHEMA?.startsWith("heima_oauthproof_")) {
  const offset = Number(process.env.HEIMA_OAUTH_TEST_CLOCK_OFFSET ?? "0");
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 31 * 24 * 60 * 60 * 1000
  )
    throw new Error("Invalid isolated OAuth verification clock");
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + offset;
} else {
  throw new Error("OAuth verification clock requires an isolated schema");
}

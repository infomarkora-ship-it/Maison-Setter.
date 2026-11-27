const path = require("node:path");
function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    /* A postgres:// DATABASE_URL always wins, so Railway switches to PostgreSQL by just linking a database.
       Without it the server keeps using the SQLite file (local dev, tests). */
    dbPath: env.DATABASE_URL || env.DB_PATH || path.join(process.cwd(), "data", "magnetengine.db"),
    adminPassword: env.ADMIN_PASSWORD || "",
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    anthropicBase: (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, ""),
    haikuModel: env.HAIKU_MODEL || "claude-haiku-5-5",
    /* Gemini (the second AI provider). GEMINI_API_KEY can also be stored from Settings in the dashboard. */
    geminiKey: env.GEMINI_API_KEY || "",
    geminiModel: env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    /* Which provider reviews and drafts: "haiku" or "gemini". "" = automatic (haiku if its key exists, else gemini). */
    aiProvider: ["haiku", "gemini"].includes(env.AI_PROVIDER) ? env.AI_PROVIDER : "",
    dailyTokenCap: Number(env.HAIKU_DAILY_TOKEN_CAP) || 400_000,
    publicUrl: (env.PUBLIC_URL || "").replace(/\/$/, ""),
    defaultTz: env.DEFAULT_TZ || "America/New_York",
    allowPrivateFetch: env.ALLOW_PRIVATE_FETCH === "1"      // tests only: lets enrichment reach localhost
  };
}
module.exports = { loadConfig };

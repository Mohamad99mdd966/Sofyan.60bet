const fs = require("fs");
const path = require("path");

function loadEnvFile(envPath) {
  const vars = {};
  if (!fs.existsSync(envPath)) return vars;

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let val = line.slice(eqIndex + 1).trim();

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

const fileEnv = loadEnvFile(path.resolve(__dirname, ".env"));

const baseEnv = {
  NODE_ENV: fileEnv.NODE_ENV || process.env.NODE_ENV || "development",
  HOST: fileEnv.HOST || process.env.HOST || "0.0.0.0",
  PORT: fileEnv.PORT || process.env.PORT || "8080",
  SERVER_URL: fileEnv.SERVER_URL || process.env.SERVER_URL || "http://localhost:8080",
  WS_URL: fileEnv.WS_URL || process.env.WS_URL || "ws://localhost:8080",
  ADMIN_API_TOKEN: fileEnv.ADMIN_API_TOKEN || process.env.ADMIN_API_TOKEN || "change_this_admin_api_token",
  ADMIN_SECRET_CODE: fileEnv.ADMIN_SECRET_CODE || process.env.ADMIN_SECRET_CODE || "11228",
  ADMIN_SESSION_TTL_MS: fileEnv.ADMIN_SESSION_TTL_MS || process.env.ADMIN_SESSION_TTL_MS || "86400000",
  STATE_FILE_PATH: fileEnv.STATE_FILE_PATH || process.env.STATE_FILE_PATH || "./casino-state.json",
  STATE_SAVE_INTERVAL_MS: fileEnv.STATE_SAVE_INTERVAL_MS || process.env.STATE_SAVE_INTERVAL_MS || "5000",
  BACKUP_DIR: fileEnv.BACKUP_DIR || process.env.BACKUP_DIR || "./backups",
  REMOTE_BACKUP_TARGET: fileEnv.REMOTE_BACKUP_TARGET || process.env.REMOTE_BACKUP_TARGET || "",
  BACKUP_RETENTION_DAYS: fileEnv.BACKUP_RETENTION_DAYS || process.env.BACKUP_RETENTION_DAYS || "14"
};

const appName = fileEnv.PM2_APP_NAME || process.env.PM2_APP_NAME || "sofyan-60bet-server";
const maxMemoryRestart = fileEnv.PM2_MAX_MEMORY_RESTART || process.env.PM2_MAX_MEMORY_RESTART || "512M";
const logDir = fileEnv.PM2_LOG_DIR || process.env.PM2_LOG_DIR || "./logs";

module.exports = {
  apps: [
    {
      name: appName,
      script: "server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: maxMemoryRestart,
      restart_delay: 2000,
      kill_timeout: 5000,
      env: {
        ...baseEnv,
        NODE_ENV: "development"
      },
      env_production: {
        ...baseEnv,
        NODE_ENV: "production"
      },
      out_file: path.join(logDir, "pm2-out.log"),
      error_file: path.join(logDir, "pm2-error.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss"
    }
  ]
};

const fs = require("fs");
const path = require("path");

function loadDotEnv(envPath = path.join(__dirname, ".env")) {
  if (!fs.existsSync(envPath)) return {};
  const vars = {};
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
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

const dotEnvVars = loadDotEnv();

module.exports = {
  apps: [
    {
      name: "sofyan-60bet-server",
      script: "./server.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      kill_timeout: 5000,
      wait_ready: false,
      out_file: path.join(__dirname, "logs", "out.log"),
      error_file: path.join(__dirname, "logs", "error.log"),
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: "production",
        PORT: "8080",
        FOOTBALL_API_KEY: "",
        FOOTBALL_API_HOST: "v3.football.api-sports.io",
        FOOTBALL_POLL_MS: "90000",
        ADMIN_SECRET_CODE: "11228",
        ADMIN_API_TOKEN: "change_this_to_a_strong_secret_token",
        STATE_FILE_PATH: path.join(__dirname, "casino-state.json"),
        AUTOSAVE_INTERVAL_MS: "5000",
        BACKUP_DIR: path.join(__dirname, "backups"),
        BACKUP_INTERVAL_MS: "21600000",
        MAX_BACKUPS: "20",
        ...dotEnvVars
      }
    }
  ]
};

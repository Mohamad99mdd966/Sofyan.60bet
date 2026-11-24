const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || path.join(dataDir, "sofyan.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    demo_balance INTEGER NOT NULL DEFAULT 10000000,
    real_balance INTEGER NOT NULL DEFAULT 500000,
    is_banned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    mode TEXT NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    ref_id TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    username TEXT NOT NULL,
    method TEXT NOT NULL,
    amount INTEGER NOT NULL,
    details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
}

function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function ensureUser(username, profile = {}) {
  const cleanUser = String(username || "مهمان").trim() || "مهمان";
  const existing = db.prepare("SELECT * FROM users WHERE username = ?").get(cleanUser);
  if (existing) return existing;

  const { hash, salt } = hashPassword(profile.password || crypto.randomBytes(12).toString("hex"));
  const stmt = db.prepare(`
    INSERT INTO users (username, full_name, phone, email, password_hash, salt, demo_balance, real_balance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    cleanUser,
    profile.fullName || cleanUser,
    profile.phone || "",
    profile.email || "",
    hash,
    salt,
    Number.isFinite(profile.demo) ? Math.round(profile.demo) : 10000000,
    Number.isFinite(profile.real) ? Math.round(profile.real) : 500000,
    new Date().toISOString()
  );
  return db.prepare("SELECT * FROM users WHERE username = ?").get(cleanUser);
}

const applyBalanceChangeTx = db.transaction(({ username, mode, type, delta, refId = "", note = "" }) => {
  const user = ensureUser(username);
  if (user.is_banned) {
    throw new Error("حساب کاربری مسدود است.");
  }
  const col = mode === "real" ? "real_balance" : "demo_balance";
  const currentBal = Number(user[col] || 0);
  const change = Math.round(Number(delta || 0));
  const nextBal = currentBal + change;

  if (nextBal < 0) {
    throw new Error("موجودی کافی نیست.");
  }

  db.prepare(`UPDATE users SET ${col} = ? WHERE username = ?`).run(nextBal, user.username);
  db.prepare(`
    INSERT INTO transactions (username, mode, type, amount, balance_after, ref_id, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user.username, mode === "real" ? "real" : "demo", type, change, nextBal, refId, note, new Date().toISOString());

  return {
    username: user.username,
    demo_balance: col === "demo_balance" ? nextBal : user.demo_balance,
    real_balance: col === "real_balance" ? nextBal : user.real_balance
  };
});

function changeBalance({ username, mode = "demo", type = "game", delta = 0, refId = "", note = "" }) {
  return applyBalanceChangeTx({ username, mode, type, delta, refId, note });
}

function getUserPublic(username) {
  const u = ensureUser(username);
  return {
    username: u.username,
    fullName: u.full_name,
    phone: u.phone,
    email: u.email,
    demo: u.demo_balance,
    real: u.real_balance,
    isBanned: Boolean(u.is_banned)
  };
}

function listUsersPublic() {
  return db.prepare("SELECT username, full_name, phone, email, demo_balance, real_balance, is_banned FROM users").all().map((u) => ({
    username: u.username,
    fullName: u.full_name,
    phone: u.phone,
    email: u.email,
    demo: u.demo_balance,
    real: u.real_balance,
    isBanned: Boolean(u.is_banned)
  }));
}

function getRecentTransactions(username, limit = 50) {
  return db.prepare(`
    SELECT id, mode, type, amount, balance_after, ref_id, note, created_at
    FROM transactions WHERE username = ? ORDER BY id DESC LIMIT ?
  `).all(username, limit);
}

module.exports = {
  db,
  hashPassword,
  verifyPassword,
  getSetting,
  setSetting,
  ensureUser,
  changeBalance,
  getUserPublic,
  listUsersPublic,
  getRecentTransactions
};

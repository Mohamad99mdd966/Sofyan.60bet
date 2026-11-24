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

  CREATE TABLE IF NOT EXISTS football_bets (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    match_id TEXT NOT NULL,
    match_label TEXT NOT NULL,
    market TEXT NOT NULL,
    odd REAL NOT NULL,
    stake INTEGER NOT NULL,
    potential_payout INTEGER NOT NULL,
    mode TEXT NOT NULL DEFAULT 'demo',
    status TEXT NOT NULL DEFAULT 'open',
    payout INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    settled_at TEXT DEFAULT ''
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

const placeFootballBetTx = db.transaction(({ id, username, matchId, matchLabel, market, odd, stake, mode }) => {
  const cleanMode = mode === "real" ? "real" : "demo";
  const cleanStake = Math.round(Number(stake || 0));
  const cleanOdd = Number(odd || 1);
  const potential = Math.round(cleanStake * cleanOdd);

  changeBalance({
    username,
    mode: cleanMode,
    type: "football_bet",
    delta: -cleanStake,
    refId: id,
    note: `شرط فوتبال: ${matchLabel} (${market})`
  });

  db.prepare(`
    INSERT INTO football_bets (id, username, match_id, match_label, market, odd, stake, potential_payout, mode, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(id, username, String(matchId), matchLabel, market, cleanOdd, cleanStake, potential, cleanMode, new Date().toISOString());

  return { id, potential, mode: cleanMode, odd: cleanOdd, stake: cleanStake };
});

function createFootballBet(payload) {
  return placeFootballBetTx(payload);
}

function getOpenFootballBetsByMatch(matchId) {
  return db.prepare(`
    SELECT * FROM football_bets WHERE match_id = ? AND status = 'open'
  `).all(String(matchId));
}

const settleFootballBetTx = db.transaction(({ betId, won, payout, note }) => {
  const bet = db.prepare("SELECT * FROM football_bets WHERE id = ? AND status = 'open'").get(betId);
  if (!bet) return null;

  const finalPayout = won ? Math.round(Number(payout || bet.potential_payout)) : 0;
  const status = won ? "won" : "lost";

  db.prepare(`
    UPDATE football_bets SET status = ?, payout = ?, settled_at = ? WHERE id = ?
  `).run(status, finalPayout, new Date().toISOString(), betId);

  if (won && finalPayout > 0) {
    changeBalance({
      username: bet.username,
      mode: bet.mode,
      type: "football_win",
      delta: finalPayout,
      refId: betId,
      note: note || `برد شرط فوتبال: ${bet.match_label}`
    });
  }

  return { ...bet, status, payout: finalPayout };
});

function settleFootballBet(params) {
  return settleFootballBetTx(params);
}

function getUserFootballBets(username, limit = 30) {
  return db.prepare(`
    SELECT * FROM football_bets WHERE username = ? ORDER BY created_at DESC LIMIT ?
  `).all(username, limit);
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
  createFootballBet,
  getOpenFootballBetsByMatch,
  settleFootballBet,
  getUserFootballBets,
  getUserPublic,
  listUsersPublic,
  getRecentTransactions
};

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "sofyan-admin-token-2026");
const STATE_FILE = path.join(__dirname, "casino-state.json");
const BACKUP_DIR = path.join(__dirname, "backups");

const DEFAULT_DEMO_BALANCE = 10000000;
const DEFAULT_REAL_BALANCE = 500000;
const DEFAULT_SECRET_CODE = "7799";
const INITIAL_HISTORY = [1.42, 2.85, 1.18, 4.6, 1.94, 3.12];

function ensureDirs() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, keyHex] = storedHash.split(":");
  const keyBuf = Buffer.from(keyHex, "hex");
  const derivedBuf = crypto.scryptSync(String(password), salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

function createInitialState() {
  return {
    secretCode: DEFAULT_SECRET_CODE,
    users: {},
    guestWallets: {
      مهمان: {
        username: "مهمان",
        fullName: "کاربر مهمان",
        phone: "",
        email: "",
        demo: DEFAULT_DEMO_BALANCE,
        real: DEFAULT_REAL_BALANCE,
        txs: [],
        footballBets: []
      }
    },
    shared: {
      ownerActor: null,
      subAdmins: {},
      deposits: [],
      withdrawals: [],
      usersBalanceAdjustments: {},
      auditLogs: []
    },
    crashHistory: [...INITIAL_HISTORY],
    chat: {
      locked: false,
      slowModeSec: 0,
      pinnedId: null,
      mutedUsers: {},
      messages: [
        {
          id: "m_welcome",
          user: "سیستم",
          text: "به میز زنده صوفیان بت خوش آمدید.",
          time: new Date().toLocaleTimeString("fa-IR"),
          isAdmin: true,
          deleted: false
        }
      ]
    }
  };
}

function loadState() {
  ensureDirs();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      const base = createInitialState();
      return {
        ...base,
        ...raw,
        users: raw.users || {},
        guestWallets: { ...base.guestWallets, ...(raw.guestWallets || {}) },
        shared: { ...base.shared, ...(raw.shared || {}) },
        crashHistory: Array.isArray(raw.crashHistory) && raw.crashHistory.length ? raw.crashHistory : [...INITIAL_HISTORY],
        chat: { ...base.chat, ...(raw.chat || {}) }
      };
    }
  } catch (err) {
    console.error("Error loading state:", err.message);
  }
  const init = createInitialState();
  saveState(init);
  return init;
}

let state = loadState();
let saveTimer = null;

function saveState(target = state) {
  try {
    ensureDirs();
    fs.writeFileSync(STATE_FILE, JSON.stringify(target, null, 2), "utf8");
  } catch (err) {
    console.error("Error saving state:", err.message);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState(state), 200);
}

function addAuditLog(actor, action) {
  state.shared.auditLogs = state.shared.auditLogs || [];
  state.shared.auditLogs.unshift({
    id: "log_" + Date.now() + "_" + Math.floor(Math.random() * 999),
    time: new Date().toLocaleTimeString("fa-IR"),
    actor: actor || "سیستم",
    action
  });
  if (state.shared.auditLogs.length > 120) state.shared.auditLogs.length = 120;
  scheduleSave();
}

function getOrCreateWallet(username) {
  const uname = String(username || "مهمان").trim() || "مهمان";
  if (state.users[uname]) {
    const u = state.users[uname];
    u.demo = Math.max(0, Number(u.demo ?? DEFAULT_DEMO_BALANCE));
    u.real = Math.max(0, Number(u.real ?? DEFAULT_REAL_BALANCE));
    u.txs = Array.isArray(u.txs) ? u.txs : [];
    u.footballBets = Array.isArray(u.footballBets) ? u.footballBets : [];
    return u;
  }
  if (!state.guestWallets[uname]) {
    state.guestWallets[uname] = {
      username: uname,
      fullName: uname === "مهمان" ? "کاربر مهمان" : uname,
      phone: "",
      email: "",
      demo: DEFAULT_DEMO_BALANCE,
      real: DEFAULT_REAL_BALANCE,
      txs: [],
      footballBets: []
    };
  }
  const gw = state.guestWallets[uname];
  gw.demo = Math.max(0, Number(gw.demo ?? DEFAULT_DEMO_BALANCE));
  gw.real = Math.max(0, Number(gw.real ?? DEFAULT_REAL_BALANCE));
  gw.txs = Array.isArray(gw.txs) ? gw.txs : [];
  gw.footballBets = Array.isArray(gw.footballBets) ? gw.footballBets : [];
  return gw;
}

function mutateBalance(username, mode, delta, type, note) {
  const w = getOrCreateWallet(username);
  const m = mode === "real" ? "real" : "demo";
  const amt = Number(delta || 0);
  w[m] = Math.max(0, Number(w[m] || 0) + amt);
  w.txs.unshift({
    id: "tx_" + Date.now() + "_" + Math.floor(Math.random() * 9999),
    created_at: Date.now(),
    type: type || "تراکنش",
    mode: m,
    amount: amt,
    balance_after: w[m],
    note: note || ""
  });
  if (w.txs.length > 100) w.txs.length = 100;
  scheduleSave();
  return w[m];
}

function sanitizeUserPublic(w) {
  return {
    username: w.username,
    fullName: w.fullName || w.username,
    phone: w.phone || "",
    email: w.email || "",
    demo: Number(w.demo || 0),
    real: Number(w.real || 0)
  };
}

const clients = new Set();
const clientMeta = new Map();
const gameSessions = new Map();

function getSession(ws) {
  if (!gameSessions.has(ws)) {
    gameSessions.set(ws, { mines: null, bj: null, lastChatAt: 0 });
  }
  return gameSessions.get(ws);
}

function wsSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {}
}

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try {
        ws.send(raw);
      } catch {}
    }
  }
}

function sendWalletSyncToUser(targetUsername) {
  const uname = String(targetUsername || "مهمان");
  const w = getOrCreateWallet(uname);
  for (const ws of clients) {
    const meta = clientMeta.get(ws) || {};
    const boundUser = meta.username || "مهمان";
    if (boundUser === uname || (uname === "مهمان" && !meta.username)) {
      wsSend(ws, {
        type: "WALLET_SYNC",
        wallet: sanitizeUserPublic(w),
        txs: w.txs.slice(0, 80),
        footballBets: w.footballBets.slice(0, 50)
      });
    }
  }
}

function broadcastSharedSync(toastMessage = null) {
  broadcast({
    type: "SHARED_SYNC",
    shared: state.shared,
    chat: state.chat,
    crashHistory: state.crashHistory,
    toast: toastMessage
  });
}

function broadcastChatSync() {
  broadcast({
    type: "CHAT_SYNC",
    chat: state.chat
  });
}

/* ================= CRASH ENGINE ================= */
let roundIndex = 1;
let roundPhase = "waiting"; // waiting | running | crashed
let phaseStartedAt = Date.now();
let waitingDurationMs = 4500;
let runningDurationMs = 6000;
let crashedHoldMs = 2500;
let currentTarget = 2.15;
let currentMult = 1.0;

function generateCrashTarget() {
  const r = Math.random();
  if (r < 0.04) return 1.0;
  const raw = 0.98 / Math.max(0.05, 1 - r * 0.94);
  return Number(Math.min(25, Math.max(1.05, raw)).toFixed(2));
}

function startWaitingPhase() {
  roundIndex += 1;
  roundPhase = "waiting";
  phaseStartedAt = Date.now();
  currentMult = 1.0;
  currentTarget = generateCrashTarget();
}

function startRunningPhase() {
  roundPhase = "running";
  phaseStartedAt = Date.now();
  runningDurationMs = Math.round(Math.min(14000, Math.max(2200, (currentTarget - 1) * 2800 + 2000)));
}

function startCrashedPhase() {
  roundPhase = "crashed";
  phaseStartedAt = Date.now();
  currentMult = currentTarget;
  state.crashHistory.unshift(currentTarget);
  if (state.crashHistory.length > 20) state.crashHistory.length = 20;
  scheduleSave();
}

function getRoundSnapshot() {
  const now = Date.now();
  const elapsed = Math.max(0, now - phaseStartedAt);
  let progressRatio = 0;
  let remainingSec = 0;

  if (roundPhase === "waiting") {
    remainingSec = Math.max(0, (waitingDurationMs - elapsed) / 1000);
    if (elapsed >= waitingDurationMs) {
      startRunningPhase();
    }
  } else if (roundPhase === "running") {
    progressRatio = Math.min(1, elapsed / runningDurationMs);
    currentMult = Number((1.0 + (currentTarget - 1.0) * Math.pow(progressRatio, 1.35)).toFixed(2));
    if (elapsed >= runningDurationMs || currentMult >= currentTarget) {
      startCrashedPhase();
    }
  } else if (roundPhase === "crashed") {
    progressRatio = 1;
    remainingSec = Math.max(0, (crashedHoldMs - elapsed) / 1000);
    if (elapsed >= crashedHoldMs) {
      startWaitingPhase();
    }
  }

  return {
    roundIndex,
    phase: roundPhase,
    mult: currentMult,
    target: currentTarget,
    progressRatio,
    remainingSec
  };
}

setInterval(() => {
  const snap = getRoundSnapshot();
  broadcast({
    type: "ROUND_TICK",
    round: snap,
    crashHistory: state.crashHistory
  });
}, 120);

/* ================= GAME HELPERS ================= */
function calcMinesMult(safeCount, minesCount) {
  let mult = 0.96;
  const total = 25;
  for (let i = 0; i < safeCount; i++) {
    mult *= (total - i) / (total - minesCount - i);
  }
  return Number(Math.max(1.0, mult).toFixed(2));
}

function drawCard() {
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const suits = [
    { suit: "♠", red: false },
    { suit: "♣", red: false },
    { suit: "♥", red: true },
    { suit: "♦", red: true }
  ];
  const r = ranks[Math.floor(Math.random() * ranks.length)];
  const s = suits[Math.floor(Math.random() * suits.length)];
  return { rank: r, suit: s.suit, red: s.red };
}

function bjScore(cards) {
  let sum = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === "A") { sum += 11; aces += 1; }
    else if (["K", "Q", "J", "10"].includes(c.rank)) sum += 10;
    else sum += Number(c.rank);
  }
  while (sum > 21 && aces > 0) { sum -= 10; aces -= 1; }
  return sum;
}

function resolveAdminSession(actor, code) {
  if (code && String(code).trim() === String(state.secretCode)) {
    state.shared.ownerActor = actor || "مدیر کل";
    scheduleSave();
    return { actor: actor || "مدیر کل", rank: "مدیر کل", isOwner: true, perms: { approveDep: true, manageWd: true, grantBal: true, modChat: true } };
  }
  const sub = state.shared.subAdmins && state.shared.subAdmins[actor];
  if (sub) {
    return { actor, rank: sub.rank || "زیر‌ادمین", isOwner: false, perms: sub.perms || {} };
  }
  return null;
}

function hasPerm(session, permKey) {
  return Boolean(session && (session.isOwner || (session.perms && session.perms[permKey])));
}

/* ================= WEBSOCKET HANDLERS ================= */
function handleWsMessage(ws, rawData) {
  let msg;
  try {
    msg = JSON.parse(String(rawData));
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== "string") return;

  const meta = clientMeta.get(ws) || { username: "مهمان", adminSession: null };
  const actor = String(msg.username || meta.username || "مهمان").trim() || "مهمان";

  switch (msg.type) {
    case "IDENTIFY": {
      meta.username = actor;
      clientMeta.set(ws, meta);
      const w = getOrCreateWallet(actor);
      wsSend(ws, {
        type: "SYNC_INIT",
        round: getRoundSnapshot(),
        crashHistory: state.crashHistory,
        chat: state.chat,
        shared: state.shared
      });
      wsSend(ws, {
        type: "WALLET_SYNC",
        wallet: sanitizeUserPublic(w),
        txs: w.txs.slice(0, 80),
        footballBets: w.footballBets.slice(0, 50)
      });
      break;
    }

    case "WALLET_SYNC": {
      const targetUser = String(msg.username || meta.username || "مهمان");
      const w = getOrCreateWallet(targetUser);
      wsSend(ws, {
        type: "WALLET_SYNC",
        wallet: sanitizeUserPublic(w),
        txs: w.txs.slice(0, 80),
        footballBets: w.footballBets.slice(0, 50)
      });
      break;
    }

    case "REGISTER_USER": {
      const username = String(msg.username || "").trim();
      const fullName = String(msg.fullName || "").trim();
      const phone = String(msg.phone || "").trim();
      const email = String(msg.email || "").trim();
      const password = String(msg.password || "");

      if (!/^[a-zA-Z0-9_.-]{3,24}$/.test(username)) {
        return wsSend(ws, { type: "AUTH_ERROR", message: "نام کاربری نامعتبر است." });
      }
      if (password.length < 6) {
        return wsSend(ws, { type: "AUTH_ERROR", message: "رمز عبور باید حداقل ۶ کاراکتر باشد." });
      }
      if (state.users[username]) {
        return wsSend(ws, { type: "AUTH_ERROR", message: "این نام کاربری قبلاً ثبت شده است." });
      }

      const newUser = {
        username,
        fullName: fullName || username,
        phone,
        email,
        passwordHash: hashPassword(password),
        demo: DEFAULT_DEMO_BALANCE,
        real: DEFAULT_REAL_BALANCE,
        txs: [
          {
            id: "tx_init_" + Date.now(),
            created_at: Date.now(),
            type: "افتتاح حساب",
            mode: "demo",
            amount: DEFAULT_DEMO_BALANCE,
            balance_after: DEFAULT_DEMO_BALANCE,
            note: "موجودی اولیه حساب"
          }
        ],
        footballBets: []
      };
      state.users[username] = newUser;
      meta.username = username;
      clientMeta.set(ws, meta);
      scheduleSave();
      addAuditLog(username, "ثبت‌نام کاربر جدید");

      wsSend(ws, { type: "AUTH_SUCCESS", user: sanitizeUserPublic(newUser) });
      sendWalletSyncToUser(username);
      break;
    }

    case "LOGIN_USER": {
      const ident = String(msg.username || "").trim();
      const password = String(msg.password || "");
      const matched = Object.values(state.users).find(
        (u) => u.username === ident || (u.phone && u.phone === ident)
      );
      if (!matched || !verifyPassword(password, matched.passwordHash)) {
        return wsSend(ws, { type: "AUTH_ERROR", message: "نام کاربری/موبایل یا رمز عبور اشتباه است." });
      }
      meta.username = matched.username;
      clientMeta.set(ws, meta);
      sendWalletSyncToUser(matched.username);
      wsSend(ws, { type: "AUTH_SUCCESS", user: sanitizeUserPublic(matched) });
      break;
    }

    case "AUTH_SECRET_CODE": {
      const code = String(msg.code || "").trim();
      const sess = resolveAdminSession(actor, code);
      if (!sess) {
        return wsSend(ws, { type: "TOAST", message: "کد مدیریت نامعتبر است." });
      }
      meta.adminSession = sess;
      clientMeta.set(ws, meta);
      addAuditLog(actor, `ورود به پنل مدیریت (${sess.rank})`);
      wsSend(ws, {
        type: "ADMIN_SESSION",
        session: sess,
        secretCode: sess.isOwner ? state.secretCode : null
      });
      broadcastSharedSync();
      break;
    }

    case "ADMIN_UPDATE_SECRET": {
      if (!meta.adminSession || !meta.adminSession.isOwner) {
        return wsSend(ws, { type: "TOAST", message: "فقط مدیر کل مجاز به تغییر کد است." });
      }
      const nextCode = String(msg.secretCode || "").trim();
      if (nextCode.length < 3) {
        return wsSend(ws, { type: "TOAST", message: "کد جدید باید حداقل ۳ کاراکتر باشد." });
      }
      state.secretCode = nextCode;
      scheduleSave();
      addAuditLog(actor, "تغییر کد مخفی مدیریت");
      wsSend(ws, { type: "ADMIN_SESSION", session: meta.adminSession, secretCode: state.secretCode });
      wsSend(ws, { type: "TOAST", message: "کد مخفی مدیریت به‌روزرسانی شد." });
      break;
    }

    case "ADMIN_ASSIGN_SUBADMIN": {
      if (!meta.adminSession || !meta.adminSession.isOwner) {
        return wsSend(ws, { type: "TOAST", message: "دسترسی کافی ندارید." });
      }
      const targetUser = String(msg.username || "").trim();
      if (!targetUser) return;
      state.shared.subAdmins[targetUser] = {
        username: targetUser,
        rank: String(msg.rank || "زیر‌ادمین"),
        perms: msg.perms || {}
      };
      scheduleSave();
      addAuditLog(actor, `افزودن زیر‌ادمین ${targetUser}`);
      broadcastSharedSync(`زیر‌ادمین ${targetUser} ثبت شد`);
      break;
    }

    case "ADMIN_REMOVE_SUBADMIN": {
      if (!meta.adminSession || !meta.adminSession.isOwner) {
        return wsSend(ws, { type: "TOAST", message: "دسترسی کافی ندارید." });
      }
      const targetUser = String(msg.username || "").trim();
      delete state.shared.subAdmins[targetUser];
      scheduleSave();
      addAuditLog(actor, `حذف زیر‌ادمین ${targetUser}`);
      broadcastSharedSync(`زیر‌ادمین ${targetUser} حذف شد`);
      break;
    }

    case "TOPUP_DEMO": {
      const amt = Math.min(50000000, Math.max(10000, Number(msg.amount || 5000000)));
      mutateBalance(actor, "demo", amt, "شارژ دمو", "شارژ حساب آزمایشی");
      sendWalletSyncToUser(actor);
      wsSend(ws, { type: "TOAST", message: `${amt.toLocaleString("fa-IR")} تومان به حساب دمو اضافه شد.` });
      break;
    }

    case "DEPOSIT_CREATE": {
      const dep = msg.deposit || {};
      const amount = Number(dep.amount || 0);
      if (amount < 10000) return;
      const item = {
        id: String(dep.id || "dep_" + Date.now()),
        time: dep.time || new Date().toLocaleTimeString("fa-IR"),
        user: String(dep.user || actor),
        method: String(dep.method || "کارت‌به‌کارت"),
        amount,
        ref: String(dep.ref || ""),
        status: "pending"
      };
      state.shared.deposits.unshift(item);
      scheduleSave();
      addAuditLog(item.user, `ثبت درخواست واریز ${amount.toLocaleString("fa-IR")} تومان`);
      broadcastSharedSync("درخواست واریز جدید ثبت شد");
      break;
    }

    case "WITHDRAW_CREATE": {
      const wd = msg.withdrawal || {};
      const amount = Number(wd.amount || 0);
      const user = String(wd.user || actor);
      const w = getOrCreateWallet(user);
      if (amount < 50000 || Number(w.real || 0) < amount) {
        return wsSend(ws, { type: "TOAST", message: "مبلغ نامعتبر یا موجودی واقعی ناکافی است." });
      }
      mutateBalance(user, "real", -amount, "برداشت وجه", `ثبت درخواست برداشت (${wd.method || "شبا"})`);
      const item = {
        id: String(wd.id || "wd_" + Date.now()),
        time: wd.time || new Date().toLocaleTimeString("fa-IR"),
        user,
        method: String(wd.method || "شبا بانکی"),
        amount,
        dest: String(wd.dest || ""),
        status: "pending"
      };
      state.shared.withdrawals.unshift(item);
      scheduleSave();
      sendWalletSyncToUser(user);
      addAuditLog(user, `ثبت درخواست برداشت ${amount.toLocaleString("fa-IR")} تومان`);
      broadcastSharedSync("درخواست برداشت جدید ثبت شد");
      break;
    }

    case "ADMIN_DECIDE_DEPOSIT": {
      if (!hasPerm(meta.adminSession, "approveDep")) {
        return wsSend(ws, { type: "TOAST", message: "مجوز تایید واریز ندارید." });
      }
      const dep = (state.shared.deposits || []).find((d) => d.id === msg.id);
      if (!dep || dep.status !== "pending") return;
      if (msg.approve) {
        dep.status = "approved";
        mutateBalance(dep.user, "real", dep.amount, "واریز تاییدشده", `کد پیگیری: ${dep.ref}`);
        sendWalletSyncToUser(dep.user);
        addAuditLog(actor, `تایید واریز ${dep.amount} تومان برای ${dep.user}`);
      } else {
        dep.status = "rejected";
        addAuditLog(actor, `رد واریز ${dep.amount} تومان برای ${dep.user}`);
      }
      scheduleSave();
      broadcastSharedSync(msg.approve ? "واریز تایید و شارژ شد" : "واریز رد شد");
      break;
    }

    case "ADMIN_DECIDE_WITHDRAW": {
      if (!hasPerm(meta.adminSession, "manageWd")) {
        return wsSend(ws, { type: "TOAST", message: "مجوز مدیریت برداشت ندارید." });
      }
      const wd = (state.shared.withdrawals || []).find((w) => w.id === msg.id);
      if (!wd || wd.status !== "pending") return;
      if (msg.approve) {
        wd.status = "approved";
        addAuditLog(actor, `تایید پرداخت برداشت ${wd.amount} تومان برای ${wd.user}`);
      } else {
        wd.status = "rejected";
        mutateBalance(wd.user, "real", wd.amount, "برگشت برداشت ردشده", `لغو درخواست برداشت ${wd.id}`);
        sendWalletSyncToUser(wd.user);
        addAuditLog(actor, `رد و برگشت برداشت ${wd.amount} تومان برای ${wd.user}`);
      }
      scheduleSave();
      broadcastSharedSync(msg.approve ? "برداشت تایید شد" : "برداشت رد و برگشت داده شد");
      break;
    }

    case "ADMIN_GRANT_REAL": {
      if (!hasPerm(meta.adminSession, "grantBal")) {
        return wsSend(ws, { type: "TOAST", message: "مجوز شارژ موجودی ندارید." });
      }
      const targetUser = String(msg.username || "").trim();
      const amount = Number(msg.amount || 500000);
      if (!targetUser || !amount) return;
      mutateBalance(targetUser, "real", amount, "شارژ ادمین", `شارژ توسط ${actor}`);
      state.shared.usersBalanceAdjustments[targetUser] = state.shared.usersBalanceAdjustments[targetUser] || { demoDelta: 0, realDelta: 0 };
      state.shared.usersBalanceAdjustments[targetUser].realDelta += amount;
      scheduleSave();
      sendWalletSyncToUser(targetUser);
      addAuditLog(actor, `شارژ ${amount} واقعی برای ${targetUser}`);
      broadcastSharedSync(`موجودی واقعی ${targetUser} افزایش یافت`);
      break;
    }

    /* ---- CHAT MODERATION ---- */
    case "CHAT_SEND": {
      const text = String(msg.text || "").trim().slice(0, 240);
      if (!text) return;
      const isMod = hasPerm(meta.adminSession, "modChat");
      if (state.chat.locked && !isMod) {
        return wsSend(ws, { type: "TOAST", message: "چت توسط مدیر قفل شده است." });
      }
      const muteUntil = state.chat.mutedUsers && state.chat.mutedUsers[actor];
      if (muteUntil && Date.now() < muteUntil && !isMod) {
        return wsSend(ws, { type: "TOAST", message: "حساب شما موقتاً در چت میوت است." });
      }
      const sess = getSession(ws);
      if (state.chat.slowModeSec > 0 && !isMod) {
        const diffSec = (Date.now() - (sess.lastChatAt || 0)) / 1000;
        if (diffSec < state.chat.slowModeSec) {
          return wsSend(ws, { type: "TOAST", message: `حالت آهسته فعال است (${state.chat.slowModeSec} ثانیه).` });
        }
      }
      sess.lastChatAt = Date.now();
      state.chat.messages.push({
        id: "m_" + Date.now() + "_" + Math.floor(Math.random() * 999),
        user: actor,
        text,
        time: new Date().toLocaleTimeString("fa-IR"),
        isAdmin: Boolean(meta.adminSession),
        deleted: false
      });
      if (state.chat.messages.length > 150) state.chat.messages.shift();
      scheduleSave();
      broadcastChatSync();
      break;
    }

    case "MOD_DELETE_MSG": {
      if (!hasPerm(meta.adminSession, "modChat")) return;
      const m = (state.chat.messages || []).find((x) => x.id === msg.msgId);
      if (m) m.deleted = true;
      if (state.chat.pinnedId === msg.msgId) state.chat.pinnedId = null;
      scheduleSave();
      broadcastChatSync();
      break;
    }

    case "MOD_PIN_MSG": {
      if (!hasPerm(meta.adminSession, "modChat")) return;
      state.chat.pinnedId = msg.msgId || null;
      scheduleSave();
      broadcastChatSync();
      break;
    }

    case "MOD_TOGGLE_LOCK": {
      if (!hasPerm(meta.adminSession, "modChat")) return;
      state.chat.locked = !state.chat.locked;
      scheduleSave();
      broadcastChatSync();
      break;
    }

    case "MOD_TOGGLE_SLOW": {
      if (!hasPerm(meta.adminSession, "modChat")) return;
      state.chat.slowModeSec = state.chat.slowModeSec > 0 ? 0 : Number(msg.seconds || 5);
      scheduleSave();
      broadcastChatSync();
      break;
    }

    case "MOD_CLEAR_CHAT": {
      if (!hasPerm(meta.adminSession, "modChat")) return;
      state.chat.messages = [];
      state.chat.pinnedId = null;
      scheduleSave();
      broadcastChatSync();
      break;
    }

    case "MOD_MUTE_USER": {
      if (!hasPerm(meta.adminSession, "modChat")) return;
      const target = String(msg.username || "").trim();
      const mins = Math.max(1, Number(msg.minutes || 10));
      if (!target) return;
      state.chat.mutedUsers = state.chat.mutedUsers || {};
      state.chat.mutedUsers[target] = Date.now() + mins * 60000;
      scheduleSave();
      broadcastChatSync();
      break;
    }

    case "MOD_UNMUTE_USER": {
      if (!hasPerm(meta.adminSession, "modChat")) return;
      const target = String(msg.username || "").trim();
      if (state.chat.mutedUsers) delete state.chat.mutedUsers[target];
      scheduleSave();
      broadcastChatSync();
      break;
    }

    /* ---- CRASH BETS ---- */
    case "CRASH_PLACE_BET": {
      const mode = msg.mode === "real" ? "real" : "demo";
      const bet = Math.round(Number(msg.bet || 0));
      const w = getOrCreateWallet(actor);
      if (bet < 1000 || Number(w[mode] || 0) < bet) {
        return wsSend(ws, { type: "TOAST", message: "مبلغ شرط نامعتبر یا موجودی ناکافی است." });
      }
      mutateBalance(actor, mode, -bet, "کرش (انفجار)", `شرط جایگاه ${msg.slot || 1} در راند #${msg.roundIndex}`);
      sendWalletSyncToUser(actor);
      break;
    }

    case "CRASH_CASHOUT": {
      const mode = msg.mode === "real" ? "real" : "demo";
      const payout = Math.max(0, Math.round(Number(msg.payout || 0)));
      if (payout > 0) {
        mutateBalance(actor, mode, payout, "کرش (انفجار)", `برداشت جایگاه ${msg.slot || 1} روی ${msg.mult}x`);
        sendWalletSyncToUser(actor);
      }
      break;
    }

    case "CRASH_CANCEL_BET": {
      const mode = msg.mode === "real" ? "real" : "demo";
      const refund = Math.max(0, Math.round(Number(msg.bet || 0)));
      if (refund > 0) {
        mutateBalance(actor, mode, refund, "کرش (انفجار)", `لغو شرط جایگاه ${msg.slot || 1}`);
        sendWalletSyncToUser(actor);
      }
      break;
    }

    /* ---- MINES ---- */
    case "MINES_START": {
      const mode = msg.mode === "real" ? "real" : "demo";
      const bet = Math.round(Number(msg.bet || 0));
      const count = Math.min(20, Math.max(1, Number(msg.count || 3)));
      const w = getOrCreateWallet(actor);
      if (bet < 1000 || Number(w[mode] || 0) < bet) {
        return wsSend(ws, { type: "TOAST", message: "مبلغ شرط نامعتبر یا موجودی ناکافی است." });
      }
      mutateBalance(actor, mode, -bet, "مین‌روب", `شروع بازی با ${count} مین`);
      const pool = Array.from({ length: 25 }, (_, i) => i);
      const mines = [];
      while (mines.length < count && pool.length) {
        mines.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      }
      const sess = getSession(ws);
      sess.mines = { active: true, bet, count, mode, mines, opened: [], mult: 1.0 };
      sendWalletSyncToUser(actor);
      wsSend(ws, { type: "MINES_STARTED", bet, count });
      break;
    }

    case "MINES_PICK": {
      const sess = getSession(ws);
      const g = sess.mines;
      const cell = Number(msg.cell);
      if (!g || !g.active || cell < 0 || cell > 24 || g.opened.includes(cell)) return;
      if (g.mines.includes(cell)) {
        g.active = false;
        wsSend(ws, { type: "MINES_HIT_MINE", cell, mines: g.mines });
      } else {
        g.opened.push(cell);
        g.mult = calcMinesMult(g.opened.length, g.count);
        const potential = Math.round(g.bet * g.mult);
        wsSend(ws, { type: "MINES_SAFE", cell, mult: g.mult, potential });
      }
      break;
    }

    case "MINES_CASHOUT": {
      const sess = getSession(ws);
      const g = sess.mines;
      if (!g || !g.active) return;
      g.active = false;
      const payout = Math.round(g.bet * g.mult);
      mutateBalance(actor, g.mode, payout, "مین‌روب", `برداشت سود روی ${g.mult.toFixed(2)}x`);
      sendWalletSyncToUser(actor);
      wsSend(ws, { type: "MINES_CASHED", payout, mult: g.mult });
      break;
    }

    /* ---- DICE ---- */
    case "PLAY_DICE": {
      const mode = msg.mode === "real" ? "real" : "demo";
      const bet = Math.round(Number(msg.bet || 0));
      const target = Math.min(95, Math.max(5, Number(msg.target || 50)));
      const dir = msg.dir === "under" ? "under" : "over";
      const w = getOrCreateWallet(actor);
      if (bet < 1000 || Number(w[mode] || 0) < bet) {
        return wsSend(ws, { type: "TOAST", message: "مبلغ نامعتبر یا موجودی ناکافی است." });
      }
      mutateBalance(actor, mode, -bet, "تاس", `شرط روی ${dir === "over" ? ">" : "<"} ${target}`);
      const roll = Math.floor(Math.random() * 100) + 1;
      const won = dir === "over" ? roll > target : roll < target;
      const winProb = dir === "over" ? (100 - target) / 100 : (target - 1) / 100;
      const mult = Math.max(1.02, Number((0.97 / Math.max(0.02, winProb)).toFixed(2)));
      const payout = won ? Math.round(bet * mult) : 0;
      if (payout > 0) mutateBalance(actor, mode, payout, "تاس", `برد تاس (${roll})`);
      sendWalletSyncToUser(actor);
      wsSend(ws, { type: "DICE_RESULT", roll, won, payout });
      break;
    }

    /* ---- ROULETTE ---- */
    case "PLAY_ROULETTE": {
      const mode = msg.mode === "real" ? "real" : "demo";
      const bet = Math.round(Number(msg.bet || 0));
      const pick = ["red", "black", "green"].includes(msg.pick) ? msg.pick : "red";
      const w = getOrCreateWallet(actor);
      if (bet < 1000 || Number(w[mode] || 0) < bet) {
        return wsSend(ws, { type: "TOAST", message: "مبلغ نامعتبر یا موجودی ناکافی است." });
      }
      mutateBalance(actor, mode, -bet, "رولت", `شرط روی ${pick}`);
      const redSet = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
      const num = Math.floor(Math.random() * 37);
      const color = num === 0 ? "green" : (redSet.has(num) ? "red" : "black");
      const won = color === pick;
      const mult = pick === "green" ? 14 : 2;
      const payout = won ? bet * mult : 0;
      if (payout > 0) mutateBalance(actor, mode, payout, "رولت", `برد رولت (${num})`);
      sendWalletSyncToUser(actor);
      wsSend(ws, { type: "ROULETTE_RESULT", num, color, won, payout });
      break;
    }

    /* ---- SLOTS ---- */
    case "PLAY_SLOTS": {
      const mode = msg.mode === "real" ? "real" : "demo";
      const bet = Math.round(Number(msg.bet || 0));
      const w = getOrCreateWallet(actor);
      if (bet < 1000 || Number(w[mode] || 0) < bet) {
        return wsSend(ws, { type: "TOAST", message: "مبلغ نامعتبر یا موجودی ناکافی است." });
      }
      mutateBalance(actor, mode, -bet, "اسلات", "اسپین گردونه اسلات");
      const syms = ["GEM", "CROWN", "STAR", "777", "BELL"];
      const reels = [0, 1, 2].map(() => syms[Math.floor(Math.random() * syms.length)]);
      const allSame = reels[0] === reels[1] && reels[1] === reels[2];
      const twoSame = reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2];
      const mult = allSame ? (reels[0] === "777" ? 15 : 6) : (twoSame ? 1.4 : 0);
      const payout = Math.round(bet * mult);
      const won = payout > 0;
      if (payout > 0) mutateBalance(actor, mode, payout, "اسلات", `برد اسلات (${reels.join(" ")})`);
      sendWalletSyncToUser(actor);
      wsSend(ws, { type: "SLOTS_RESULT", reels, won, payout });
      break;
    }

    /* ---- BLACKJACK ---- */
    case "BJ_DEAL": {
      const mode = msg.mode === "real" ? "real" : "demo";
      const bet = Math.round(Number(msg.bet || 0));
      const w = getOrCreateWallet(actor);
      if (bet < 1000 || Number(w[mode] || 0) < bet) {
        return wsSend(ws, { type: "TOAST", message: "مبلغ نامعتبر یا موجودی ناکافی است." });
      }
      mutateBalance(actor, mode, -bet, "بلک‌جک", "پخش کارت دست جدید");
      const player = [drawCard(), drawCard()];
      const dealer = [drawCard()];
      const sess = getSession(ws);
      sess.bj = { active: true, bet, mode, player, dealer };
      sendWalletSyncToUser(actor);
      wsSend(ws, {
        type: "BJ_STATE",
        status: "playing",
        player,
        dealer,
        playerSum: bjScore(player),
        dealerSum: bjScore(dealer)
      });
      break;
    }

    case "BJ_HIT": {
      const sess = getSession(ws);
      const g = sess.bj;
      if (!g || !g.active) return;
      g.player.push(drawCard());
      const pSum = bjScore(g.player);
      const dSum = bjScore(g.dealer);
      if (pSum > 21) {
        g.active = false;
        wsSend(ws, { type: "BJ_STATE", status: "bust", player: g.player, dealer: g.dealer, playerSum: pSum, dealerSum: dSum });
      } else {
        wsSend(ws, { type: "BJ_STATE", status: "playing", player: g.player, dealer: g.dealer, playerSum: pSum, dealerSum: dSum });
      }
      break;
    }

    case "BJ_STAND": {
      const sess = getSession(ws);
      const g = sess.bj;
      if (!g || !g.active) return;
      g.active = false;
      while (bjScore(g.dealer) < 17) g.dealer.push(drawCard());
      const pSum = bjScore(g.player);
      const dSum = bjScore(g.dealer);
      let outcome = "lose";
      let payout = 0;
      if (dSum > 21 || pSum > dSum) {
        outcome = "win";
        payout = g.bet * 2;
      } else if (pSum === dSum) {
        outcome = "push";
        payout = g.bet;
      }
      if (payout > 0) mutateBalance(actor, g.mode, payout, "بلک‌جک", `نتیجه بلک‌جک (${outcome})`);
      sendWalletSyncToUser(actor);
      wsSend(ws, { type: "BJ_STATE", status: "done", outcome, payout, player: g.player, dealer: g.dealer, playerSum: pSum, dealerSum: dSum });
      break;
    }

    /* ---- PLINKO ---- */
    case "PLAY_PLINKO": {
      const mode = msg.mode === "real" ? "real" : "demo";
      const bet = Math.round(Number(msg.bet || 0));
      const risk = msg.risk === "low" ? "low" : "high";
      const w = getOrCreateWallet(actor);
      if (bet < 1000 || Number(w[mode] || 0) < bet) {
        return wsSend(ws, { type: "TOAST", message: "مبلغ نامعتبر یا موجودی ناکافی است." });
      }
      mutateBalance(actor, mode, -bet, "پینکلو", `رها کردن توپ (${risk})`);
      const buckets = risk === "high" ? [6.5, 2.5, 1.2, 0.5, 1.2, 2.5, 6.5] : [2.2, 1.4, 1.1, 0.9, 1.1, 1.4, 2.2];
      const idx = Math.floor(Math.random() * buckets.length);
      const mult = buckets[idx];
      const payout = Math.round(bet * mult);
      if (payout > 0) mutateBalance(actor, mode, payout, "پینکلو", `برد پینکلو (${mult.toFixed(1)}x)`);
      sendWalletSyncToUser(actor);
      wsSend(ws, { type: "PLINKO_RESULT", bet, risk, idx, mult, payout });
      break;
    }

    /* ---- FOOTBALL PRE-MATCH BET ---- */
    case "PLACE_FOOTBALL_BET": {
      const mode = msg.mode === "real" ? "real" : "demo";
      const bet = Math.round(Number(msg.bet || 0));
      const w = getOrCreateWallet(actor);
      if (bet < 1000 || Number(w[mode] || 0) < bet) {
        return wsSend(ws, { type: "TOAST", message: "مبلغ شرط نامعتبر یا موجودی ناکافی است." });
      }
      mutateBalance(actor, mode, -bet, "فوتبال (قبل از شروع)", `مسابقه #${msg.matchId || ""}`);
      const odd = 2.0;
      const potential = Math.round(bet * odd);
      w.footballBets.unshift({
        id: "fb_" + Date.now(),
        matchId: String(msg.matchId || ""),
        kickoffTime: String(msg.kickoffTime || "--:--"),
        match_label: `مسابقه #${msg.matchId || "قبل از شروع"}`,
        market: String(msg.market || "home"),
        odd,
        stake: bet,
        mode,
        status: "ثبت‌شده (قبل از شروع)"
      });
      if (w.footballBets.length > 50) w.footballBets.length = 50;
      scheduleSave();
      sendWalletSyncToUser(actor);
      wsSend(ws, { type: "FOOTBALL_BET_ACCEPTED", bet, odd, potential });
      break;
    }

    default:
      break;
  }
}

/* ================= HTTP & ADMIN BACKUP ROUTES ================= */
function checkAdminHttpAuth(req) {
  const token = req.headers["x-admin-token"];
  return Boolean(token && String(token) === ADMIN_TOKEN);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) reject(new Error("Payload too large"));
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-token, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  if (pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, status: "running", roundIndex }));
  }

  if (pathname.startsWith("/api/admin/backups")) {
    if (!checkAdminHttpAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, message: "توکن ادمین نامعتبر است." }));
    }

    ensureDirs();

    if (pathname === "/api/admin/backups" && req.method === "GET") {
      const files = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse()
        .map((name) => {
          const stat = fs.statSync(path.join(BACKUP_DIR, name));
          return { id: name, name, size: stat.size, createdAt: stat.mtimeMs };
        });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, backups: files }));
    }

    if (pathname === "/api/admin/backups" && req.method === "POST") {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `backup-${stamp}.json`;
      fs.writeFileSync(path.join(BACKUP_DIR, filename), JSON.stringify(state, null, 2), "utf8");
      addAuditLog("HTTP-ADMIN", `ایجاد پشتیبان ${filename}`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, id: filename, name: filename }));
    }

    if (pathname === "/api/admin/backups/restore" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const targetName = path.basename(String(body.id || body.name || body.backupId || ""));
        const fullPath = path.join(BACKUP_DIR, targetName);
        if (!targetName || !fs.existsSync(fullPath)) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ ok: false, message: "فایل پشتیبان یافت نشد." }));
        }
        const restored = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        state = { ...createInitialState(), ...restored };
        saveState(state);
        addAuditLog("HTTP-ADMIN", `بازیابی پشتیبان ${targetName}`);
        broadcastSharedSync(`پشتیبان ${targetName} بازیابی شد`);
        for (const uname of [...Object.keys(state.users), ...Object.keys(state.guestWallets)]) {
          sendWalletSyncToUser(uname);
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: true, restored: targetName }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: false, message: err.message }));
      }
    }

    if (pathname.startsWith("/api/admin/backups/") && req.method === "DELETE") {
      const targetName = path.basename(decodeURIComponent(pathname.replace("/api/admin/backups/", "")));
      const fullPath = path.join(BACKUP_DIR, targetName);
      if (!targetName || !fs.existsSync(fullPath)) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ ok: false, message: "فایل پشتیبان یافت نشد." }));
      }
      fs.unlinkSync(fullPath);
      addAuditLog("HTTP-ADMIN", `حذف پشتیبان ${targetName}`);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true, deleted: targetName }));
    }
  }

  // Serve index.html if present alongside server.js
  const indexHtmlPath = path.join(__dirname, "index.html");
  if ((pathname === "/" || pathname === "/index.html") && req.method === "GET" && fs.existsSync(indexHtmlPath)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(indexHtmlPath));
  }

  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, service: "sofyan-bet-server", ws: true }));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  clients.add(ws);
  clientMeta.set(ws, { username: "مهمان", adminSession: null });
  getSession(ws);

  wsSend(ws, {
    type: "SYNC_INIT",
    round: getRoundSnapshot(),
    crashHistory: state.crashHistory,
    chat: state.chat,
    shared: state.shared
  });

  ws.on("message", (data) => handleWsMessage(ws, data));

  ws.on("close", () => {
    clients.delete(ws);
    clientMeta.delete(ws);
    gameSessions.delete(ws);
  });

  ws.on("error", () => {
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Sofyan Bet server listening on http://localhost:${PORT} (WS + HTTP ready)`);
});

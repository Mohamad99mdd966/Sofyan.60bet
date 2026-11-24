const http = require("http");
const WebSocket = require("ws");
const {
  getSetting,
  setSetting,
  ensureUser,
  verifyPassword,
  changeBalance,
  createFootballBet,
  getOpenFootballBetsByMatch,
  settleFootballBet,
  getUserFootballBets,
  getUserPublic,
  listUsersPublic,
  getRecentTransactions
} = require("./db");
const {
  POLL_INTERVAL_MS,
  refreshFootballMatches,
  resolveWinnerMarket
} = require("./footballService");

const PORT = process.env.PORT || 8080;
let SECRET_ADMIN_CODE = process.env.ADMIN_SECRET_CODE || getSetting("admin_secret_code", "11228");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("SOFYAN LIVE Persistent Server is Running");
});

const wss = new WebSocket.Server({ server });

const sharedState = {
  ownerActor: getSetting("owner_actor", null),
  subAdmins: JSON.parse(getSetting("sub_admins", "{}")),
  deposits: JSON.parse(getSetting("deposits", "[]")),
  withdrawals: JSON.parse(getSetting("withdrawals", "[]")),
  auditLogs: JSON.parse(getSetting("audit_logs", "[]")),
  crashHistory: JSON.parse(getSetting("crash_history", "[1.42, 2.85, 1.18, 4.60, 1.94, 3.12]")),
  chat: JSON.parse(getSetting("chat_state", JSON.stringify({
    locked: false,
    slowModeSec: 0,
    pinnedId: null,
    mutedUsers: {},
    messages: [
      { id: "m_welcome", user: "سیستم", text: "به صوفیان بت خوش آمدید! دیتابیس سرور فعال است.", time: "الان", isAdmin: true, deleted: false }
    ]
  }))),
  footballMatches: [
    { id: "m0", league: "لیگ برتر", home: "استقلال", away: "پرسپولیس", hScore: 1, aScore: 0, min: 34, status: "LIVE", hOdd: 2.15, dOdd: 3.10, aOdd: 3.05, ballX: 0.56, ballY: 0.48 },
    { id: "m1", league: "لالیگا", home: "رئال مادرید", away: "بارسلونا", hScore: 0, aScore: 0, min: 19, status: "LIVE", hOdd: 2.05, dOdd: 3.40, aOdd: 2.90, ballX: 0.44, ballY: 0.52 },
    { id: "m2", league: "لیگ قهرمانان", home: "منچستر سیتی", away: "بایرن مونیخ", hScore: 2, aScore: 1, min: 67, status: "LIVE", hOdd: 1.88, dOdd: 3.55, aOdd: 3.45, ballX: 0.62, ballY: 0.42 }
  ]
};

function persistShared() {
  setSetting("owner_actor", sharedState.ownerActor || "");
  setSetting("sub_admins", JSON.stringify(sharedState.subAdmins || {}));
  setSetting("deposits", JSON.stringify((sharedState.deposits || []).slice(0, 200)));
  setSetting("withdrawals", JSON.stringify((sharedState.withdrawals || []).slice(0, 200)));
  setSetting("audit_logs", JSON.stringify((sharedState.auditLogs || []).slice(0, 120)));
  setSetting("crash_history", JSON.stringify((sharedState.crashHistory || []).slice(0, 30)));
  setSetting("chat_state", JSON.stringify(sharedState.chat));
}

const activeMinesGames = new Map();
const activeBlackjackGames = new Map();
const lastChatTimestamp = new Map();

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  });
}

function sendTo(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendWalletToUser(targetUsername, targetWs = null) {
  const wallet = getUserPublic(targetUsername);
  const txs = getRecentTransactions(targetUsername, 50);
  const footballBets = getUserFootballBets(targetUsername, 30);
  const payload = { type: "WALLET_SYNC", wallet, txs, footballBets };
  if (targetWs) sendTo(targetWs, payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.username === targetUsername) {
      sendTo(client, payload);
    }
  });
}

function addAudit(actor, action) {
  sharedState.auditLogs.unshift({
    time: new Date().toLocaleTimeString("fa-IR"),
    actor: actor || "سیستم",
    action
  });
  if (sharedState.auditLogs.length > 100) sharedState.auditLogs.pop();
  persistShared();
}

// ==========================================
// موتور بازی انفجار همگام
// ==========================================
let roundState = {
  roundIndex: 1,
  phase: "waiting",
  mult: 1.0,
  target: 2.35,
  progressRatio: 0,
  remainingSec: 5.0
};

function generateCrashTarget() {
  const r = Math.random();
  if (r < 0.04) return 1.01;
  const raw = 0.97 / (1 - r);
  return Math.min(50, Math.max(1.05, Number(raw.toFixed(2))));
}

let phaseStartTime = Date.now();
const WAIT_DURATION_MS = 5000;
const CRASH_PAUSE_MS = 3000;
let runDurationMs = 4000;

function startWaitingPhase() {
  roundState.phase = "waiting";
  roundState.mult = 1.0;
  roundState.target = generateCrashTarget();
  roundState.progressRatio = 0;
  phaseStartTime = Date.now();
  runDurationMs = Math.min(25000, Math.max(1500, Math.log(roundState.target) * 4200));
}

startWaitingPhase();

setInterval(() => {
  const now = Date.now();
  const elapsed = now - phaseStartTime;

  if (roundState.phase === "waiting") {
    const rem = Math.max(0, (WAIT_DURATION_MS - elapsed) / 1000);
    roundState.remainingSec = Number(rem.toFixed(1));
    if (elapsed >= WAIT_DURATION_MS) {
      roundState.phase = "running";
      phaseStartTime = now;
    }
  } else if (roundState.phase === "running") {
    const ratio = Math.min(1, elapsed / runDurationMs);
    roundState.progressRatio = ratio;
    const currentMult = 1.0 + (roundState.target - 1.0) * Math.pow(ratio, 1.35);
    roundState.mult = Number(currentMult.toFixed(2));

    if (ratio >= 1) {
      roundState.phase = "crashed";
      roundState.mult = roundState.target;
      phaseStartTime = now;
      sharedState.crashHistory.unshift(roundState.target);
      if (sharedState.crashHistory.length > 20) sharedState.crashHistory.pop();
      persistShared();
    }
  } else if (roundState.phase === "crashed") {
    if (elapsed >= CRASH_PAUSE_MS) {
      roundState.roundIndex += 1;
      startWaitingPhase();
    }
  }

  broadcast({
    type: "ROUND_TICK",
    round: roundState,
    crashHistory: sharedState.crashHistory
  });
}, 100);

// ==========================================
// همگام‌سازی فوتبال و تسویه خودکار مسابقات پایان یافته (FT)
// ==========================================
function settleFinishedMatches(matches) {
  const affectedUsers = new Set();
  for (const match of matches) {
    if (match.status !== "FT") continue;
    const openBets = getOpenFootballBetsByMatch(match.id);
    for (const bet of openBets) {
      const won = resolveWinnerMarket(match, bet.market);
      if (won === null) continue;
      const settled = settleFootballBet({
        betId: bet.id,
        won,
        payout: bet.potential_payout,
        note: `تسویه خودکار (${match.home} ${match.hScore}-${match.aScore} ${match.away})`
      });
      if (settled) {
        affectedUsers.add(bet.username);
      }
    }
  }
  affectedUsers.forEach((uname) => sendWalletToUser(uname));
}

async function syncFootballLoop() {
  try {
    const matches = await refreshFootballMatches(false);
    if (Array.isArray(matches) && matches.length > 0) {
      sharedState.footballMatches = matches;
      settleFinishedMatches(matches);
      broadcast({ type: "SHARED_SYNC", shared: sharedState });
    }
  } catch (err) {
    console.error("syncFootballLoop error:", err.message);
  }
}

syncFootballLoop();
setInterval(syncFootballLoop, Math.max(10000, POLL_INTERVAL_MS));

function drawCard() {
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const suits = [
    { s: "♠", red: false },
    { s: "♣", red: false },
    { s: "♥", red: true },
    { s: "♦", red: true }
  ];
  const rank = ranks[Math.floor(Math.random() * ranks.length)];
  const suit = suits[Math.floor(Math.random() * suits.length)];
  return { rank, suit: suit.s, red: suit.red };
}

function calcBjSum(cards) {
  let sum = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === "A") {
      sum += 11;
      aces += 1;
    } else if (["K", "Q", "J"].includes(c.rank)) {
      sum += 10;
    } else {
      sum += Number(c.rank);
    }
  }
  while (sum > 21 && aces > 0) {
    sum -= 10;
    aces -= 1;
  }
  return sum;
}

wss.on("connection", (ws) => {
  ws.username = "مهمان";
  ws.isAdmin = false;

  sendTo(ws, {
    type: "SYNC_INIT",
    round: roundState,
    crashHistory: sharedState.crashHistory,
    chat: sharedState.chat,
    shared: sharedState,
    usersList: listUsersPublic()
  });
  sendWalletToUser("مهمان", ws);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const user = String(msg.username || ws.username || "مهمان").trim() || "مهمان";
    if (msg.username) ws.username = user;

    if (msg.type === "IDENTIFY") {
      ws.username = user;
      ensureUser(user);
      sendWalletToUser(user, ws);
      return;
    }

    if (msg.type === "REGISTER_USER") {
      try {
        const u = ensureUser(msg.username, {
          fullName: msg.fullName,
          phone: msg.phone,
          email: msg.email,
          password: msg.password
        });
        ws.username = u.username;
        sendTo(ws, { type: "AUTH_SUCCESS", action: "register", user: getUserPublic(u.username) });
        sendWalletToUser(u.username, ws);
        broadcast({ type: "SHARED_SYNC", shared: sharedState, usersList: listUsersPublic() });
      } catch (err) {
        sendTo(ws, { type: "AUTH_ERROR", action: "register", message: err.message || "خطا در ثبت‌نام" });
      }
      return;
    }

    if (msg.type === "LOGIN_USER") {
      const u = ensureUser(msg.username);
      if (!verifyPassword(msg.password || "", u.salt, u.password_hash)) {
        sendTo(ws, { type: "AUTH_ERROR", action: "login", message: "نام کاربری یا رمز عبور اشتباه است." });
        return;
      }
      ws.username = u.username;
      sendTo(ws, { type: "AUTH_SUCCESS", action: "login", user: getUserPublic(u.username) });
      sendWalletToUser(u.username, ws);
      return;
    }

    if (msg.type === "AUTH_SECRET_CODE") {
      if (msg.code === SECRET_ADMIN_CODE) {
        ws.isAdmin = true;
        if (!sharedState.ownerActor) sharedState.ownerActor = user;
        const isOwner = sharedState.ownerActor === user;
        addAudit(user, "ورود به پنل مدیریت");
        sendTo(ws, {
          type: "ADMIN_SESSION",
          secretCode: isOwner ? SECRET_ADMIN_CODE : null,
          session: {
            actor: user,
            rank: isOwner ? "مالک کل (Owner)" : "مدیر",
            isOwner,
            perms: { approveDep: true, manageWd: true, grantBal: true, modChat: true }
          }
        });
        broadcast({ type: "SHARED_SYNC", shared: sharedState, usersList: listUsersPublic() });
      } else {
        sendTo(ws, { type: "TOAST", message: "کد مدیریت نامعتبر است." });
      }
      return;
    }

    if (msg.type === "ADMIN_UPDATE_SECRET" && ws.isAdmin) {
      SECRET_ADMIN_CODE = String(msg.secretCode);
      setSetting("admin_secret_code", SECRET_ADMIN_CODE);
      addAudit(user, "تغییر کد مخفی مدیریت");
      sendTo(ws, { type: "TOAST", message: "کد مخفی جدید در دیتابیس ذخیره شد" });
      return;
    }

    if (msg.type === "ADMIN_ASSIGN_SUBADMIN" && ws.isAdmin) {
      sharedState.subAdmins[msg.username] = {
        username: msg.username,
        rank: msg.rank,
        perms: msg.perms || {}
      };
      addAudit(user, `اعطای دسترسی به ${msg.username}`);
      broadcast({ type: "SHARED_SYNC", shared: sharedState, toast: `ادمین ${msg.username} ثبت شد` });
      return;
    }

    if (msg.type === "ADMIN_REMOVE_SUBADMIN" && ws.isAdmin) {
      delete sharedState.subAdmins[msg.username];
      addAudit(user, `حذف ادمین ${msg.username}`);
      broadcast({ type: "SHARED_SYNC", shared: sharedState });
      return;
    }

    if (msg.type === "DEPOSIT_CREATE" && msg.deposit) {
      const dep = { ...msg.deposit, user: msg.deposit.user || user, status: "pending" };
      sharedState.deposits.unshift(dep);
      persistShared();
      broadcast({ type: "SHARED_SYNC", shared: sharedState });
      return;
    }

    if (msg.type === "WITHDRAW_CREATE" && msg.withdrawal) {
      try {
        changeBalance({
          username: msg.withdrawal.user || user,
          mode: "real",
          type: "withdraw_hold",
          delta: -Math.abs(Number(msg.withdrawal.amount || 0)),
          refId: msg.withdrawal.id,
          note: `رزرو برداشت (${msg.withdrawal.method || "شبا"})`
        });
        const wd = { ...msg.withdrawal, user: msg.withdrawal.user || user, status: "pending" };
        sharedState.withdrawals.unshift(wd);
        persistShared();
        sendWalletToUser(wd.user, ws);
        broadcast({ type: "SHARED_SYNC", shared: sharedState, usersList: listUsersPublic() });
      } catch (err) {
        sendTo(ws, { type: "TOAST", message: err.message || "موجودی واقعی برای برداشت کافی نیست." });
      }
      return;
    }

    if (msg.type === "ADMIN_DECIDE_DEPOSIT" && ws.isAdmin) {
      const dep = sharedState.deposits.find((d) => d.id === msg.id);
      if (dep && dep.status === "pending") {
        dep.status = msg.approve ? "approved" : "rejected";
        if (msg.approve) {
          changeBalance({
            username: dep.user,
            mode: "real",
            type: "deposit",
            delta: Math.abs(Number(dep.amount || 0)),
            refId: dep.id,
            note: `تایید واریز (${dep.method || "کارت"})`
          });
        }
        addAudit(user, `${msg.approve ? "تایید" : "رد"} واریز ${dep.user}`);
        persistShared();
        sendWalletToUser(dep.user);
        broadcast({ type: "SHARED_SYNC", shared: sharedState, usersList: listUsersPublic(), toast: `وضعیت واریز ${dep.user} به‌روزرسانی شد` });
      }
      return;
    }

    if (msg.type === "ADMIN_DECIDE_WITHDRAW" && ws.isAdmin) {
      const wd = sharedState.withdrawals.find((w) => w.id === msg.id);
      if (wd && wd.status === "pending") {
        wd.status = msg.approve ? "approved" : "rejected";
        if (!msg.approve) {
          changeBalance({
            username: wd.user,
            mode: "real",
            type: "withdraw_refund",
            delta: Math.abs(Number(wd.amount || 0)),
            refId: wd.id,
            note: "برگشت وجه برداشت ردشده"
          });
        }
        addAudit(user, `${msg.approve ? "پرداخت" : "رد"} برداشت ${wd.user}`);
        persistShared();
        sendWalletToUser(wd.user);
        broadcast({ type: "SHARED_SYNC", shared: sharedState, usersList: listUsersPublic(), toast: `وضعیت برداشت ${wd.user} به‌روزرسانی شد` });
      }
      return;
    }

    if (msg.type === "ADMIN_GRANT_REAL" && ws.isAdmin) {
      changeBalance({
        username: msg.username,
        mode: "real",
        type: "admin_grant",
        delta: Number(msg.amount || 0),
        note: `شارژ ادمین (${user})`
      });
      addAudit(user, `شارژ ${msg.amount} واقعی برای ${msg.username}`);
      sendWalletToUser(msg.username);
      broadcast({ type: "SHARED_SYNC", shared: sharedState, usersList: listUsersPublic(), toast: `موجودی ${msg.username} شارژ شد` });
      return;
    }

    if (msg.type === "TOPUP_DEMO") {
      changeBalance({
        username: user,
        mode: "demo",
        type: "demo_topup",
        delta: Math.min(20000000, Math.max(100000, Number(msg.amount || 5000000))),
        note: "شارژ دمو"
      });
      sendWalletToUser(user, ws);
      return;
    }

    // --- چت زنده ---
    if (msg.type === "CHAT_SEND") {
      if (sharedState.chat.locked && !ws.isAdmin) {
        return sendTo(ws, { type: "TOAST", message: "چت توسط ادمین قفل شده است." });
      }
      const muteUntil = sharedState.chat.mutedUsers[user];
      if (muteUntil && Date.now() < muteUntil && !ws.isAdmin) {
        return sendTo(ws, { type: "TOAST", message: "شما در چت میوت هستید." });
      }
      if (sharedState.chat.slowModeSec > 0 && !ws.isAdmin) {
        const last = lastChatTimestamp.get(user) || 0;
        if (Date.now() - last < sharedState.chat.slowModeSec * 1000) {
          return sendTo(ws, { type: "TOAST", message: `حالت آهسته فعال است (${sharedState.chat.slowModeSec} ثانیه).` });
        }
      }
      lastChatTimestamp.set(user, Date.now());
      sharedState.chat.messages.push({
        id: "msg_" + Date.now() + "_" + Math.floor(Math.random() * 999),
        user,
        text: String(msg.text || "").slice(0, 240),
        time: new Date().toLocaleTimeString("fa-IR"),
        isAdmin: ws.isAdmin,
        deleted: false
      });
      if (sharedState.chat.messages.length > 100) sharedState.chat.messages.shift();
      persistShared();
      broadcast({ type: "CHAT_SYNC", chat: sharedState.chat });
      return;
    }

    if (msg.type === "MOD_DELETE_MSG" && ws.isAdmin) {
      const m = sharedState.chat.messages.find((x) => x.id === msg.msgId);
      if (m) m.deleted = true;
      persistShared();
      broadcast({ type: "CHAT_SYNC", chat: sharedState.chat });
      return;
    }

    if (msg.type === "MOD_PIN_MSG" && ws.isAdmin) {
      sharedState.chat.pinnedId = msg.msgId;
      persistShared();
      broadcast({ type: "CHAT_SYNC", chat: sharedState.chat });
      return;
    }

    if (msg.type === "MOD_TOGGLE_LOCK" && ws.isAdmin) {
      sharedState.chat.locked = !sharedState.chat.locked;
      persistShared();
      broadcast({ type: "CHAT_SYNC", chat: sharedState.chat });
      return;
    }

    if (msg.type === "MOD_TOGGLE_SLOW" && ws.isAdmin) {
      sharedState.chat.slowModeSec = sharedState.chat.slowModeSec > 0 ? 0 : (msg.seconds || 5);
      persistShared();
      broadcast({ type: "CHAT_SYNC", chat: sharedState.chat });
      return;
    }

    if (msg.type === "MOD_CLEAR_CHAT" && ws.isAdmin) {
      sharedState.chat.messages = [];
      sharedState.chat.pinnedId = null;
      persistShared();
      broadcast({ type: "CHAT_SYNC", chat: sharedState.chat });
      return;
    }

    if (msg.type === "MOD_MUTE_USER" && ws.isAdmin) {
      sharedState.chat.mutedUsers[msg.username] = Date.now() + (msg.minutes || 10) * 60000;
      persistShared();
      sendTo(ws, { type: "TOAST", message: `کاربر ${msg.username} میوت شد` });
      return;
    }

    if (msg.type === "MOD_UNMUTE_USER" && ws.isAdmin) {
      delete sharedState.chat.mutedUsers[msg.username];
      persistShared();
      sendTo(ws, { type: "TOAST", message: `میوت ${msg.username} برداشته شد` });
      return;
    }

    // ==========================================
    // بازی‌ها با کسر/واریز اتمیک در دیتابیس
    // ==========================================
    if (msg.type === "PLAY_DICE") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      const mode = msg.mode === "real" ? "real" : "demo";
      try {
        changeBalance({ username: user, mode, type: "dice_bet", delta: -bet, note: "شرط تاس" });
      } catch (err) {
        return sendTo(ws, { type: "TOAST", message: err.message });
      }
      const target = Math.min(95, Math.max(5, Number(msg.target || 50)));
      const dir = msg.dir === "under" ? "under" : "over";
      const roll = Math.floor(Math.random() * 100) + 1;
      const winChance = dir === "over" ? (100 - target) : (target - 1);
      const mult = Number((97 / Math.max(1, winChance)).toFixed(2));
      const won = dir === "over" ? roll > target : roll < target;
      const payout = won ? Math.round(bet * mult) : 0;
      if (won && payout > 0) {
        changeBalance({ username: user, mode, type: "dice_win", delta: payout, note: `برد تاس (${roll})` });
      }
      sendWalletToUser(user, ws);
      sendTo(ws, { type: "DICE_RESULT", roll, won, payout, bet, mode });
      return;
    }

    if (msg.type === "PLAY_ROULETTE") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      const mode = msg.mode === "real" ? "real" : "demo";
      try {
        changeBalance({ username: user, mode, type: "roulette_bet", delta: -bet, note: "شرط رولت" });
      } catch (err) {
        return sendTo(ws, { type: "TOAST", message: err.message });
      }
      const pick = msg.pick;
      const num = Math.floor(Math.random() * 37);
      const redNums = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
      const color = num === 0 ? "green" : redNums.includes(num) ? "red" : "black";
      const colorFa = color === "green" ? "سبز" : color === "red" ? "قرمز" : "مشکی";
      const won = pick === color;
      const mult = color === "green" ? 14 : 2;
      const payout = won ? bet * mult : 0;
      if (won && payout > 0) {
        changeBalance({ username: user, mode, type: "roulette_win", delta: payout, note: `برد رولت (${num})` });
      }
      sendWalletToUser(user, ws);
      sendTo(ws, { type: "ROULETTE_RESULT", num, color: colorFa, won, payout, bet, mode });
      return;
    }

    if (msg.type === "PLAY_SLOTS") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      const mode = msg.mode === "real" ? "real" : "demo";
      try {
        changeBalance({ username: user, mode, type: "slots_bet", delta: -bet, note: "شرط اسلات" });
      } catch (err) {
        return sendTo(ws, { type: "TOAST", message: err.message });
      }
      const symbols = ["💎", "👑", "🍀", "🍒", "7️⃣", "🔔"];
      const reels = [
        symbols[Math.floor(Math.random() * symbols.length)],
        symbols[Math.floor(Math.random() * symbols.length)],
        symbols[Math.floor(Math.random() * symbols.length)]
      ];
      let mult = 0;
      if (reels[0] === reels[1] && reels[1] === reels[2]) {
        mult = reels[0] === "7️⃣" ? 15 : reels[0] === "👑" ? 10 : 6;
      } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
        mult = 1.5;
      }
      const won = mult > 0;
      const payout = Math.round(bet * mult);
      if (won && payout > 0) {
        changeBalance({ username: user, mode, type: "slots_win", delta: payout, note: `برد اسلات (${reels.join("")})` });
      }
      sendWalletToUser(user, ws);
      sendTo(ws, { type: "SLOTS_RESULT", reels, won, payout, bet, mode });
      return;
    }

    if (msg.type === "PLAY_PLINKO") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      const mode = msg.mode === "real" ? "real" : "demo";
      try {
        changeBalance({ username: user, mode, type: "plinko_bet", delta: -bet, note: "شرط پینکلو" });
      } catch (err) {
        return sendTo(ws, { type: "TOAST", message: err.message });
      }
      const risk = msg.risk === "high" ? "high" : "low";
      const mults = risk === "high" ? [6.5, 2.5, 1.2, 0.5, 1.2, 2.5, 6.5] : [2.2, 1.4, 1.1, 0.9, 1.1, 1.4, 2.2];
      let pos = 0;
      for (let i = 0; i < 6; i++) if (Math.random() >= 0.5) pos++;
      const mult = mults[pos];
      const payout = Math.round(bet * mult);
      if (payout > 0) {
        changeBalance({ username: user, mode, type: "plinko_payout", delta: payout, note: `نتیجه پینکلو (${mult}x)` });
      }
      sendWalletToUser(user, ws);
      sendTo(ws, { type: "PLINKO_RESULT", idx: pos, mult, payout, bet, mode });
      return;
    }

    if (msg.type === "MINES_START") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      const mode = msg.mode === "real" ? "real" : "demo";
      try {
        changeBalance({ username: user, mode, type: "mines_bet", delta: -bet, note: "شروع مین‌روب" });
      } catch (err) {
        return sendTo(ws, { type: "TOAST", message: err.message });
      }
      const count = Math.min(20, Math.max(1, Number(msg.count || 3)));
      const mines = new Set();
      while (mines.size < count) {
        mines.add(Math.floor(Math.random() * 25));
      }
      activeMinesGames.set(ws, {
        username: user,
        bet,
        mode,
        count,
        mines: Array.from(mines),
        opened: [],
        mult: 1.0
      });
      sendWalletToUser(user, ws);
      sendTo(ws, { type: "MINES_STARTED", bet });
      return;
    }

    if (msg.type === "MINES_PICK") {
      const game = activeMinesGames.get(ws);
      if (!game) return;
      const cell = Number(msg.cell);
      if (game.opened.includes(cell)) return;

      if (game.mines.includes(cell)) {
        activeMinesGames.delete(ws);
        sendTo(ws, { type: "MINES_HIT_MINE", mines: game.mines });
      } else {
        game.opened.push(cell);
        const safeTotal = 25 - game.count;
        const stepFactor = 25 / Math.max(1, safeTotal - game.opened.length + 1);
        game.mult = Number((game.mult * stepFactor * 0.96).toFixed(2));
        const potential = Math.round(game.bet * game.mult);
        sendTo(ws, { type: "MINES_SAFE", cell, mult: game.mult, potential });
      }
      return;
    }

    if (msg.type === "MINES_CASHOUT") {
      const game = activeMinesGames.get(ws);
      if (!game || game.opened.length === 0) return;
      const payout = Math.round(game.bet * game.mult);
      changeBalance({ username: game.username, mode: game.mode, type: "mines_win", delta: payout, note: `برداشت مین‌روب (${game.mult}x)` });
      activeMinesGames.delete(ws);
      sendWalletToUser(game.username, ws);
      sendTo(ws, { type: "MINES_CASHED", payout });
      return;
    }

    if (msg.type === "BJ_DEAL") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      const mode = msg.mode === "real" ? "real" : "demo";
      try {
        changeBalance({ username: user, mode, type: "bj_bet", delta: -bet, note: "شروع بلک‌جک" });
      } catch (err) {
        return sendTo(ws, { type: "TOAST", message: err.message });
      }
      const player = [drawCard(), drawCard()];
      const dealer = [drawCard()];
      const pSum = calcBjSum(player);
      const dSum = calcBjSum(dealer);

      activeBlackjackGames.set(ws, { username: user, bet, mode, player, dealer });
      sendWalletToUser(user, ws);
      sendTo(ws, { type: "BJ_STATE", status: "playing", player, dealer, playerSum: pSum, dealerSum: dSum });
      return;
    }

    if (msg.type === "BJ_HIT") {
      const game = activeBlackjackGames.get(ws);
      if (!game) return;
      game.player.push(drawCard());
      const pSum = calcBjSum(game.player);
      const dSum = calcBjSum(game.dealer);

      if (pSum > 21) {
        activeBlackjackGames.delete(ws);
        sendTo(ws, { type: "BJ_STATE", status: "bust", player: game.player, dealer: game.dealer, playerSum: pSum, dealerSum: dSum });
      } else {
        sendTo(ws, { type: "BJ_STATE", status: "playing", player: game.player, dealer: game.dealer, playerSum: pSum, dealerSum: dSum });
      }
      return;
    }

    if (msg.type === "BJ_STAND") {
      const game = activeBlackjackGames.get(ws);
      if (!game) return;
      while (calcBjSum(game.dealer) < 17) {
        game.dealer.push(drawCard());
      }
      const pSum = calcBjSum(game.player);
      const dSum = calcBjSum(game.dealer);
      let outcome = "lose";
      let payout = 0;

      if (dSum > 21 || pSum > dSum) {
        outcome = "win";
        payout = game.bet * 2;
      } else if (pSum === dSum) {
        outcome = "push";
        payout = game.bet;
      }

      if (payout > 0) {
        changeBalance({ username: game.username, mode: game.mode, type: "bj_payout", delta: payout, note: `تسویه بلک‌جک (${outcome})` });
        sendWalletToUser(game.username, ws);
      }
      activeBlackjackGames.delete(ws);
      sendTo(ws, { type: "BJ_STATE", status: "done", outcome, payout, player: game.player, dealer: game.dealer, playerSum: pSum, dealerSum: dSum });
      return;
    }

    if (msg.type === "PLACE_FOOTBALL_BET") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      const mode = msg.mode === "real" ? "real" : "demo";
      const match = sharedState.footballMatches[msg.matchIdx] || sharedState.footballMatches[0];
      if (!match) {
        return sendTo(ws, { type: "TOAST", message: "مسابقه یافت نشد." });
      }
      const market = ["home", "draw", "away"].includes(msg.market) ? msg.market : "home";
      const odd = market === "home" ? match.hOdd : market === "draw" ? match.dOdd : match.aOdd;
      const betId = "fb_" + Date.now() + "_" + Math.floor(Math.random() * 10000);

      try {
        const created = createFootballBet({
          id: betId,
          username: user,
          matchId: match.id,
          matchLabel: `${match.home} vs ${match.away}`,
          market,
          odd,
          stake: bet,
          mode
        });
        sendWalletToUser(user, ws);
        sendTo(ws, { type: "FOOTBALL_BET_ACCEPTED", betId: created.id, bet, odd, potential: created.potential });
      } catch (err) {
        sendTo(ws, { type: "TOAST", message: err.message || "خطا در ثبت شرط فوتبال." });
      }
      return;
    }
  });

  ws.on("close", () => {
    activeMinesGames.delete(ws);
    activeBlackjackGames.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`SOFYAN LIVE Persistent Server running on port ${PORT}`);
});

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ status: "ok", service: "sofyan-ws-sync" }));
});

const wss = new WebSocketServer({ server });

const ROUND_EPOCH_MS = 1767225600000;
const WAITING_MS = 2200;
const CRASH_PAUSE_MS = 2200;

const sharedState = {
  secretCode: "11228",
  ownerActor: null,
  subAdmins: {},
  deposits: [],
  withdrawals: [],
  usersBalanceAdjustments: {}, // username -> { demoDelta, realDelta, wageredDelta }
  auditLogs: [],
  chat: {
    locked: false,
    slowModeSec: 0,
    pinnedId: null,
    mutedUsers: {},
    messages: [
      {
        id: "m_server_init",
        user: "سیستم",
        isAdmin: true,
        text: "سرور همگام‌سازی راند، بازی‌ها و چت زنده برای همه کاربران فعال است.",
        time: new Date().toLocaleTimeString("fa-IR"),
        deleted: false
      }
    ]
  },
  crashHistory: [1.42, 2.85, 1.18, 4.60, 1.94, 3.12],
  footballMatches: [
    { id: "m0", league: "لیگ برتر", home: "استقلال", away: "پرسپولیس", hScore: 1, aScore: 0, min: 34, hOdd: 2.15, dOdd: 3.10, aOdd: 3.05, ballX: 0.56, ballY: 0.48 },
    { id: "m1", league: "لالیگا", home: "رئال مادرید", away: "بارسلونا", hScore: 0, aScore: 0, min: 19, hOdd: 2.05, dOdd: 3.40, aOdd: 2.90, ballX: 0.44, ballY: 0.52 },
    { id: "m2", league: "لیگ قهرمانان", home: "منچستر سیتی", away: "بایرن مونیخ", hScore: 2, aScore: 1, min: 67, hOdd: 1.88, dOdd: 3.55, aOdd: 3.45, ballX: 0.62, ballY: 0.42 }
  ]
};

const userLastChatMap = new Map();
const minesSessions = new Map(); // sessionKey -> { bet, mode, mines, opened: Set, mult }
const bjSessions = new Map();    // sessionKey -> { bet, mode, deck, dealer, player }
let lastRecordedRound = -1;

function getPlayerKey(ws, data) {
  const u = String(data?.username || ws.username || "مهمان").trim().slice(0, 32) || "مهمان";
  return u;
}

function applyDeltaToUser(username, delta, mode = "demo") {
  const u = String(username || "مهمان").trim() || "مهمان";
  sharedState.usersBalanceAdjustments[u] = sharedState.usersBalanceAdjustments[u] || {
    demoDelta: 0,
    realDelta: 0,
    wageredDelta: 0
  };
  if (mode === "real") {
    sharedState.usersBalanceAdjustments[u].realDelta += Number(delta || 0);
  } else {
    sharedState.usersBalanceAdjustments[u].demoDelta += Number(delta || 0);
  }
  if (delta < 0) {
    sharedState.usersBalanceAdjustments[u].wageredDelta += Math.abs(Number(delta || 0));
  }
}

function addServerAudit(actor, action) {
  sharedState.auditLogs.unshift({
    time: new Date().toLocaleTimeString("fa-IR"),
    actor: actor || "سیستم",
    action
  });
  if (sharedState.auditLogs.length > 100) sharedState.auditLogs.pop();
}

function deterministicCrashPoint(roundIndex, secretSalt = "sofyan_crash_v1") {
  const hash = crypto.createHmac("sha256", secretSalt).update(`round:${roundIndex}`).digest("hex");
  const u = parseInt(hash.slice(0, 8), 16) / 0xffffffff;
  if (u < 0.32) return Number((1.12 + (u / 0.32) * 0.78).toFixed(2));
  if (u < 0.75) return Number((1.90 + ((u - 0.32) / 0.43) * 2.20).toFixed(2));
  if (u < 0.94) return Number((4.10 + ((u - 0.75) / 0.19) * 5.40).toFixed(2));
  return Number((9.50 + ((u - 0.94) / 0.06) * 14.0).toFixed(2));
}

function getCrashDurationMs(targetMult) {
  return Math.max(1400, Math.min(18000, Math.pow(targetMult - 1.0, 0.72) * 2600 + 1400));
}

function getAuthoritativeRoundSnapshot(nowMs = Date.now()) {
  const avgSpan = 6500;
  const approxIdx = Math.max(0, Math.floor((nowMs - ROUND_EPOCH_MS) / avgSpan));
  let idx = Math.max(0, approxIdx - 12);
  let cursor = ROUND_EPOCH_MS + idx * avgSpan;

  while (true) {
    const target = deterministicCrashPoint(idx);
    const runMs = getCrashDurationMs(target);
    const totalMs = WAITING_MS + runMs + CRASH_PAUSE_MS;

    if (nowMs < cursor + totalMs) {
      const offset = nowMs - cursor;
      if (offset < WAITING_MS) {
        return {
          roundIndex: idx,
          phase: "waiting",
          mult: 1.0,
          target,
          progressRatio: 0,
          remainingSec: Number(Math.max(0.1, (WAITING_MS - offset) / 1000).toFixed(1))
        };
      }
      if (offset < WAITING_MS + runMs) {
        const ratio = Math.min(1, Math.max(0, (offset - WAITING_MS) / runMs));
        const mult = Number(Math.max(1.01, 1.0 + (target - 1.0) * Math.pow(ratio, 1.35)).toFixed(2));
        return { roundIndex: idx, phase: "running", mult, target, progressRatio: ratio, remainingSec: 0 };
      }
      return {
        roundIndex: idx,
        phase: "crashed",
        mult: target,
        target,
        progressRatio: 1,
        remainingSec: Number(Math.max(0.1, (WAITING_MS + runMs + CRASH_PAUSE_MS - offset) / 1000).toFixed(1))
      };
    }
    cursor += totalMs;
    idx += 1;
    if (idx > approxIdx + 30) break;
  }

  return { roundIndex: approxIdx, phase: "waiting", mult: 1.0, target: 2.0, progressRatio: 0, remainingSec: 1.0 };
}

function broadcast(packetObj) {
  const raw = JSON.stringify(packetObj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(raw);
  });
}

function isClientAdminWithChatPerm(ws) {
  const sess = ws.adminSession;
  if (!sess) return false;
  return Boolean(sess.isOwner || (sess.perms && sess.perms.modChat));
}

function sanitizeChatForBroadcast() {
  const now = Date.now();
  const activeMutes = {};
  for (const [u, exp] of Object.entries(sharedState.chat.mutedUsers)) {
    if (exp > now) activeMutes[u] = exp;
  }
  sharedState.chat.mutedUsers = activeMutes;
  return sharedState.chat;
}

function getSharedPayload() {
  return {
    ownerActor: sharedState.ownerActor,
    subAdmins: sharedState.subAdmins,
    deposits: sharedState.deposits,
    withdrawals: sharedState.withdrawals,
    usersBalanceAdjustments: sharedState.usersBalanceAdjustments,
    auditLogs: sharedState.auditLogs,
    chat: sanitizeChatForBroadcast(),
    crashHistory: sharedState.crashHistory,
    footballMatches: sharedState.footballMatches
  };
}

/* Blackjack helpers on server */
function createDeck() {
  const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  const suits = ["♠", "♥", "♦", "♣"];
  const deck = [];
  for (const r of ranks) {
    for (const s of suits) deck.push({ rank: r, suit: s, red: s === "♥" || s === "♦" });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calcHand(cards) {
  let sum = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === "A") { sum += 11; aces += 1; }
    else if (["K", "Q", "J"].includes(c.rank)) sum += 10;
    else sum += Number(c.rank);
  }
  while (sum > 21 && aces > 0) { sum -= 10; aces -= 1; }
  return sum;
}

wss.on("connection", (ws) => {
  ws.username = "مهمان";
  ws.adminSession = null;

  ws.send(JSON.stringify({
    type: "SYNC_INIT",
    round: getAuthoritativeRoundSnapshot(),
    shared: getSharedPayload()
  }));

  ws.on("message", (rawMsg) => {
    let data;
    try { data = JSON.parse(String(rawMsg)); } catch { return; }

    if (data.type === "IDENTIFY") {
      ws.username = String(data.username || "مهمان").trim().slice(0, 32) || "مهمان";
      return;
    }

    /* DICE */
    if (data.type === "PLAY_DICE") {
      const user = getPlayerKey(ws, data);
      const mode = data.mode === "real" ? "real" : "demo";
      const bet = Math.max(1000, Number(data.bet || 0));
      const target = Math.min(95, Math.max(5, Number(data.target || 50)));
      const dir = data.dir === "under" ? "under" : "over";

      applyDeltaToUser(user, -bet, mode);
      const roll = crypto.randomInt(1, 101);
      const won = dir === "over" ? roll > target : roll < target;
      let payout = 0;
      if (won) {
        const mult = dir === "over"
          ? Math.max(1.2, 95 / Math.max(5, 100 - target))
          : Math.max(1.2, 95 / Math.max(5, target));
        payout = Math.round(bet * Number(mult.toFixed(2)));
        applyDeltaToUser(user, payout, mode);
      }

      ws.send(JSON.stringify({ type: "DICE_RESULT", roll, won, payout, bet, mode }));
      broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
      return;
    }

    /* ROULETTE */
    if (data.type === "PLAY_ROULETTE") {
      const user = getPlayerKey(ws, data);
      const mode = data.mode === "real" ? "real" : "demo";
      const bet = Math.max(1000, Number(data.bet || 0));
      const pick = ["red", "black", "green"].includes(data.pick) ? data.pick : "red";

      applyDeltaToUser(user, -bet, mode);
      const num = crypto.randomInt(0, 37);
      const color = num === 0 ? "green" : num % 2 === 1 ? "red" : "black";
      const won = pick === color;
      const payout = won ? bet * (color === "green" ? 14 : 2) : 0;
      if (payout > 0) applyDeltaToUser(user, payout, mode);

      ws.send(JSON.stringify({ type: "ROULETTE_RESULT", num, color, won, payout, bet, mode }));
      broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
      return;
    }

    /* SLOTS */
    if (data.type === "PLAY_SLOTS") {
      const user = getPlayerKey(ws, data);
      const mode = data.mode === "real" ? "real" : "demo";
      const bet = Math.max(1000, Number(data.bet || 0));
      const syms = ["💎", "👑", "🍀"];

      applyDeltaToUser(user, -bet, mode);
      const reels = [
        syms[crypto.randomInt(0, syms.length)],
        syms[crypto.randomInt(0, syms.length)],
        syms[crypto.randomInt(0, syms.length)]
      ];
      const won = reels[0] === reels[1] && reels[1] === reels[2];
      const payout = won ? bet * 8 : 0;
      if (payout > 0) applyDeltaToUser(user, payout, mode);

      ws.send(JSON.stringify({ type: "SLOTS_RESULT", reels, won, payout, bet, mode }));
      broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
      return;
    }

    /* PLINKO */
    if (data.type === "PLAY_PLINKO") {
      const user = getPlayerKey(ws, data);
      const mode = data.mode === "real" ? "real" : "demo";
      const bet = Math.max(1000, Number(data.bet || 0));
      const mults = data.risk === "low" ? [2.2, 1.4, 1.1, 0.9, 1.1, 1.4, 2.2] : [6.5, 2.5, 1.2, 0.5, 1.2, 2.5, 6.5];

      applyDeltaToUser(user, -bet, mode);
      const idx = crypto.randomInt(0, mults.length);
      const mult = mults[idx];
      const payout = Math.round(bet * mult);
      applyDeltaToUser(user, payout, mode);

      ws.send(JSON.stringify({ type: "PLINKO_RESULT", idx, mult, payout, bet, mode }));
      broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
      return;
    }

    /* MINES */
    if (data.type === "MINES_START") {
      const user = getPlayerKey(ws, data);
      const mode = data.mode === "real" ? "real" : "demo";
      const bet = Math.max(1000, Number(data.bet || 0));
      const count = Math.min(18, Math.max(1, Number(data.count || 3)));

      applyDeltaToUser(user, -bet, mode);
      const set = new Set();
      while (set.size < count) set.add(crypto.randomInt(0, 25));

      minesSessions.set(user, { bet, mode, count, mines: [...set], opened: [], mult: 1.0 });
      ws.send(JSON.stringify({ type: "MINES_STARTED", bet, count, mult: 1.0 }));
      broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
      return;
    }

    if (data.type === "MINES_PICK") {
      const user = getPlayerKey(ws, data);
      const cell = Number(data.cell);
      const sess = minesSessions.get(user);
      if (!sess || cell < 0 || cell > 24 || sess.opened.includes(cell)) return;

      if (sess.mines.includes(cell)) {
        const revealedMines = sess.mines;
        minesSessions.delete(user);
        ws.send(JSON.stringify({ type: "MINES_HIT_MINE", cell, mines: revealedMines }));
        return;
      }

      sess.opened.push(cell);
      sess.mult = Number((sess.mult * (1 + sess.count * 0.08)).toFixed(2));
      ws.send(JSON.stringify({
        type: "MINES_SAFE",
        cell,
        mult: sess.mult,
        potential: Math.round(sess.bet * sess.mult)
      }));
      return;
    }

    if (data.type === "MINES_CASHOUT") {
      const user = getPlayerKey(ws, data);
      const sess = minesSessions.get(user);
      if (!sess) return;
      const payout = Math.round(sess.bet * sess.mult);
      minesSessions.delete(user);
      applyDeltaToUser(user, payout, sess.mode);
      ws.send(JSON.stringify({ type: "MINES_CASHED", payout, mult: sess.mult }));
      broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
      return;
    }

    /* BLACKJACK */
    if (data.type === "BJ_DEAL") {
      const user = getPlayerKey(ws, data);
      const mode = data.mode === "real" ? "real" : "demo";
      const bet = Math.max(1000, Number(data.bet || 0));

      applyDeltaToUser(user, -bet, mode);
      const deck = createDeck();
      const player = [deck.pop(), deck.pop()];
      const dealer = [deck.pop()];
      bjSessions.set(user, { bet, mode, deck, player, dealer });

      ws.send(JSON.stringify({
        type: "BJ_STATE",
        status: "playing",
        player,
        dealer,
        playerSum: calcHand(player),
        dealerSum: calcHand(dealer)
      }));
      broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
      return;
    }

    if (data.type === "BJ_HIT") {
      const user = getPlayerKey(ws, data);
      const sess = bjSessions.get(user);
      if (!sess) return;
      sess.player.push(sess.deck.pop());
      const pSum = calcHand(sess.player);
      if (pSum > 21) {
        const dealer = sess.dealer;
        bjSessions.delete(user);
        ws.send(JSON.stringify({
          type: "BJ_STATE",
          status: "bust",
          player: sess.player,
          dealer,
          playerSum: pSum,
          dealerSum: calcHand(dealer)
        }));
        return;
      }
      ws.send(JSON.stringify({
        type: "BJ_STATE",
        status: "playing",
        player: sess.player,
        dealer: sess.dealer,
        playerSum: pSum,
        dealerSum: calcHand(sess.dealer)
      }));
      return;
    }

    if (data.type === "BJ_STAND") {
      const user = getPlayerKey(ws, data);
      const sess = bjSessions.get(user);
      if (!sess) return;
      while (calcHand(sess.dealer) < 17) sess.dealer.push(sess.deck.pop());
      const pSum = calcHand(sess.player);
      const dSum = calcHand(sess.dealer);
      bjSessions.delete(user);

      let outcome = "lose";
      let payout = 0;
      if (dSum > 21 || pSum > dSum) {
        outcome = "win";
        payout = sess.bet * 2;
        applyDeltaToUser(user, payout, sess.mode);
      } else if (pSum === dSum) {
        outcome = "push";
        payout = sess.bet;
        applyDeltaToUser(user, payout, sess.mode);
      }

      ws.send(JSON.stringify({
        type: "BJ_STATE",
        status: "done",
        outcome,
        payout,
        player: sess.player,
        dealer: sess.dealer,
        playerSum: pSum,
        dealerSum: dSum
      }));
      broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
      return;
    }

    /* FOOTBALL BET */
    if (data.type === "PLACE_FOOTBALL_BET") {
      const user = getPlayerKey(ws, data);
      const mode = data.mode === "real" ? "real" : "demo";
      const bet = Math.max(1000, Number(data.bet || 0));
      const idx = Math.min(sharedState.footballMatches.length - 1, Math.max(0, Number(data.matchIdx || 0)));
      const market = ["home", "draw", "away"].includes(data.market) ? data.market : "home";
      const match = sharedState.footballMatches[idx];
      const odd = market === "home" ? match.hOdd : market === "draw" ? match.dOdd : match.aOdd;

      applyDeltaToUser(user, -bet, mode);
      ws.send(JSON.stringify({
        type: "FOOTBALL_BET_ACCEPTED",
        matchIdx: idx,
        market,
        odd,
        bet,
        potential: Math.round(bet * odd)
      }));
      broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
      return;
    }

    /* ADMIN & WALLET & CHAT (unchanged core) */
    if (data.type === "AUTH_SECRET_CODE") {
      const code = String(data.code || "").trim();
      const actor = String(data.username || ws.username || "مهمان").trim();
      if (code !== sharedState.secretCode) {
        ws.send(JSON.stringify({ type: "TOAST", message: "کد مخفی صحیح نیست" }));
        return;
      }
      if (!sharedState.ownerActor) {
        sharedState.ownerActor = actor;
        ws.adminSession = {
          actor,
          isOwner: true,
          rank: "ادمین اصلی (مالک کل)",
          perms: { approveDep: true, manageWd: true, grantBal: true, modChat: true }
        };
        addServerAudit(actor, "ثبت به‌عنوان ادمین اصلی با کد مخفی");
        ws.send(JSON.stringify({ type: "ADMIN_SESSION", session: ws.adminSession, secretCode: sharedState.secretCode }));
        broadcast({ type: "SHARED_SYNC", shared: getSharedPayload(), toast: `${actor} به‌عنوان ادمین اصلی منصوب شد` });
        return;
      }
      if (sharedState.ownerActor === actor) {
        ws.adminSession = {
          actor,
          isOwner: true,
          rank: "ادمین اصلی (مالک کل)",
          perms: { approveDep: true, manageWd: true, grantBal: true, modChat: true }
        };
        addServerAudit(actor, "ورود ادمین اصلی به پنل مدیریت");
        ws.send(JSON.stringify({ type: "ADMIN_SESSION", session: ws.adminSession, secretCode: sharedState.secretCode }));
        broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
        return;
      }
      if (sharedState.subAdmins[actor]) {
        ws.adminSession = {
          actor,
          isOwner: false,
          rank: sharedState.subAdmins[actor].rank,
          perms: { ...sharedState.subAdmins[actor].perms }
        };
        addServerAudit(actor, `ورود ادمین درجه‌دار (${sharedState.subAdmins[actor].rank})`);
        ws.send(JSON.stringify({ type: "ADMIN_SESSION", session: ws.adminSession }));
        broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
        return;
      }
      ws.send(JSON.stringify({ type: "TOAST", message: "کد صحیح است اما درجه ادمین برای این کاربر ثبت نشده است" }));
      return;
    }

    if (data.type === "ADMIN_UPDATE_SECRET" && ws.adminSession && ws.adminSession.isOwner) {
      const nextCode = String(data.secretCode || "").trim();
      if (nextCode.length >= 3) {
        sharedState.secretCode = nextCode;
        addServerAudit(ws.adminSession.actor, "تغییر کد مخفی مدیریت");
        ws.send(JSON.stringify({ type: "ADMIN_SESSION", session: ws.adminSession, secretCode: sharedState.secretCode }));
        broadcast({ type: "SHARED_SYNC", shared: getSharedPayload(), toast: "کد مخفی جدید ذخیره شد" });
      }
      return;
    }

    if (data.type === "ADMIN_ASSIGN_SUBADMIN" && ws.adminSession && ws.adminSession.isOwner) {
      const uname = String(data.username || "").trim();
      const rank = String(data.rank || "ناظر").trim();
      const perms = data.perms || { approveDep: true, manageWd: false, grantBal: false, modChat: true };
      if (uname) {
        sharedState.subAdmins[uname] = { username: uname, rank, perms };
        addServerAudit(ws.adminSession.actor, `اعطای درجه «${rank}» به ${uname}`);
        broadcast({ type: "SHARED_SYNC", shared: getSharedPayload(), toast: `درجه «${rank}» برای ${uname} ثبت شد` });
      }
      return;
    }

    if (data.type === "ADMIN_REMOVE_SUBADMIN" && ws.adminSession && ws.adminSession.isOwner) {
      const uname = String(data.username || "").trim();
      if (uname && sharedState.subAdmins[uname]) {
        delete sharedState.subAdmins[uname];
        addServerAudit(ws.adminSession.actor, `حذف دسترسی ادمین ${uname}`);
        broadcast({ type: "SHARED_SYNC", shared: getSharedPayload(), toast: `دسترسی ${uname} حذف شد` });
      }
      return;
    }

    if (data.type === "DEPOSIT_CREATE" && data.deposit) {
      sharedState.deposits.unshift(data.deposit);
      if (sharedState.deposits.length > 150) sharedState.deposits.pop();
      broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
      return;
    }

    if (data.type === "WITHDRAW_CREATE" && data.withdrawal) {
      sharedState.withdrawals.unshift(data.withdrawal);
      if (sharedState.withdrawals.length > 150) sharedState.withdrawals.pop();
      broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
      return;
    }

    if (data.type === "ADMIN_DECIDE_DEPOSIT" && ws.adminSession && (ws.adminSession.isOwner || ws.adminSession.perms?.approveDep)) {
      const item = sharedState.deposits.find((d) => d.id === data.id);
      if (item && item.status === "pending") {
        item.status = data.approve ? "approved" : "rejected";
        if (data.approve) applyDeltaToUser(item.user || "مهمان", Number(item.amount || 0), "real");
        addServerAudit(ws.adminSession.actor, `${data.approve ? "تایید" : "رد"} واریز ${item.amount} برای ${item.user}`);
        broadcast({ type: "SHARED_SYNC", shared: getSharedPayload(), toast: data.approve ? "واریز تایید شد" : "واریز رد شد" });
      }
      return;
    }

    if (data.type === "ADMIN_DECIDE_WITHDRAW" && ws.adminSession && (ws.adminSession.isOwner || ws.adminSession.perms?.manageWd)) {
      const item = sharedState.withdrawals.find((w) => w.id === data.id);
      if (item && item.status === "pending") {
        item.status = data.approve ? "approved" : "rejected";
        if (!data.approve) applyDeltaToUser(item.user || "مهمان", Number(item.amount || 0), "real");
        addServerAudit(ws.adminSession.actor, `${data.approve ? "پرداخت" : "رد"} برداشت ${item.amount} برای ${item.user}`);
        broadcast({ type: "SHARED_SYNC", shared: getSharedPayload(), toast: data.approve ? "برداشت پرداخت شد" : "برداشت رد و برگشت داده شد" });
      }
      return;
    }

    if (data.type === "ADMIN_GRANT_REAL" && ws.adminSession && (ws.adminSession.isOwner || ws.adminSession.perms?.grantBal)) {
      const u = String(data.username || "").trim();
      const amt = Number(data.amount || 500000);
      if (u) {
        applyDeltaToUser(u, amt, "real");
        addServerAudit(ws.adminSession.actor, `شارژ ${amt} واقعی برای ${u}`);
        broadcast({ type: "SHARED_SYNC", shared: getSharedPayload(), toast: `${amt.toLocaleString("fa-IR")} واقعی به ${u} اضافه شد` });
      }
      return;
    }

    if (data.type === "CHAT_SEND") {
      const sender = String(data.username || ws.username || "مهمان").trim().slice(0, 32);
      const text = String(data.text || "").trim().slice(0, 240);
      if (!text) return;

      const isAdmin = isClientAdminWithChatPerm(ws);
      if (sharedState.chat.locked && !isAdmin) {
        ws.send(JSON.stringify({ type: "TOAST", message: "چت زنده توسط مدیریت قفل شده است" }));
        return;
      }

      const muteExp = sharedState.chat.mutedUsers[sender] || 0;
      if (!isAdmin && muteExp > Date.now()) {
        ws.send(JSON.stringify({ type: "TOAST", message: "شما در چت میوت هستید" }));
        return;
      }

      if (!isAdmin && sharedState.chat.slowModeSec > 0) {
        const prev = userLastChatMap.get(sender) || 0;
        const diffSec = (Date.now() - prev) / 1000;
        if (diffSec < sharedState.chat.slowModeSec) {
          ws.send(JSON.stringify({ type: "TOAST", message: `حالت آهسته فعال است (${Math.ceil(sharedState.chat.slowModeSec - diffSec)}s)` }));
          return;
        }
      }

      userLastChatMap.set(sender, Date.now());
      const msgObj = {
        id: "msg_" + Date.now() + "_" + crypto.randomBytes(2).toString("hex"),
        user: sender,
        isAdmin,
        text,
        time: new Date().toLocaleTimeString("fa-IR"),
        deleted: false
      };
      sharedState.chat.messages.push(msgObj);
      if (sharedState.chat.messages.length > 120) sharedState.chat.messages.shift();
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_DELETE_MSG" && isClientAdminWithChatPerm(ws)) {
      const msg = sharedState.chat.messages.find((m) => m.id === data.msgId);
      if (msg) msg.deleted = true;
      if (sharedState.chat.pinnedId === data.msgId) sharedState.chat.pinnedId = null;
      addServerAudit(ws.adminSession.actor, "حذف پیام در چت زنده");
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_PIN_MSG" && isClientAdminWithChatPerm(ws)) {
      sharedState.chat.pinnedId = data.msgId || null;
      addServerAudit(ws.adminSession.actor, "پین کردن پیام در چت زنده");
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_TOGGLE_LOCK" && isClientAdminWithChatPerm(ws)) {
      sharedState.chat.locked = !sharedState.chat.locked;
      addServerAudit(ws.adminSession.actor, sharedState.chat.locked ? "قفل چت زنده" : "باز کردن چت زنده");
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_TOGGLE_SLOW" && isClientAdminWithChatPerm(ws)) {
      sharedState.chat.slowModeSec = sharedState.chat.slowModeSec > 0 ? 0 : Number(data.seconds || 5);
      addServerAudit(ws.adminSession.actor, sharedState.chat.slowModeSec > 0 ? "فعال‌سازی حالت آهسته چت" : "غیرفعال‌سازی حالت آهسته چت");
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_CLEAR_CHAT" && isClientAdminWithChatPerm(ws)) {
      sharedState.chat.messages = [];
      sharedState.chat.pinnedId = null;
      addServerAudit(ws.adminSession.actor, "پاک‌سازی کامل چت زنده");
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_MUTE_USER" && isClientAdminWithChatPerm(ws)) {
      const target = String(data.username || "").trim();
      const mins = Math.max(1, Number(data.minutes || 10));
      if (target) {
        sharedState.chat.mutedUsers[target] = Date.now() + mins * 60000;
        addServerAudit(ws.adminSession.actor, `میوت ${target} به مدت ${mins} دقیقه`);
      }
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_UNMUTE_USER" && isClientAdminWithChatPerm(ws)) {
      const target = String(data.username || "").trim();
      if (target) {
        delete sharedState.chat.mutedUsers[target];
        addServerAudit(ws.adminSession.actor, `رفع میوت ${target}`);
      }
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }
  });
});

/* Crash loop every 100ms */
setInterval(() => {
  const snap = getAuthoritativeRoundSnapshot(Date.now());
  if (snap.phase === "crashed" && lastRecordedRound !== snap.roundIndex) {
    lastRecordedRound = snap.roundIndex;
    sharedState.crashHistory.unshift(Number(snap.target.toFixed(2)));
    if (sharedState.crashHistory.length > 20) sharedState.crashHistory.pop();
  }
  broadcast({
    type: "ROUND_TICK",
    round: snap,
    crashHistory: sharedState.crashHistory
  });
}, 100);

/* Live football tick every 4 seconds */
setInterval(() => {
  sharedState.footballMatches.forEach((m) => {
    m.min = m.min >= 90 ? 1 : m.min + 1;
    m.ballX = Number(Math.min(0.92, Math.max(0.08, m.ballX + (crypto.randomInt(-10, 11) / 100))).toFixed(2));
    m.ballY = Number(Math.min(0.88, Math.max(0.12, m.ballY + (crypto.randomInt(-10, 11) / 100))).toFixed(2));
    if (crypto.randomInt(0, 100) < 6) {
      if (crypto.randomInt(0, 2) === 0) m.hScore += 1;
      else m.aScore += 1;
    }
  });
  broadcast({ type: "SHARED_SYNC", shared: getSharedPayload() });
}, 4000);

server.listen(PORT, () => {
  console.log(`Sofyan WebSocket Server running on port ${PORT}`);
});

const http = require("http");
const https = require("https");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 8080);
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || "";
const FOOTBALL_API_HOST = process.env.FOOTBALL_API_HOST || "v3.football.api-sports.io";
const FOOTBALL_POLL_MS = Number(process.env.FOOTBALL_POLL_MS || 90000);

const FA_LEAGUES = {
  "Persian Gulf Pro League": "لیگ برتر خلیج فارس",
  "Azadegan League": "لیگ آزادگان",
  "Hazfi Cup": "جام حذفی ایران",
  "AFC Champions League": "لیگ قهرمانان آسیا",
  "Premier League": "لیگ برتر انگلیس",
  "Championship": "چمپیونشیپ انگلیس",
  "League One": "لیگ یک انگلیس",
  "League Two": "لیگ دو انگلیس",
  "La Liga": "لالیگا اسپانیا",
  "Serie A": "سری آ ایتالیا",
  "Bundesliga": "بوندسلیگا آلمان",
  "Ligue 1": "لوشامپیونه فرانسه",
  "UEFA Champions League": "لیگ قهرمانان اروپا",
  "Premiership": "لیگ برتر اسکاتلند",
  "National League": "نشنال لیگ انگلیس"
};

const FA_TEAMS = {
  "Esteghlal": "استقلال",
  "Persepolis": "پرسپولیس",
  "Sepahan": "سپاهان",
  "Tractor": "تراکتور",
  "Foolad": "فولاد",
  "Zob Ahan": "ذوب‌آهن",
  "Gol Gohar": "گل‌گهر",
  "Mes Rafsanjan": "مس رفسنجان",
  "Malavan": "ملوان",
  "Shams Azar": "شمس‌آذر",
  "Aluminium Arak": "آلومینیوم اراک",
  "Chadormalu": "چادرملو",
  "Kheybar Khorramabad": "خیبر خرم‌آباد",
  "Havadar": "هوادار",
  "Esteghlal Khuzestan": "استقلال خوزستان",
  "Paykan": "پیکان",
  "Saipa": "سایپا",
  "Real Madrid": "رئال مادرید",
  "Barcelona": "بارسلونا",
  "Manchester City": "منچستر سیتی",
  "Bayern Munich": "بایرن مونیخ",
  "Hibernian": "هیبرنیان",
  "Dundee": "داندی",
  "Cardiff": "کاردیف",
  "Preston": "پرستون",
  "Middlesbrough": "میدلزبرو",
  "Swansea": "سوانزی",
  "Portsmouth": "پورتسموث",
  "West Ham": "وستهام",
  "Wolves": "ولورهمپتون",
  "Derby": "دربی کانتی",
  "Port Vale": "پورت ویل",
  "Northampton": "نورثهمپتون",
  "Stevenage": "استیونج",
  "Sheffield Wednesday": "شفیلد ونزدی",
  "Bromley": "بروملی",
  "Wycombe": "ویکوم",
  "AFC Fylde": "ای‌اف‌سی فیلد",
  "FC Halifax Town": "هالیفاکس تاون",
  "Boston United": "بوستون یونایتد",
  "Barrow": "بارو",
  "Eastleigh": "ایستلی",
  "Yeovil Town": "یئوویل تاون",
  "AFC Hornchurch": "ای‌اف‌سی هورنچرچ",
  "Sutton Utd": "ساتون یونایتد"
};

function translateLeagueFa(name = "") {
  if (!name) return "فوتبال";
  if (FA_LEAGUES[name]) return FA_LEAGUES[name];
  const hit = Object.keys(FA_LEAGUES).find((k) => name.toLowerCase().includes(k.toLowerCase()));
  return hit ? FA_LEAGUES[hit] : name;
}

function translateTeamFa(name = "") {
  if (!name) return "تیم";
  if (FA_TEAMS[name]) return FA_TEAMS[name];
  const hit = Object.keys(FA_TEAMS).find((k) => name.toLowerCase().includes(k.toLowerCase()));
  return hit ? FA_TEAMS[hit] : name;
}

function isIranianFixtureItem(item) {
  const country = String(item?.league?.country || "").toLowerCase();
  const league = String(item?.league?.name || "").toLowerCase();
  const home = String(item?.teams?.home?.name || "").toLowerCase();
  const away = String(item?.teams?.away?.name || "").toLowerCase();
  const combined = `${country} ${league} ${home} ${away}`;
  if (
    combined.includes("iran") ||
    combined.includes("persian gulf") ||
    combined.includes("azadegan") ||
    combined.includes("hazfi")
  ) {
    return true;
  }
  return Object.keys(FA_TEAMS)
    .slice(0, 17)
    .some((enName) => home.includes(enName.toLowerCase()) || away.includes(enName.toLowerCase()));
}

function normalizeFixture(item, fallbackIdx = 0) {
  const rawLeague = item?.league?.name || "Football";
  const rawHome = item?.teams?.home?.name || "Home";
  const rawAway = item?.teams?.away?.name || "Away";
  const isIr = isIranianFixtureItem(item);

  return {
    id: String(item?.fixture?.id || `fx_${fallbackIdx}_${Date.now()}`),
    league: translateLeagueFa(rawLeague),
    home: translateTeamFa(rawHome),
    away: translateTeamFa(rawAway),
    hScore: Number(item?.goals?.home ?? 0),
    aScore: Number(item?.goals?.away ?? 0),
    min: Number(item?.fixture?.status?.elapsed ?? 0),
    status: item?.fixture?.status?.short || "LIVE",
    hOdd: 2.1,
    dOdd: 3.2,
    aOdd: 2.9,
    ballX: 0.5,
    ballY: 0.5,
    isIran: isIr
  };
}

function apiFootballRequest(path) {
  return new Promise((resolve, reject) => {
    if (!FOOTBALL_API_KEY) {
      return reject(new Error("FOOTBALL_API_KEY is missing"));
    }
    const req = https.request(
      {
        hostname: FOOTBALL_API_HOST,
        path,
        method: "GET",
        headers: {
          "x-apisports-key": FOOTBALL_API_KEY
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(raw);
            if (res.statusCode && res.statusCode >= 400) {
              return reject(new Error(`API status ${res.statusCode}`));
            }
            resolve(Array.isArray(json?.response) ? json.response : []);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("API timeout")));
    req.end();
  });
}

let cachedIranDailyMatches = [];
let lastIranDailyFetch = 0;

async function getIranDailyMatches() {
  const now = Date.now();
  if (now - lastIranDailyFetch < 10 * 60 * 1000 && cachedIranDailyMatches.length) {
    return cachedIranDailyMatches;
  }
  const todayIso = new Date().toISOString().slice(0, 10);
  const items = await apiFootballRequest(`/fixtures?date=${todayIso}&country=Iran`);
  cachedIranDailyMatches = items.map((it, idx) => normalizeFixture(it, idx));
  lastIranDailyFetch = now;
  return cachedIranDailyMatches;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      ok: true,
      service: "Sofyan.60bet Live Server",
      hasFootballKey: Boolean(FOOTBALL_API_KEY),
      footballMatchesCount: shared.footballMatches.length
    })
  );
});

const wss = new WebSocket.Server({ server });

let secretCode = process.env.ADMIN_SECRET_CODE || "11228";
let roundCounter = 1;
let crashHistory = [1.42, 2.85, 1.18, 4.60, 1.94, 3.12];

let currentRound = {
  roundIndex: roundCounter,
  phase: "waiting",
  mult: 1.0,
  target: 2.15,
  progressRatio: 0,
  remainingSec: 3.0
};

let chatState = {
  locked: false,
  slowModeSec: 0,
  pinnedId: null,
  mutedUsers: {},
  messages: []
};

const shared = {
  ownerActor: null,
  subAdmins: {},
  deposits: [],
  withdrawals: [],
  usersBalanceAdjustments: {},
  auditLogs: [],
  crashHistory,
  footballMatches: [
    {
      id: "ir0",
      league: "لیگ برتر خلیج فارس",
      home: "استقلال",
      away: "پرسپولیس",
      hScore: 1,
      aScore: 0,
      min: 34,
      status: "LIVE",
      hOdd: 2.15,
      dOdd: 3.1,
      aOdd: 3.05,
      ballX: 0.56,
      ballY: 0.48,
      isIran: true
    }
  ]
};

const usersDb = new Map();
const userFootballBets = new Map();
const clientMeta = new WeakMap();

function nowFaTime() {
  return new Date().toLocaleTimeString("fa-IR");
}

function addAuditLog(actor, action) {
  shared.auditLogs.unshift({
    time: nowFaTime(),
    actor: actor || "سیستم",
    action
  });
  if (shared.auditLogs.length > 100) {
    shared.auditLogs.length = 100;
  }
}

function getOrCreateUserRecord(username = "مهمان") {
  const key = String(username || "مهمان").trim() || "مهمان";
  if (!usersDb.has(key)) {
    usersDb.set(key, {
      username: key,
      fullName: key === "مهمان" ? "کاربر مهمان" : key,
      phone: "",
      email: "",
      password: "",
      demo: 10000000,
      real: 500000,
      txs: []
    });
  }
  return usersDb.get(key);
}

function pushUserTx(userObj, type, mode, amount, note) {
  const balAfter = mode === "real" ? userObj.real : userObj.demo;
  userObj.txs.unshift({
    id: "tx_" + Date.now() + "_" + Math.floor(Math.random() * 9999),
    type,
    mode,
    amount,
    balance_after: balAfter,
    note,
    created_at: new Date().toISOString()
  });
  if (userObj.txs.length > 80) {
    userObj.txs.length = 80;
  }
}

function sendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {}
  }
}

function broadcastJson(payload) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(JSON.stringify(payload));
      } catch {}
    }
  });
}

function sendWalletSyncToUser(username) {
  const u = getOrCreateUserRecord(username);
  const bets = userFootballBets.get(u.username) || [];
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      const meta = clientMeta.get(client) || {};
      if ((meta.username || "مهمان") === u.username) {
        sendJson(client, {
          type: "WALLET_SYNC",
          wallet: {
            username: u.username,
            fullName: u.fullName,
            phone: u.phone,
            email: u.email,
            demo: u.demo,
            real: u.real
          },
          txs: u.txs,
          footballBets: bets
        });
      }
    }
  });
}

function broadcastSharedSync(toastMessage) {
  shared.crashHistory = crashHistory;
  broadcastJson({
    type: "SHARED_SYNC",
    shared,
    toast: toastMessage || null
  });
}

function broadcastChatSync() {
  broadcastJson({
    type: "CHAT_SYNC",
    chat: chatState
  });
}

/* CRASH LOOP */
let phaseElapsed = 0;
let waitingDuration = 3.0;
let runningDuration = 6.0;

function pickCrashTarget() {
  const r = Math.random();
  if (r < 0.35) return Number((1.15 + Math.random() * 0.85).toFixed(2));
  if (r < 0.78) return Number((2.0 + Math.random() * 2.5).toFixed(2));
  return Number((4.5 + Math.random() * 7.5).toFixed(2));
}

function startNewWaitingPhase() {
  roundCounter += 1;
  waitingDuration = 3.0;
  runningDuration = Number((4.5 + Math.random() * 5.5).toFixed(2));
  phaseElapsed = 0;
  currentRound = {
    roundIndex: roundCounter,
    phase: "waiting",
    mult: 1.0,
    target: pickCrashTarget(),
    progressRatio: 0,
    remainingSec: waitingDuration
  };
}

setInterval(() => {
  phaseElapsed += 0.1;
  if (currentRound.phase === "waiting") {
    const rem = Math.max(0, waitingDuration - phaseElapsed);
    currentRound.remainingSec = Number(rem.toFixed(1));
    currentRound.progressRatio = 0;
    currentRound.mult = 1.0;
    if (rem <= 0) {
      currentRound.phase = "running";
      phaseElapsed = 0;
    }
  } else if (currentRound.phase === "running") {
    const ratio = Math.min(1, phaseElapsed / runningDuration);
    currentRound.progressRatio = Number(ratio.toFixed(4));
    currentRound.mult = Number((1.0 + (currentRound.target - 1.0) * Math.pow(ratio, 1.35)).toFixed(2));
    if (ratio >= 1) {
      currentRound.phase = "crashed";
      currentRound.mult = currentRound.target;
      phaseElapsed = 0;
      crashHistory.unshift(currentRound.target);
      if (crashHistory.length > 20) crashHistory.length = 20;
      shared.crashHistory = crashHistory;
    }
  } else if (currentRound.phase === "crashed") {
    if (phaseElapsed >= 2.2) {
      startNewWaitingPhase();
    }
  }

  broadcastJson({
    type: "ROUND_TICK",
    round: currentRound,
    crashHistory
  });
}, 100);

/* FOOTBALL SYNC FROM API-FOOTBALL */
async function syncFootballMatches() {
  try {
    const liveRaw = await apiFootballRequest("/fixtures?live=all");
    const liveNormalized = liveRaw.map((it, idx) => normalizeFixture(it, idx));

    const hasIranLive = liveNormalized.some((m) => m.isIran);
    let iranExtras = [];
    if (!hasIranLive) {
      try {
        iranExtras = await getIranDailyMatches();
      } catch {
        iranExtras = [];
      }
    }

    const merged = new Map();
    [...iranExtras, ...liveNormalized].forEach((m) => {
      if (!merged.has(m.id)) merged.set(m.id, m);
    });

    const sorted = Array.from(merged.values()).sort((a, b) => (a.isIran ? 0 : 1) - (b.isIran ? 0 : 1));
    if (sorted.length > 0) {
      shared.footballMatches = sorted.slice(0, 40);
      broadcastSharedSync();
    }
  } catch (err) {
    console.error("[FOOTBALL_SYNC_ERR]", err.message);
  }
}

syncFootballMatches();
setInterval(syncFootballMatches, FOOTBALL_POLL_MS);

/* WEBSOCKET HANDLER */
const activeMinesSessions = new Map();
const activeBjSessions = new Map();

wss.on("connection", (ws) => {
  clientMeta.set(ws, { username: "مهمان", lastChatAt: 0 });

  sendJson(ws, {
    type: "SYNC_INIT",
    round: currentRound,
    crashHistory,
    chat: chatState,
    shared
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const meta = clientMeta.get(ws) || { username: "مهمان", lastChatAt: 0 };
    const actor = String(msg.username || meta.username || "مهمان").trim() || "مهمان";

    if (msg.type === "IDENTIFY") {
      meta.username = actor;
      clientMeta.set(ws, meta);
      sendWalletSyncToUser(actor);
      return;
    }

    if (msg.type === "REGISTER_USER") {
      const uname = String(msg.username || "").trim();
      const fullName = String(msg.fullName || "").trim();
      const phone = String(msg.phone || "").trim();
      const email = String(msg.email || "").trim();
      const password = String(msg.password || "");

      if (!uname || usersDb.has(uname)) {
        sendJson(ws, { type: "AUTH_ERROR", message: "این نام کاربری قبلاً ثبت شده است." });
        return;
      }

      const newUser = {
        username: uname,
        fullName: fullName || uname,
        phone,
        email,
        password,
        demo: 10000000,
        real: 500000,
        txs: []
      };
      pushUserTx(newUser, "ثبت‌نام", "demo", 10000000, "موجودی اولیه دمو");
      pushUserTx(newUser, "ثبت‌نام", "real", 500000, "هدیه خوش‌آمدگویی واقعی");
      usersDb.set(uname, newUser);

      meta.username = uname;
      clientMeta.set(ws, meta);
      sendJson(ws, { type: "AUTH_SUCCESS", user: newUser });
      sendWalletSyncToUser(uname);
      return;
    }

    if (msg.type === "LOGIN_USER") {
      const idVal = String(msg.username || "").trim();
      const passVal = String(msg.password || "");
      let found = usersDb.get(idVal);
      if (!found) {
        for (const u of usersDb.values()) {
          if (u.phone === idVal || u.email === idVal) {
            found = u;
            break;
          }
        }
      }
      if (!found) {
        found = getOrCreateUserRecord(idVal);
      }
      if (found.password && passVal && found.password !== passVal) {
        sendJson(ws, { type: "AUTH_ERROR", message: "رمز عبور اشتباه است." });
        return;
      }
      meta.username = found.username;
      clientMeta.set(ws, meta);
      sendJson(ws, { type: "AUTH_SUCCESS", user: found });
      sendWalletSyncToUser(found.username);
      return;
    }

    if (msg.type === "TOPUP_DEMO") {
      const amt = Math.min(50000000, Math.max(1000, Number(msg.amount || 5000000)));
      const u = getOrCreateUserRecord(actor);
      u.demo += amt;
      pushUserTx(u, "شارژ دمو", "demo", amt, "شارژ سریع موجودی دمو");
      sendWalletSyncToUser(u.username);
      return;
    }

    if (msg.type === "DEPOSIT_CREATE" && msg.deposit) {
      const dep = { ...msg.deposit, status: msg.deposit.status || "pending" };
      shared.deposits.unshift(dep);
      addAuditLog(actor, `ثبت واریز ${dep.amount} تومان (${dep.method})`);
      broadcastSharedSync("درخواست واریز جدید ثبت شد");
      return;
    }

    if (msg.type === "WITHDRAW_CREATE" && msg.withdrawal) {
      const wd = { ...msg.withdrawal, status: msg.withdrawal.status || "pending" };
      const u = getOrCreateUserRecord(wd.user || actor);
      if (u.real < Number(wd.amount || 0)) {
        sendJson(ws, { type: "TOAST", message: "موجودی واقعی برای برداشت کافی نیست." });
        return;
      }
      u.real -= Number(wd.amount || 0);
      pushUserTx(u, "درخواست برداشت", "real", -Number(wd.amount || 0), `برداشت به ${wd.dest}`);
      shared.withdrawals.unshift(wd);
      addAuditLog(actor, `ثبت برداشت ${wd.amount} تومان`);
      sendWalletSyncToUser(u.username);
      broadcastSharedSync("درخواست برداشت جدید ثبت شد");
      return;
    }

    /* ADMIN ACTIONS */
    if (msg.type === "AUTH_SECRET_CODE") {
      if (String(msg.code || "").trim() === secretCode) {
        if (!shared.ownerActor) shared.ownerActor = actor;
        const isOwner = shared.ownerActor === actor;
        const sub = shared.subAdmins[actor];
        const session = isOwner
          ? { actor, rank: "مالک اصلی", isOwner: true, perms: { approveDep: true, manageWd: true, grantBal: true, modChat: true } }
          : sub
          ? { actor, rank: sub.rank, isOwner: false, perms: sub.perms }
          : { actor, rank: "ادمین فعال", isOwner: true, perms: { approveDep: true, manageWd: true, grantBal: true, modChat: true } };

        sendJson(ws, { type: "ADMIN_SESSION", session, secretCode });
        broadcastSharedSync();
      } else {
        sendJson(ws, { type: "TOAST", message: "کد مدیریتی نامعتبر است." });
      }
      return;
    }

    if (msg.type === "ADMIN_UPDATE_SECRET" && msg.secretCode) {
      secretCode = String(msg.secretCode).trim();
      addAuditLog(actor, "تغییر کد مخفی مدیریت");
      sendJson(ws, { type: "TOAST", message: "کد مخفی جدید ذخیره شد." });
      return;
    }

    if (msg.type === "ADMIN_ASSIGN_SUBADMIN" && msg.username) {
      shared.subAdmins[msg.username] = {
        username: msg.username,
        rank: msg.rank || "ناظر",
        perms: msg.perms || {}
      };
      addAuditLog(actor, `تعیین درجه ${msg.rank} برای ${msg.username}`);
      broadcastSharedSync("سطح دسترسی ادمین به‌روزرسانی شد");
      return;
    }

    if (msg.type === "ADMIN_REMOVE_SUBADMIN" && msg.username) {
      delete shared.subAdmins[msg.username];
      addAuditLog(actor, `حذف زیر‌ادمین ${msg.username}`);
      broadcastSharedSync();
      return;
    }

    if (msg.type === "ADMIN_DECIDE_DEPOSIT") {
      const dep = shared.deposits.find((d) => d.id === msg.id);
      if (dep && dep.status === "pending") {
        dep.status = msg.approve ? "approved" : "rejected";
        if (msg.approve) {
          const u = getOrCreateUserRecord(dep.user);
          u.real += Number(dep.amount || 0);
          pushUserTx(u, "تایید واریز", "real", Number(dep.amount || 0), `کد پیگیری ${dep.ref}`);
          sendWalletSyncToUser(u.username);
        }
        addAuditLog(actor, `${msg.approve ? "تایید" : "رد"} واریز ${dep.id}`);
        broadcastSharedSync();
      }
      return;
    }

    if (msg.type === "ADMIN_DECIDE_WITHDRAW") {
      const wd = shared.withdrawals.find((w) => w.id === msg.id);
      if (wd && wd.status === "pending") {
        wd.status = msg.approve ? "approved" : "rejected";
        if (!msg.approve) {
          const u = getOrCreateUserRecord(wd.user);
          u.real += Number(wd.amount || 0);
          pushUserTx(u, "برگشت برداشت ردشده", "real", Number(wd.amount || 0), `رد برداشت ${wd.id}`);
          sendWalletSyncToUser(u.username);
        }
        addAuditLog(actor, `${msg.approve ? "پرداخت" : "رد"} برداشت ${wd.id}`);
        broadcastSharedSync();
      }
      return;
    }

    if (msg.type === "ADMIN_GRANT_REAL" && msg.username) {
      const amt = Number(msg.amount || 500000);
      const u = getOrCreateUserRecord(msg.username);
      u.real += amt;
      pushUserTx(u, "شارژ مدیریتی", "real", amt, "شارژ توسط مدیریت");
      addAuditLog(actor, `شارژ ${amt} واقعی برای ${msg.username}`);
      sendWalletSyncToUser(u.username);
      broadcastSharedSync();
      return;
    }

    /* CHAT ACTIONS */
    if (msg.type === "CHAT_SEND" && msg.text) {
      const now = Date.now();
      const muteUntil = chatState.mutedUsers[actor] || 0;
      if (muteUntil > now) {
        sendJson(ws, { type: "TOAST", message: "شما در چت موقتاً میوت هستید." });
        return;
      }
      if (chatState.locked && actor !== shared.ownerActor && !shared.subAdmins[actor]) {
        sendJson(ws, { type: "TOAST", message: "چت توسط مدیریت قفل شده است." });
        return;
      }
      if (chatState.slowModeSec > 0 && now - meta.lastChatAt < chatState.slowModeSec * 1000) {
        sendJson(ws, { type: "TOAST", message: `حالت آهسته فعال است (${chatState.slowModeSec} ثانیه).` });
        return;
      }
      meta.lastChatAt = now;
      clientMeta.set(ws, meta);

      chatState.messages.push({
        id: "msg_" + now + "_" + Math.floor(Math.random() * 999),
        user: actor,
        text: String(msg.text).slice(0, 240),
        time: nowFaTime(),
        isAdmin: actor === shared.ownerActor || Boolean(shared.subAdmins[actor]),
        deleted: false
      });
      if (chatState.messages.length > 100) chatState.messages.shift();
      broadcastChatSync();
      return;
    }

    if (msg.type === "MOD_DELETE_MSG") {
      const m = chatState.messages.find((x) => x.id === msg.msgId);
      if (m) m.deleted = true;
      broadcastChatSync();
      return;
    }

    if (msg.type === "MOD_PIN_MSG") {
      chatState.pinnedId = msg.msgId || null;
      broadcastChatSync();
      return;
    }

    if (msg.type === "MOD_TOGGLE_LOCK") {
      chatState.locked = !chatState.locked;
      broadcastChatSync();
      return;
    }

    if (msg.type === "MOD_TOGGLE_SLOW") {
      chatState.slowModeSec = chatState.slowModeSec > 0 ? 0 : Number(msg.seconds || 5);
      broadcastChatSync();
      return;
    }

    if (msg.type === "MOD_CLEAR_CHAT") {
      chatState.messages = [];
      chatState.pinnedId = null;
      broadcastChatSync();
      return;
    }

    if (msg.type === "MOD_MUTE_USER" && msg.username) {
      chatState.mutedUsers[msg.username] = Date.now() + Number(msg.minutes || 10) * 60 * 1000;
      broadcastChatSync();
      return;
    }

    if (msg.type === "MOD_UNMUTE_USER" && msg.username) {
      delete chatState.mutedUsers[msg.username];
      broadcastChatSync();
      return;
    }

    /* GAMES */
    const mode = msg.mode === "real" ? "real" : "demo";
    const u = getOrCreateUserRecord(actor);

    if (msg.type === "PLAY_DICE") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      if (u[mode] < bet) return sendJson(ws, { type: "TOAST", message: "موجودی کافی نیست." });
      u[mode] -= bet;
      const roll = Math.floor(Math.random() * 100) + 1;
      const target = Math.min(95, Math.max(5, Number(msg.target || 50)));
      const dir = msg.dir === "under" ? "under" : "over";
      const won = dir === "over" ? roll > target : roll < target;
      const mult = dir === "over" ? Number((98 / Math.max(1, 100 - target)).toFixed(2)) : Number((98 / Math.max(1, target - 1)).toFixed(2));
      const payout = won ? Math.round(bet * Math.min(20, Math.max(1.05, mult))) : 0;
      if (payout > 0) u[mode] += payout;
      pushUserTx(u, "تاس", mode, payout - bet, `تاس ${roll} (${won ? "برد" : "باخت"})`);
      sendWalletSyncToUser(u.username);
      sendJson(ws, { type: "DICE_RESULT", roll, won, payout });
      return;
    }

    if (msg.type === "PLAY_ROULETTE") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      if (u[mode] < bet) return sendJson(ws, { type: "TOAST", message: "موجودی کافی نیست." });
      u[mode] -= bet;
      const num = Math.floor(Math.random() * 37);
      const reds = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
      const color = num === 0 ? "green" : reds.has(num) ? "red" : "black";
      const won = msg.pick === color;
      const payout = won ? bet * (color === "green" ? 14 : 2) : 0;
      if (payout > 0) u[mode] += payout;
      pushUserTx(u, "رولت", mode, payout - bet, `عدد ${num}`);
      sendWalletSyncToUser(u.username);
      sendJson(ws, { type: "ROULETTE_RESULT", num, color, won, payout });
      return;
    }

    if (msg.type === "PLAY_SLOTS") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      if (u[mode] < bet) return sendJson(ws, { type: "TOAST", message: "موجودی کافی نیست." });
      u[mode] -= bet;
      const syms = ["💎", "👑", "🍀", "🍒", "🔔"];
      const reels = [0, 1, 2].map(() => syms[Math.floor(Math.random() * syms.length)]);
      const won = reels[0] === reels[1] && reels[1] === reels[2];
      const payout = won ? bet * 8 : 0;
      if (payout > 0) u[mode] += payout;
      pushUserTx(u, "اسلات", mode, payout - bet, reels.join(" "));
      sendWalletSyncToUser(u.username);
      sendJson(ws, { type: "SLOTS_RESULT", reels, won, payout });
      return;
    }

    if (msg.type === "PLAY_PLINKO") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      if (u[mode] < bet) return sendJson(ws, { type: "TOAST", message: "موجودی کافی نیست." });
      u[mode] -= bet;
      const mults = msg.risk === "low" ? [2.2, 1.4, 1.1, 0.9, 1.1, 1.4, 2.2] : [6.5, 2.5, 1.2, 0.5, 1.2, 2.5, 6.5];
      const idx = Math.floor(Math.random() * mults.length);
      const mult = mults[idx];
      const payout = Math.round(bet * mult);
      if (payout > 0) u[mode] += payout;
      pushUserTx(u, "پینکلو", mode, payout - bet, `ضریب ${mult}x`);
      sendWalletSyncToUser(u.username);
      sendJson(ws, { type: "PLINKO_RESULT", idx, mult, bet, payout });
      return;
    }

    if (msg.type === "MINES_START") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      const count = Math.min(18, Math.max(1, Number(msg.count || 3)));
      if (u[mode] < bet) return sendJson(ws, { type: "TOAST", message: "موجودی کافی نیست." });
      u[mode] -= bet;
      const mineSet = new Set();
      while (mineSet.size < count) mineSet.add(Math.floor(Math.random() * 25));
      activeMinesSessions.set(actor, { bet, mode, mines: Array.from(mineSet), opened: [], mult: 1.0 });
      sendWalletSyncToUser(u.username);
      sendJson(ws, { type: "MINES_STARTED", bet });
      return;
    }

    if (msg.type === "MINES_PICK") {
      const sess = activeMinesSessions.get(actor);
      if (!sess) return;
      const cell = Number(msg.cell);
      if (sess.mines.includes(cell)) {
        activeMinesSessions.delete(actor);
        pushUserTx(u, "مین‌روب", sess.mode, -sess.bet, "برخورد به مین");
        sendJson(ws, { type: "MINES_HIT_MINE", mines: sess.mines });
      } else {
        sess.opened.push(cell);
        sess.mult = Number((1 + sess.opened.length * (0.22 + sess.mines.length * 0.05)).toFixed(2));
        const potential = Math.round(sess.bet * sess.mult);
        sendJson(ws, { type: "MINES_SAFE", cell, mult: sess.mult, potential });
      }
      return;
    }

    if (msg.type === "MINES_CASHOUT") {
      const sess = activeMinesSessions.get(actor);
      if (!sess) return;
      const payout = Math.round(sess.bet * sess.mult);
      u[sess.mode] += payout;
      activeMinesSessions.delete(actor);
      pushUserTx(u, "مین‌روب", sess.mode, payout - sess.bet, `برداشت ${sess.mult}x`);
      sendWalletSyncToUser(u.username);
      sendJson(ws, { type: "MINES_CASHED", payout });
      return;
    }

    if (msg.type === "BJ_DEAL") {
      const bet = Math.max(1000, Number(msg.bet || 0));
      if (u[mode] < bet) return sendJson(ws, { type: "TOAST", message: "موجودی کافی نیست." });
      u[mode] -= bet;
      const suits = ["♠", "♥", "♦", "♣"];
      const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
      const drawCard = () => {
        const suit = suits[Math.floor(Math.random() * suits.length)];
        const rank = ranks[Math.floor(Math.random() * ranks.length)];
        const val = rank === "A" ? 11 : ["K", "Q", "J"].includes(rank) ? 10 : Number(rank);
        return { suit, rank, val, red: suit === "♥" || suit === "♦" };
      };
      const player = [drawCard(), drawCard()];
      const dealer = [drawCard()];
      activeBjSessions.set(actor, { bet, mode, player, dealer, drawCard });
      const sumHand = (h) => h.reduce((a, b) => a + b.val, 0);
      sendWalletSyncToUser(u.username);
      sendJson(ws, { type: "BJ_STATE", status: "playing", player, dealer, playerSum: sumHand(player), dealerSum: sumHand(dealer) });
      return;
    }

    if (msg.type === "BJ_HIT") {
      const sess = activeBjSessions.get(actor);
      if (!sess) return;
      sess.player.push(sess.drawCard());
      const pSum = sess.player.reduce((a, b) => a + b.val, 0);
      const dSum = sess.dealer.reduce((a, b) => a + b.val, 0);
      if (pSum > 21) {
        activeBjSessions.delete(actor);
        pushUserTx(u, "بلک‌جک", sess.mode, -sess.bet, "بیش از ۲۱");
        sendJson(ws, { type: "BJ_STATE", status: "bust", player: sess.player, dealer: sess.dealer, playerSum: pSum, dealerSum: dSum });
      } else {
        sendJson(ws, { type: "BJ_STATE", status: "playing", player: sess.player, dealer: sess.dealer, playerSum: pSum, dealerSum: dSum });
      }
      return;
    }

    if (msg.type === "BJ_STAND") {
      const sess = activeBjSessions.get(actor);
      if (!sess) return;
      let dSum = sess.dealer.reduce((a, b) => a + b.val, 0);
      while (dSum < 17) {
        sess.dealer.push(sess.drawCard());
        dSum = sess.dealer.reduce((a, b) => a + b.val, 0);
      }
      const pSum = sess.player.reduce((a, b) => a + b.val, 0);
      activeBjSessions.delete(actor);
      let outcome = "lose";
      let payout = 0;
      if (dSum > 21 || pSum > dSum) {
        outcome = "win";
        payout = sess.bet * 2;
      } else if (pSum === dSum) {
        outcome = "push";
        payout = sess.bet;
      }
      if (payout > 0) u[sess.mode] += payout;
      pushUserTx(u, "بلک‌جک", sess.mode, payout - sess.bet, `نتیجه: ${outcome}`);
      sendWalletSyncToUser(u.username);
      sendJson(ws, { type: "BJ_STATE", status: "done", outcome, payout, player: sess.player, dealer: sess.dealer, playerSum: pSum, dealerSum: dSum });
      return;
    }

    if (msg.type === "PLACE_FOOTBALL_BET") {
      const stake = Math.max(1000, Number(msg.bet || 0));
      if (u[mode] < stake) return sendJson(ws, { type: "TOAST", message: "موجودی کافی نیست." });
      const mList = shared.footballMatches || [];
      const match = mList[Number(msg.matchIdx || 0)] || mList[0] || { home: "میزبان", away: "مهمان", hOdd: 2.1, dOdd: 3.2, aOdd: 2.9 };
      const market = msg.market === "draw" ? "draw" : msg.market === "away" ? "away" : "home";
      const odd = market === "draw" ? Number(match.dOdd || 3.2) : market === "away" ? Number(match.aOdd || 2.9) : Number(match.hOdd || 2.1);
      const potential = Math.round(stake * odd);

      u[mode] -= stake;
      pushUserTx(u, "فوتبال زنده", mode, -stake, `${match.home} - ${match.away}`);

      const list = userFootballBets.get(u.username) || [];
      list.unshift({
        match_label: `${match.home} - ${match.away}`,
        market: market === "draw" ? "مساوی" : market === "away" ? "برد مهمان" : "برد میزبان",
        odd,
        stake,
        status: "در انتظار"
      });
      userFootballBets.set(u.username, list);

      sendWalletSyncToUser(u.username);
      sendJson(ws, { type: "FOOTBALL_BET_ACCEPTED", bet: stake, odd, potential });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

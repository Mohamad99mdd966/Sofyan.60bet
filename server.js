const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ status: "ok", service: "sofyan-ws-sync" }));
});

const wss = new WebSocketServer({ server });

// Shared server state across all connected devices
const sharedState = {
  secretCode: "11228",
  ownerActor: null,
  subAdmins: {}, // username -> { username, rank, perms }
  chat: {
    locked: false,
    slowModeSec: 0,
    pinnedId: null,
    mutedUsers: {}, // username -> expiresAtMs
    messages: [
      {
        id: "m_server_init",
        user: "سیستم",
        isAdmin: true,
        text: "سرور همگام‌سازی راند و چت زنده متصل شد.",
        time: new Date().toLocaleTimeString("fa-IR"),
        deleted: false
      }
    ]
  },
  crashHistory: [1.42, 2.85, 1.18, 4.60, 1.94, 3.12]
};

const userLastChatMap = new Map(); // username -> lastSentMs

function deterministicCrashPoint(roundIndex, secretSalt = "sofyan_crash_v1") {
  const hash = crypto
    .createHmac("sha256", secretSalt)
    .update(`round:${roundIndex}`)
    .digest("hex");
  const u = parseInt(hash.slice(0, 8), 16) / 0xffffffff;
  if (u < 0.32) return Number((1.12 + (u / 0.32) * 0.78).toFixed(2));
  if (u < 0.75) return Number((1.90 + ((u - 0.32) / 0.43) * 2.20).toFixed(2));
  if (u < 0.94) return Number((4.10 + ((u - 0.75) / 0.19) * 5.40).toFixed(2));
  return Number((9.50 + ((u - 0.94) / 0.06) * 14.0).toFixed(2));
}

function getCrashDurationMs(targetMult) {
  return Math.max(1400, Math.min(18000, Math.pow(targetMult - 1.0, 0.72) * 2600 + 1400));
}

// Authoritative server round engine
const ROUND_EPOCH_MS = Date.now() - 1000;
const WAITING_MS = 2200;
const CRASH_PAUSE_MS = 2200;
let lastRecordedRound = -1;

function getAuthoritativeRoundSnapshot(nowMs = Date.now()) {
  const avgSpan = 6500;
  const approxIdx = Math.max(0, Math.floor((nowMs - ROUND_EPOCH_MS) / avgSpan));
  let idx = Math.max(0, approxIdx - 10);
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
  }
}

function broadcast(packetObj) {
  const raw = JSON.stringify(packetObj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(raw);
    }
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

wss.on("connection", (ws) => {
  ws.username = "مهمان";
  ws.adminSession = null;

  // Send immediate sync on connect
  ws.send(
    JSON.stringify({
      type: "SYNC_INIT",
      round: getAuthoritativeRoundSnapshot(),
      chat: sanitizeChatForBroadcast(),
      crashHistory: sharedState.crashHistory
    })
  );

  ws.on("message", (rawMsg) => {
    let data;
    try {
      data = JSON.parse(String(rawMsg));
    } catch {
      return;
    }

    if (data.type === "IDENTIFY") {
      ws.username = String(data.username || "مهمان").trim().slice(0, 32) || "مهمان";
      return;
    }

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
          rank: "ادمین اصلی",
          perms: { approveDep: true, manageWd: true, grantBal: true, modChat: true }
        };
        ws.send(JSON.stringify({ type: "ADMIN_SESSION", session: ws.adminSession }));
        broadcast({ type: "TOAST", message: `${actor} به‌عنوان ادمین اصلی ثبت شد` });
        return;
      }
      if (sharedState.ownerActor === actor) {
        ws.adminSession = {
          actor,
          isOwner: true,
          rank: "ادمین اصلی",
          perms: { approveDep: true, manageWd: true, grantBal: true, modChat: true }
        };
        ws.send(JSON.stringify({ type: "ADMIN_SESSION", session: ws.adminSession }));
        return;
      }
      if (sharedState.subAdmins[actor]) {
        ws.adminSession = {
          actor,
          isOwner: false,
          rank: sharedState.subAdmins[actor].rank,
          perms: { ...sharedState.subAdmins[actor].perms }
        };
        ws.send(JSON.stringify({ type: "ADMIN_SESSION", session: ws.adminSession }));
        return;
      }
      ws.send(JSON.stringify({ type: "TOAST", message: "کد صحیح است اما درجه ادمین برای این کاربر ثبت نشده است" }));
      return;
    }

    if (data.type === "CHAT_SEND") {
      const sender = String(data.username || ws.username || "مهمان").trim().slice(0, 32);
      const text = String(data.text || "").trim().slice(0, 240);
      if (!text) return;

      const isAdmin = isClientAdminWithChatPerm(ws);
      if (sharedState.chat.locked && !isAdmin) {
        ws.send(JSON.stringify({ type: "TOAST", message: "چت زنده قفل است" }));
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

    // Admin chat moderation commands
    if (data.type === "MOD_DELETE_MSG" && isClientAdminWithChatPerm(ws)) {
      const msg = sharedState.chat.messages.find((m) => m.id === data.msgId);
      if (msg) msg.deleted = true;
      if (sharedState.chat.pinnedId === data.msgId) sharedState.chat.pinnedId = null;
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_PIN_MSG" && isClientAdminWithChatPerm(ws)) {
      sharedState.chat.pinnedId = data.msgId || null;
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_TOGGLE_LOCK" && isClientAdminWithChatPerm(ws)) {
      sharedState.chat.locked = !sharedState.chat.locked;
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_TOGGLE_SLOW" && isClientAdminWithChatPerm(ws)) {
      sharedState.chat.slowModeSec = sharedState.chat.slowModeSec > 0 ? 0 : Number(data.seconds || 5);
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_CLEAR_CHAT" && isClientAdminWithChatPerm(ws)) {
      sharedState.chat.messages = [];
      sharedState.chat.pinnedId = null;
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_MUTE_USER" && isClientAdminWithChatPerm(ws)) {
      const target = String(data.username || "").trim();
      const mins = Math.max(1, Number(data.minutes || 10));
      if (target) sharedState.chat.mutedUsers[target] = Date.now() + mins * 60000;
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }

    if (data.type === "MOD_UNMUTE_USER" && isClientAdminWithChatPerm(ws)) {
      const target = String(data.username || "").trim();
      if (target) delete sharedState.chat.mutedUsers[target];
      broadcast({ type: "CHAT_SYNC", chat: sanitizeChatForBroadcast() });
      return;
    }
  });
});

// Broadcast authoritative Crash tick 10 times/sec to every connected client
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

server.listen(PORT, () => {
  console.log(`Sofyan WebSocket Server running on ws://localhost:${PORT}`);
});

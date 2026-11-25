const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const footballService = require("./footballService");

const PORT = Number(process.env.PORT || 3000);
const STATE_FILE = path.join(__dirname, "casino-state.json");
const BACKUP_DIR = path.join(__dirname, "backups");
const INDEX_FILE = path.join(__dirname, "index.html");
const CHALLENGE_SECRET = process.env.CHALLENGE_SECRET || crypto.randomBytes(24).toString("hex");
const MASTER_ADMIN_SECRET = process.env.MASTER_ADMIN_SECRET || "SOFYAN_MASTER_2026";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDir(BACKUP_DIR);

function createHumanChallenge() {
  const a = Math.floor(Math.random() * 8) + 2;
  const b = Math.floor(Math.random() * 8) + 2;
  const answer = String(a + b);
  const exp = Date.now() + CHALLENGE_TTL_MS;
  const nonce = crypto.randomBytes(8).toString("hex");
  const payload = Buffer.from(
    JSON.stringify({
      exp,
      nonce,
      h: crypto.createHash("sha256").update(`${answer}:${nonce}`).digest("hex")
    })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", CHALLENGE_SECRET).update(payload).digest("base64url");
  return {
    token: `${payload}.${sig}`,
    question: `${a} + ${b} = ?`,
    expiresAt: exp
  };
}

function verifyHumanChallenge(token, userAnswer) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", CHALLENGE_SECRET).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return false;

  let data = null;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!data || typeof data.exp !== "number" || Date.now() > data.exp) return false;

  const cleanAns = String(userAnswer ?? "").trim();
  const ansHash = crypto.createHash("sha256").update(`${cleanAns}:${data.nonce}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(ansHash), Buffer.from(String(data.h || "")));
}

function isMasterSecretValid(secretInput) {
  if (!secretInput || typeof secretInput !== "string") return false;
  const a = Buffer.from(String(secretInput));
  const b = Buffer.from(String(MASTER_ADMIN_SECRET));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getAllProjectSourceCode() {
  const filesToRead = ["server.js", "footballService.js", "index.html", "package.json", "railpack.json"];
  const sources = {};
  for (const fname of filesToRead) {
    const full = path.join(__dirname, fname);
    sources[fname] = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
  }
  return sources;
}

function defaultState() {
  return {
    brandName: "صوفیان بت",
    brandSlug: "sofyanbet",
    footballApiKey: process.env.FOOTBALL_API_KEY || footballService.DEFAULT_FOOTBALL_API_KEY,
    lastMatches: [],
    lastFootballError: "",
    footballBets: [],
    gameHistory: [],
    waitingDuelPlayer: null,
    chatMessages: [
      { id: "m1", sender: "سیستم صوفیان بت", text: "به صوفیان بت (SofyanBet) خوش آمدید.", time: "امروز" }
    ],
    stats: {
      totalBets: 0,
      totalVolume: 0
    }
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      return { ...defaultState(), ...raw };
    }
  } catch (err) {
    console.error("Error reading state:", err.message);
  }
  return defaultState();
}

let state = loadState();

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("Error writing state:", err.message);
  }
}

function createBackupSnapshot() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `state-${stamp}.json`;
  const target = path.join(BACKUP_DIR, fileName);
  fs.writeFileSync(target, JSON.stringify(state, null, 2), "utf8");
  return fileName;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-master-secret"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-master-secret"
    });
    return res.end();
  }

  if (req.method === "GET" && reqUrl.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      brand: "صوفیان بت",
      slug: "sofyanbet",
      tehranDate: footballService.getTodayDateIsoTehran(),
      uptimeSec: Math.floor(process.uptime())
    });
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/human-challenge") {
    return sendJson(res, 200, { ok: true, challenge: createHumanChallenge() });
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/human-challenge/verify") {
    try {
      const parsed = await readJsonBody(req);
      const valid = verifyHumanChallenge(parsed.token, parsed.answer);
      if (!valid) {
        return sendJson(res, 400, { ok: false, message: "پاسخ تایید ربات نادرست یا منقضی است." });
      }
      return sendJson(res, 200, { ok: true, verified: true });
    } catch {
      return sendJson(res, 400, { ok: false, message: "درخواست نامعتبر است." });
    }
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/master/access") {
    try {
      const parsed = await readJsonBody(req);
      const secret = parsed.secret || req.headers["x-master-secret"] || "";
      if (!isMasterSecretValid(secret)) {
        return sendJson(res, 403, { ok: false, message: "رمز مخفی مدیر اصلی نادرست است." });
      }
      return sendJson(res, 200, {
        ok: true,
        brandName: state.brandName,
        brandSlug: state.brandSlug,
        stats: state.stats,
        lastFootballError: state.lastFootballError,
        sources: getAllProjectSourceCode(),
        fullState: state
      });
    } catch {
      return sendJson(res, 400, { ok: false, message: "خطا در پردازش درخواست مدیر اصلی." });
    }
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/master/update-state") {
    try {
      const parsed = await readJsonBody(req);
      const secret = parsed.secret || req.headers["x-master-secret"] || "";
      if (!isMasterSecretValid(secret)) {
        return sendJson(res, 403, { ok: false, message: "رمز مخفی مدیر اصلی نادرست است." });
      }
      if (typeof parsed.footballApiKey === "string" && parsed.footballApiKey.trim()) {
        state.footballApiKey = parsed.footballApiKey.trim();
      }
      if (parsed.resetDuelQueue) {
        state.waitingDuelPlayer = null;
      }
      if (parsed.clearHistory) {
        state.gameHistory = [];
        state.footballBets = [];
      }
      saveState();
      return sendJson(res, 200, { ok: true, message: "تنظیمات سایت توسط مدیر اصلی اعمال شد." });
    } catch {
      return sendJson(res, 400, { ok: false, message: "خطا در ذخیره تنظیمات مدیر اصلی." });
    }
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/football/today") {
    const dateIso = reqUrl.searchParams.get("date") || footballService.getTodayDateIsoTehran();
    const force = reqUrl.searchParams.get("force") === "1";
    const apiKey = reqUrl.searchParams.get("apiKey") || state.footballApiKey;

    try {
      const matches = await footballService.getMatchesByDate(dateIso, apiKey, force);
      state.lastMatches = matches;
      state.lastFootballError = "";
      footballService.settleFootballBets(state.footballBets, matches);
      saveState();
      return sendJson(res, 200, { ok: true, date: dateIso, matches });
    } catch (err) {
      state.lastFootballError = err.message;
      saveState();
      return sendJson(res, 502, { ok: false, error: err.message, matches: [] });
    }
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/admin/backups") {
    const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).sort().reverse() : [];
    return sendJson(res, 200, { ok: true, backups: files });
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/admin/backups") {
    const file = createBackupSnapshot();
    return sendJson(res, 200, { ok: true, file });
  }

  if (req.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html")) {
    if (fs.existsSync(INDEX_FILE)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(INDEX_FILE).pipe(res);
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("index.html not found");
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

const wss = new WebSocketServer({ server });

function broadcast(dataObj) {
  const payload = JSON.stringify(dataObj);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "INIT_STATE",
      brandName: state.brandName,
      brandSlug: state.brandSlug,
      matches: state.lastMatches,
      lastFootballError: state.lastFootballError,
      footballBets: state.footballBets,
      gameHistory: state.gameHistory,
      waitingDuelPlayer: state.waitingDuelPlayer,
      chatMessages: state.chatMessages,
      stats: state.stats,
      challenge: createHumanChallenge()
    })
  );

  ws.on("message", async (raw) => {
    let msg = null;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === "REFRESH_HUMAN_CHALLENGE") {
      ws.send(JSON.stringify({ type: "HUMAN_CHALLENGE", challenge: createHumanChallenge() }));
      return;
    }

    if (msg.type === "FETCH_TODAY_FOOTBALL") {
      const dateIso = msg.date || footballService.getTodayDateIsoTehran();
      const apiKey = msg.apiKey || state.footballApiKey;
      try {
        const matches = await footballService.getMatchesByDate(dateIso, apiKey, Boolean(msg.force));
        state.lastMatches = matches;
        state.lastFootballError = "";
        footballService.settleFootballBets(state.footballBets, matches);
        saveState();
        broadcast({ type: "FOOTBALL_MATCHES_UPDATED", matches, error: "" });
      } catch (err) {
        state.lastMatches = [];
        state.lastFootballError = err.message;
        saveState();
        ws.send(JSON.stringify({ type: "FOOTBALL_ERROR", error: err.message, matches: [] }));
      }
      return;
    }

    if (msg.type === "PLACE_FOOTBALL_BET") {
      if (!verifyHumanChallenge(msg.challengeToken, msg.challengeAnswer)) {
        ws.send(
          JSON.stringify({
            type: "BET_REJECTED",
            message: "ابتدا تایید ضدربات را کامل کنید.",
            challenge: createHumanChallenge()
          })
        );
        return;
      }

      const priced = footballService.validateAndPricePreMatchBet(state.lastMatches, {
        matchId: msg.matchId,
        marketKey: msg.marketKey,
        stake: msg.stake
      });

      if (!priced.ok) {
        ws.send(JSON.stringify({ type: "BET_REJECTED", message: priced.message }));
        return;
      }

      const betRecord = {
        id: `fb_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        matchId: priced.match.id,
        match_label: `${priced.match.home} - ${priced.match.away}`,
        kickoffTime: priced.match.kickoffTime,
        market: priced.market.key,
        marketLabel: priced.market.label,
        odd: priced.odd,
        stake: priced.stake,
        potentialPayout: priced.potentialPayout,
        mode: msg.mode === "real" ? "real" : "demo",
        settled: false,
        status: "در انتظار نتیجه",
        createdAt: new Date().toISOString()
      };

      state.footballBets.unshift(betRecord);
      state.stats.totalBets += 1;
      state.stats.totalVolume += priced.stake;
      saveState();

      ws.send(JSON.stringify({ type: "BET_ACCEPTED", bet: betRecord, footballBets: state.footballBets }));
      return;
    }

    if (msg.type === "DUEL_JOIN_QUEUE") {
      const playerName = String(msg.playerName || "کاربر صوفیان بت").trim().slice(0, 30);
      const choice = ["rock", "paper", "scissors"].includes(msg.choice) ? msg.choice : "rock";
      const stake = Math.max(1000, Math.round(Number(msg.stake || 10000)));

      if (!state.waitingDuelPlayer) {
        state.waitingDuelPlayer = {
          playerName,
          choice,
          stake,
          createdAt: Date.now()
        };
        saveState();
        broadcast({ type: "DUEL_QUEUE_UPDATED", waitingDuelPlayer: state.waitingDuelPlayer });
        return;
      }

      const p1 = state.waitingDuelPlayer;
      state.waitingDuelPlayer = null;
      const p2 = { playerName, choice, stake };

      const beats = { rock: "scissors", paper: "rock", scissors: "paper" };
      let outcome = "draw";
      if (beats[p1.choice] === p2.choice) outcome = "p1";
      else if (beats[p2.choice] === p1.choice) outcome = "p2";

      const duelResult = {
        id: `duel_${Date.now()}`,
        p1,
        p2,
        outcome,
        pot: Math.min(p1.stake, p2.stake) * 2,
        time: new Date().toLocaleTimeString("fa-IR", { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit" })
      };

      state.gameHistory.unshift({ type: "duel", ...duelResult });
      state.gameHistory = state.gameHistory.slice(0, 40);
      saveState();

      broadcast({
        type: "DUEL_MATCH_FINISHED",
        duelResult,
        waitingDuelPlayer: null
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`SofyanBet server running on port ${PORT}`);
});

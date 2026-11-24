const https = require("https");

const API_HOST = process.env.FOOTBALL_API_HOST || "v3.football.api-sports.io";
const API_KEY = process.env.FOOTBALL_API_KEY || "";
const POLL_INTERVAL_MS = Number(process.env.FOOTBALL_POLL_MS || 30000);

const FALLBACK_MATCHES = [
  {
    id: "m0",
    league: "لیگ برتر",
    home: "استقلال",
    away: "پرسپولیس",
    hScore: 1,
    aScore: 0,
    min: 34,
    status: "LIVE",
    hOdd: 2.15,
    dOdd: 3.10,
    aOdd: 3.05,
    ballX: 0.56,
    ballY: 0.48
  },
  {
    id: "m1",
    league: "لالیگا",
    home: "رئال مادرید",
    away: "بارسلونا",
    hScore: 0,
    aScore: 0,
    min: 19,
    status: "LIVE",
    hOdd: 2.05,
    dOdd: 3.40,
    aOdd: 2.90,
    ballX: 0.44,
    ballY: 0.52
  },
  {
    id: "m2",
    league: "لیگ قهرمانان",
    home: "منچستر سیتی",
    away: "بایرن مونیخ",
    hScore: 2,
    aScore: 1,
    min: 67,
    status: "LIVE",
    hOdd: 1.88,
    dOdd: 3.55,
    aOdd: 3.45,
    ballX: 0.62,
    ballY: 0.42
  }
];

let cache = {
  updatedAt: 0,
  matches: FALLBACK_MATCHES.map((m) => ({ ...m }))
};

function fetchLiveFixturesFromApi() {
  return new Promise((resolve, reject) => {
    if (!API_KEY) {
      return resolve(null);
    }

    const options = {
      hostname: API_HOST,
      path: "/fixtures?live=all",
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
        "x-rapidapi-key": API_KEY
      },
      timeout: 8000
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Football API status ${res.statusCode}`));
        }
        try {
          const parsed = JSON.parse(body);
          resolve(Array.isArray(parsed.response) ? parsed.response : []);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Football API timeout"));
    });

    req.on("error", reject);
    req.end();
  });
}

function normalizeFixtures(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.slice(0, 25).map((item, idx) => {
    const f = item.fixture || {};
    const league = item.league || {};
    const teams = item.teams || {};
    const goals = item.goals || {};
    const statusShort = (f.status && f.status.short) || "LIVE";
    const elapsed = Number((f.status && f.status.elapsed) || 0);

    return {
      id: String(f.id || `api_${idx}`),
      league: league.name || "مسابقات جهانی",
      home: (teams.home && teams.home.name) || "تیم میزبان",
      away: (teams.away && teams.away.name) || "تیم مهمان",
      hScore: Number(goals.home ?? 0),
      aScore: Number(goals.away ?? 0),
      min: elapsed,
      status: statusShort,
      hOdd: 2.10,
      dOdd: 3.25,
      aOdd: 3.10,
      ballX: 0.5,
      ballY: 0.5
    };
  });
}

async function refreshFootballMatches(force = false) {
  const now = Date.now();
  if (!force && now - cache.updatedAt < POLL_INTERVAL_MS) {
    return cache.matches;
  }

  try {
    const raw = await fetchLiveFixturesFromApi();
    if (raw === null) {
      cache.matches = cache.matches.map((m) => ({
        ...m,
        min: m.min >= 90 ? 1 : m.min + 1,
        ballX: Number((0.15 + Math.random() * 0.7).toFixed(2)),
        ballY: Number((0.15 + Math.random() * 0.7).toFixed(2))
      }));
      cache.updatedAt = now;
      return cache.matches;
    }

    const normalized = normalizeFixtures(raw);
    if (normalized.length > 0) {
      cache.matches = normalized;
    }
    cache.updatedAt = now;
    return cache.matches;
  } catch (err) {
    console.error("Football sync error:", err.message);
    cache.updatedAt = now;
    return cache.matches;
  }
}

function resolveWinnerMarket(match, market) {
  if (!match || match.status !== "FT") return null;
  if (market === "home") return match.hScore > match.aScore;
  if (market === "draw") return match.hScore === match.aScore;
  if (market === "away") return match.aScore > match.hScore;
  return null;
}

module.exports = {
  POLL_INTERVAL_MS,
  refreshFootballMatches,
  resolveWinnerMarket
};

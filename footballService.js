const https = require("https");

const API_FOOTBALL_HOST = "v3.football.api-sports.io";
const DEFAULT_FOOTBALL_API_KEY = "16b56f006580350bec61c8985d302223";
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes cache

const fixturesCache = new Map(); // key: `${dateIso}:${apiKey}` -> { fetchedAt, matches }

function getTodayDateIsoTehran() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year")?.value || "2026";
  const m = parts.find((p) => p.type === "month")?.value || "11";
  const d = parts.find((p) => p.type === "day")?.value || "25";
  return `${y}-${m}-${d}`;
}

function formatKickoffTehran(isoDate, timestampSec) {
  let dt = null;
  if (typeof timestampSec === "number" && timestampSec > 0) {
    dt = new Date(timestampSec * 1000);
  } else if (isoDate) {
    const parsed = new Date(isoDate);
    if (!Number.isNaN(parsed.getTime())) dt = parsed;
  }

  if (!dt) {
    return {
      kickoffTime: "--:--",
      kickoffFull: "--:--",
      kickoffIso: null,
      kickoffMs: null
    };
  }

  const kickoffTime = new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit"
  }).format(dt);

  const kickoffFull = new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(dt);

  return {
    kickoffTime,
    kickoffFull,
    kickoffIso: dt.toISOString(),
    kickoffMs: dt.getTime()
  };
}

function isPreMatchBetAllowed(match, nowMs = Date.now()) {
  if (!match) return false;
  const statusShort = String(match.status || "NS").toUpperCase();
  if (statusShort !== "NS" && statusShort !== "TBD") {
    return false;
  }
  if (typeof match.kickoffMs === "number" && match.kickoffMs > 0 && nowMs >= match.kickoffMs) {
    return false;
  }
  return true;
}

function buildMarkets(match) {
  const h = Math.max(1.15, Number(match?.hOdd || 2.15));
  const d = Math.max(1.50, Number(match?.dOdd || 3.15));
  const a = Math.max(1.15, Number(match?.aOdd || 2.95));

  return {
    home: { key: "home", label: "برد میزبان (1)", odd: h },
    draw: { key: "draw", label: "مساوی (X)", odd: d },
    away: { key: "away", label: "برد مهمان (2)", odd: a },
    dc_1x: { key: "dc_1x", label: "میزبان یا مساوی (1X)", odd: Number(Math.max(1.08, ((h * d) / (h + d)) * 1.15).toFixed(2)) },
    dc_12: { key: "dc_12", label: "برد یکی از دو تیم (12)", odd: Number(Math.max(1.08, ((h * a) / (h + a)) * 1.15).toFixed(2)) },
    dc_x2: { key: "dc_x2", label: "مساوی یا مهمان (X2)", odd: Number(Math.max(1.08, ((d * a) / (d + a)) * 1.15).toFixed(2)) },
    over_25: { key: "over_25", label: "بالاتر از ۲.۵ گل", odd: 1.9 },
    under_25: { key: "under_25", label: "پایین‌تر از ۲.۵ گل", odd: 1.85 },
    btts_yes: { key: "btts_yes", label: "هر دو تیم گل می‌زنند", odd: 1.78 }
  };
}

function mapFixtureItem(item) {
  const f = item?.fixture || {};
  const l = item?.league || {};
  const teams = item?.teams || {};
  const goals = item?.goals || {};
  const statusShort = String(f?.status?.short || "NS").toUpperCase();
  const ko = formatKickoffTehran(f?.date, f?.timestamp);
  const idNum = Number(f?.id || Math.floor(Math.random() * 1e7));

  const hOdd = Number((1.75 + ((idNum % 14) * 0.11)).toFixed(2));
  const dOdd = Number((2.95 + ((idNum % 9) * 0.08)).toFixed(2));
  const aOdd = Number((1.85 + (((idNum >> 2) % 15) * 0.12)).toFixed(2));

  const match = {
    id: String(f?.id || idNum),
    league: l?.name || "Football",
    country: l?.country || "",
    home: teams?.home?.name || "Home",
    away: teams?.away?.name || "Away",
    hScore: Number(goals?.home ?? 0),
    aScore: Number(goals?.away ?? 0),
    min: Number(f?.status?.elapsed ?? 0),
    status: statusShort,
    statusLong: f?.status?.long || statusShort,
    kickoffTime: ko.kickoffTime,
    kickoffFull: ko.kickoffFull,
    kickoffIso: ko.kickoffIso,
    kickoffMs: ko.kickoffMs,
    hOdd,
    dOdd,
    aOdd
  };

  match.preMatchAllowed = isPreMatchBetAllowed(match);
  match.markets = buildMarkets(match);
  return match;
}

function requestApiFootballFixtures(dateIso, apiKey = DEFAULT_FOOTBALL_API_KEY) {
  return new Promise((resolve, reject) => {
    const reqPath = `/fixtures?date=${encodeURIComponent(dateIso)}`;
    const options = {
      hostname: API_FOOTBALL_HOST,
      port: 443,
      path: reqPath,
      method: "GET",
      headers: {
        "x-apisports-key": String(apiKey || process.env.FOOTBALL_API_KEY || DEFAULT_FOOTBALL_API_KEY)
      }
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (err) {
          return reject(new Error(`پاسخ نامعتبر از API-Football: ${err.message}`));
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg =
            parsed?.message ||
            (parsed?.errors && typeof parsed.errors === "object" ? Object.values(parsed.errors).join(" | ") : "") ||
            `خطای HTTP ${res.statusCode} از API-Football`;
          return reject(new Error(msg));
        }

        if (parsed?.errors && Object.keys(parsed.errors).length > 0) {
          return reject(new Error(Object.values(parsed.errors).join(" | ")));
        }

        const list = Array.isArray(parsed?.response) ? parsed.response.map(mapFixtureItem) : [];
        resolve(list);
      });
    });

    req.on("error", (err) => {
      reject(new Error(`خطای شبکه در اتصال به API-Football: ${err.message}`));
    });

    req.setTimeout(12000, () => {
      req.destroy(new Error("مهلت زمانی درخواست به API-Football پایان یافت."));
    });

    req.end();
  });
}

async function getMatchesByDate(dateIso = getTodayDateIsoTehran(), apiKey = DEFAULT_FOOTBALL_API_KEY, forceRefresh = false) {
  const cleanKey = String(apiKey || process.env.FOOTBALL_API_KEY || DEFAULT_FOOTBALL_API_KEY).trim();
  const cacheKey = `${dateIso}:${cleanKey}`;
  const cached = fixturesCache.get(cacheKey);

  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.matches.map((m) => ({
      ...m,
      preMatchAllowed: isPreMatchBetAllowed(m)
    }));
  }

  const matches = await requestApiFootballFixtures(dateIso, cleanKey);
  fixturesCache.set(cacheKey, {
    fetchedAt: Date.now(),
    matches
  });

  return matches.map((m) => ({
    ...m,
    preMatchAllowed: isPreMatchBetAllowed(m)
  }));
}

function validateAndPricePreMatchBet(matches, { matchId, marketKey, stake }) {
  const cleanStake = Math.round(Number(stake || 0));
  if (cleanStake < 1000) {
    return { ok: false, message: "حداقل مبلغ پیش‌بینی ۱,۰۰۰ تومان است." };
  }

  const match = Array.isArray(matches)
    ? matches.find((m) => String(m.id) === String(matchId))
    : null;

  if (!match) {
    return {
      ok: false,
      message: "مسابقه انتخاب‌شده در لیست مسابقات روز یافت نشد؛ ابتدا مسابقات را به‌روزرسانی کنید."
    };
  }

  if (!isPreMatchBetAllowed(match)) {
    return {
      ok: false,
      message: `پیش‌بینی فقط قبل از شروع بازی امکان‌پذیر است (ساعت شروع: ${match.kickoffTime || "--:--"}).`
    };
  }

  const markets = buildMarkets(match);
  const pickedMarket = markets[marketKey] || markets.home;
  const odd = Number(pickedMarket.odd || 2.0);
  const potentialPayout = Math.round(cleanStake * odd);

  return {
    ok: true,
    match,
    market: pickedMarket,
    stake: cleanStake,
    odd,
    potentialPayout
  };
}

function evaluateMarketOutcome(marketKey, homeScore, awayScore) {
  const hs = Number(homeScore || 0);
  const as = Number(awayScore || 0);
  switch (marketKey) {
    case "home":
      return hs > as;
    case "draw":
      return hs === as;
    case "away":
      return as > hs;
    case "dc_1x":
      return hs >= as;
    case "dc_12":
      return hs !== as;
    case "dc_x2":
      return as >= hs;
    case "over_25":
      return hs + as > 2.5;
    case "under_25":
      return hs + as < 2.5;
    case "btts_yes":
      return hs > 0 && as > 0;
    default:
      return false;
  }
}

function settleFootballBets(bets = [], matches = []) {
  const matchMap = new Map((Array.isArray(matches) ? matches : []).map((m) => [String(m.id), m]));
  const payoutsToApply = [];

  for (const bet of bets) {
    if (!bet || bet.settled) continue;
    const match = matchMap.get(String(bet.matchId));
    if (!match) continue;

    const st = String(match.status || "").toUpperCase();
    if (st === "FT" || st === "AET" || st === "PEN") {
      const won = evaluateMarketOutcome(bet.market, match.hScore, match.aScore);
      const payout = won ? Math.round(Number(bet.stake || 0) * Number(bet.odd || 1)) : 0;
      bet.settled = true;
      bet.status = won ? `برد (${payout.toLocaleString("fa-IR")} تومان)` : "باخت";
      if (won && payout > 0) {
        payoutsToApply.push({
          betId: bet.id,
          mode: bet.mode === "real" ? "real" : "demo",
          payout,
          matchLabel: bet.match_label || `${match.home} - ${match.away}`
        });
      }
    }
  }

  return payoutsToApply;
}

module.exports = {
  API_FOOTBALL_HOST,
  DEFAULT_FOOTBALL_API_KEY,
  getTodayDateIsoTehran,
  formatKickoffTehran,
  isPreMatchBetAllowed,
  buildMarkets,
  mapFixtureItem,
  getMatchesByDate,
  validateAndPricePreMatchBet,
  evaluateMarketOutcome,
  settleFootballBets
};

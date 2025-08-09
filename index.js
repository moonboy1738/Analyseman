// index.js — Analyesman (Heroku safe, auto-history + LB from trade-log, fast replies)

import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
} from "discord.js";
import pkg from "pg";
import cron from "node-cron";
const { Pool } = pkg;

// ------------ ENV ------------
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DATABASE_URL = process.env.DATABASE_URL;
const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID;
const TRADE_LOG_CHANNEL_ID = process.env.TRADE_LOG_CHANNEL_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const TZ = process.env.TZ || "Europe/Amsterdam";

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !DATABASE_URL) {
  console.error("❌ Missing TOKEN, CLIENT_ID, GUILD_ID or DATABASE_URL env.");
  process.exit(1);
}

// ------------ CONSTANTS ------------
const EXCLUDE_USERNAMES = [
  "jordanbelfort22",
  "jordan belfort",
  "jordan_belfort",
  "jordanbelfort",
];

// ------------ DB (storage voor archief; LB leest uit trade-log) ------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id                   BIGSERIAL PRIMARY KEY,
      user_id              TEXT NOT NULL,
      username             TEXT NOT NULL,
      symbol               TEXT NOT NULL,
      side                 TEXT NOT NULL,
      leverage_x           INTEGER NOT NULL,
      entry_raw            TEXT NOT NULL,
      exit_raw             TEXT,
      entry_num            NUMERIC,
      exit_num             NUMERIC,
      pnl_percent          NUMERIC NOT NULL DEFAULT 0,
      input_message_id     TEXT,
      trade_log_message_id TEXT,
      channel_id           TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE trades
      ADD COLUMN IF NOT EXISTS user_id TEXT,
      ADD COLUMN IF NOT EXISTS username TEXT,
      ADD COLUMN IF NOT EXISTS symbol TEXT,
      ADD COLUMN IF NOT EXISTS side TEXT,
      ADD COLUMN IF NOT EXISTS leverage_x INTEGER,
      ADD COLUMN IF NOT EXISTS entry_raw TEXT,
      ADD COLUMN IF NOT EXISTS exit_raw TEXT,
      ADD COLUMN IF NOT EXISTS entry_num NUMERIC,
      ADD COLUMN IF NOT EXISTS exit_num NUMERIC,
      ADD COLUMN IF NOT EXISTS pnl_percent NUMERIC NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS input_message_id TEXT,
      ADD COLUMN IF NOT EXISTS trade_log_message_id TEXT,
      ADD COLUMN IF NOT EXISTS channel_id TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  const relaxLegacy = async (col) => {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='trades' AND column_name=$1`,
      [col]
    );
    if (r.rowCount) await pool.query(`ALTER TABLE trades ALTER COLUMN ${col} DROP NOT NULL`);
  };
  await relaxLegacy("entry");
  await relaxLegacy("exit");

  const makeIndex = async (idx, sql) => {
    const { rows } = await pool.query(`SELECT to_regclass($1) AS e`, [idx]);
    if (!rows[0].e) await pool.query(sql);
  };
  await makeIndex("idx_trades_created_at", `CREATE INDEX idx_trades_created_at ON trades (created_at DESC);`);
  await makeIndex("idx_trades_user_pnl", `CREATE INDEX idx_trades_user_pnl ON trades (username, pnl_percent DESC);`);
  await makeIndex("idx_trades_pnl", `CREATE INDEX idx_trades_pnl ON trades (pnl_percent DESC);`);
}

// ------------ DISCORD ------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ====== HELPERS (input/trade-log blijven EXACT) ======
const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`);
const tradeLink = (gid, cid, mid) => `[(Trade)](https://discord.com/channels/${gid}/${cid}/${mid})`;
const pnlBadge = (pnl) => {
  const v = Number(pnl);
  const s = isFinite(v) ? (v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`) : "NaN%";
  return `\`${s}\``;
};
function formatValueWithInputPrecision(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s.includes(".")) {
    const [a, b] = s.split(".");
    if (b.length > 6) s = `${a}.${b.slice(0, 6)}`;
  }
  return `$${s}`;
}

// Parse regex (accepteert ASCII 'x' en '×', en unicode minus U+2212)
const HEADER_REGEX = /^\*\*(.+?)\*\*\s+`([+\-\u2212]?\d+(?:\.\d+)?%)`/m;
const BODY_REGEX   = /([A-Z0-9._/-]+)\s+(Long|Short)\s+(\d{1,4})(?:x|×)\s*/m;
const ENTRY_RE     = /Entry:\s+\$([0-9]*\.?[0-9]+)/i;
const EXIT_RE      = /Exit:\s+\$([0-9]*\.?[0-9]+)/i;

const TRADE_REGEX =
  /^!trade\s+add\s+([A-Za-z0-9._/-]+)\s+(long|short)\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)?\s+([0-9]{1,4})\s*$/i;

const formatInputLine = (symbol, side, leverage, pnl) =>
  `Trade geregistreerd: **${symbol.toUpperCase()}** ${side} ${leverage}× → ${pnlBadge(pnl)}`;

const formatTradeLog = (usernameLower, symbol, side, leverage, entryRaw, exitRaw, pnl) => {
  const head = `**${usernameLower}**  ${pnlBadge(pnl)}`;
  const body = [
    `${symbol.toUpperCase()} ${side} ${leverage}×`,
    `Entry: ${formatValueWithInputPrecision(entryRaw)}`
  ];
  if (exitRaw) body.push(`Exit:  ${formatValueWithInputPrecision(exitRaw)}`);
  return `${head}\n${body.join("\n")}`;
};

// ------------- COMMANDS (leaderboards) -------------
const cmds = [
  new SlashCommandBuilder().setName("lb_alltime").setDescription("Post All-Time Top 25 wins + worst 25 + totals (nu)"),
  new SlashCommandBuilder().setName("lb_daily").setDescription("Post Top 10 van de week (nu)"),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: cmds });
  console.log("✅ slash-commands geregistreerd.");
}

// --------- DB insert (storage only) ---------
async function insertTrade(row) {
  const {
    user_id, username, symbol, side, leverage_x,
    entry_raw, exit_raw, entry_num, exit_num,
    pnl_percent, input_message_id, channel_id, trade_log_message_id
  } = row;

  const { rows } = await pool.query(
    `INSERT INTO trades
     (user_id, username, symbol, side, leverage_x,
      entry_raw, exit_raw, entry_num, exit_num, pnl_percent,
      input_message_id, channel_id, trade_log_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, created_at`,
    [
      user_id, username, symbol, side, leverage_x,
      entry_raw, exit_raw ?? null, entry_num ?? null, exit_num ?? null, pnl_percent,
      input_message_id, channel_id, trade_log_message_id ?? null
    ]
  );
  return rows[0];
}

// ----------------- LEADERBOARD DATA FROM #trade-log -----------------
const safeNum = (x) => (Number.isFinite(x) ? x : 0);
const parsePnlNumber = (pill) => parseFloat(pill.replace("%","").replace("\u2212","-"));

function parseTradeFromMessage(m) {
  const content = m.content ?? "";
  const h = content.match(HEADER_REGEX);
  const b = content.match(BODY_REGEX);
  if (!h || !b) return null;

  const username = h[1].trim();
  const pill = h[2];
  const symbol = b[1].toUpperCase();
  const side = b[2];
  const lev = parseInt(b[3], 10);

  const e = content.match(ENTRY_RE);
  const x = content.match(EXIT_RE);
  const entry = e ? Number(e[1]) : null;
  const exit  = x ? Number(x[1]) : null;

  let pnl = parsePnlNumber(pill);
  if (entry != null && exit != null && entry > 0) {
    const dir = side === "Long" ? 1 : -1;
    pnl = ((exit - entry) / entry) * 100 * dir * Math.max(1, lev);
  }

  return {
    username,
    symbol,
    side,
    leverage_x: lev,
    pnl_percent: safeNum(pnl),
  // link + tijd:
    trade_log_message_id: m.id,
    created_at: m.createdAt
  };
}

// Efficiënt scannen met korte tijdslimiet + harde limiet
async function scanTradesFromLog({ days = null, max = 4000, timeLimitMs = 12000 } = {}) {
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  const out = [];
  let lastId = null;
  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
  const start = Date.now();

  while (out.length < max && (Date.now() - start) < timeLimitMs) {
    const batch = await ch.messages.fetch({ limit: 100, before: lastId ?? undefined });
    if (!batch || batch.size === 0) break;

    const msgs = Array.from(batch.values());
    for (const m of msgs) {
      if (!m.author.bot) continue;
      if (cutoff && m.createdTimestamp < cutoff) return out;

      const t = parseTradeFromMessage(m);
      if (!t) continue;
      if (EXCLUDE_USERNAMES.includes(t.username.toLowerCase())) continue;

      out.push(t);
      if (out.length >= max) break;
    }
    lastId = msgs[msgs.length - 1].id;
    // mini-throttle
    await new Promise(r => setTimeout(r, 120));
  }
  return out;
}

async function getAllTimeFromLog(limitBest = 25, limitWorst = 25) {
  // scan met ruime tijdslimiet maar niet oneindig
  const trades = await scanTradesFromLog({ days: null, max: 4000, timeLimitMs: 15000 });

  const best = [...trades].sort((a,b) => b.pnl_percent - a.pnl_percent).slice(0, limitBest);
  const worst = [...trades].sort((a,b) => a.pnl_percent - b.pnl_percent).slice(0, limitWorst);

  const byUser = new Map();
  for (const t of trades) {
    const key = t.username.toLowerCase();
    const cur = byUser.get(key) || { username: t.username, best: -Infinity, worst: Infinity };
    if (t.pnl_percent > cur.best) cur.best = t.pnl_percent;
    if (t.pnl_percent < cur.worst) cur.worst = t.pnl_percent;
    byUser.set(key, cur);
  }
  const totals = Array.from(byUser.values())
    .map(v => ({ username: v.username, total: safeNum(v.best) + safeNum(v.worst) }))
    .sort((a,b) => b.total - a.total)
    .slice(0, 25);

  return { best, worst, totals };
}

async function getWeeklyTopFromLog(limit = 10) {
  const trades = await scanTradesFromLog({ days: 7, max: 4000, timeLimitMs: 15000 });
  return trades.sort((a,b) => b.pnl_percent - a.pnl_percent).slice(0, limit);
}

// ----------------- RENDER (Trade link + veilige lengtes) -----------------
const EMBED_MAX = 4096;
const LINE_MAX = 180;

const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function renderBestWorstLines(rows) {
  if (!rows || rows.length === 0) return ["Geen resultaten."];
  const lines = rows.map((r, idx) => {
    const tag = medal(idx);
    const user = `**${r.username}**`;
    const item = `${r.symbol.toUpperCase()} ${r.side}`;
    const lev = `${r.leverage_x}x`;
    const pnl = pnlBadge(r.pnl_percent);
    const link = r.trade_log_message_id
      ? `  ${tradeLink(GUILD_ID, TRADE_LOG_CHANNEL_ID, r.trade_log_message_id)}`
      : "";
    return trim(`${tag}  ${user}  ${item}  ${lev}  ${pnl}${link}`, LINE_MAX);
  });

  const out = [];
  let total = 0;
  for (const l of lines) {
    if (total + l.length + 1 > EMBED_MAX) break;
    out.push(l);
    total += l.length + 1;
  }
  return out.length ? out : ["Geen resultaten."];
}

function renderTotalsLines(rows) {
  if (!rows || rows.length === 0) return ["Geen resultaten."];
  const lines = rows.map((r, idx) => {
    const tag = medal(idx);
    const user = `**${r.username}**`;
    const s = Number(r.total);
    const label = isFinite(s) ? (s >= 0 ? `+${s.toFixed(2)}%` : `${s.toFixed(2)}%`) : "NaN%";
    return trim(`${tag}  ${user}  \`${label}\``, LINE_MAX);
  });

  const out = [];
  let total = 0;
  for (const l of lines) {
    if (total + l.length + 1 > EMBED_MAX) break;
    out.push(l);
    total += l.length + 1;
  }
  return out.length ? out : ["Geen resultaten."];
}

// ------------- RUNTIME -------------
client.on("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  // bootstrap pas na 15s zodat slash-commands meteen kunnen reageren
  setTimeout(() => {
    bootstrapHistory().catch((e) => console.error("bootstrapHistory error:", e));
  }, 15000);
});

// ====== /input & /trade-log handling — NIET AANRAKEN ======
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channelId !== INPUT_CHANNEL_ID) return;

    const m = msg.content.trim().match(TRADE_REGEX);
    if (!m) return;

    const symbol = m[1];
    const side = m[2].toLowerCase() === "long" ? "Long" : "Short";
    const entryRaw = m[3];
    const exitRaw = m[4] || null;
    const lev = parseInt(m[5], 10);

    let pnl = 0;
    if (exitRaw) {
      const entry = Number(entryRaw);
      const exit = Number(exitRaw);
      const dir = side === "Long" ? 1 : -1;
      pnl = ((exit - entry) / entry) * 100 * dir * Math.max(1, lev);
    }

    await msg.channel.send(formatInputLine(symbol, side, lev, pnl));

    const tradeLog = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
    const usernameLower = (msg.member?.displayName || msg.author.username).trim().toLowerCase();
    const content = formatTradeLog(usernameLower, symbol, side, lev, entryRaw, exitRaw, pnl);
    const tlMsg = await tradeLog.send(content);

    await insertTrade({
      user_id: msg.author.id,
      username: (msg.member?.displayName || msg.author.username).trim(),
      symbol: symbol.trim(),
      side,
      leverage_x: lev,
      entry_raw: entryRaw,
      exit_raw: exitRaw,
      entry_num: isNaN(Number(entryRaw)) ? null : Number(entryRaw),
      exit_num: exitRaw && !isNaN(Number(exitRaw)) ? Number(exitRaw) : null,
      pnl_percent: Number(pnl.toFixed(6)),
      input_message_id: msg.id,
      trade_log_message_id: tlMsg.id,
      channel_id: msg.channelId,
    });
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

// ---- Slash commands (altijd direct defer + duidelijke fouten) ----
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    // ALTIJD binnen 3s deferen
    await i.deferReply({ ephemeral: false });
  } catch (e) {
    console.error("deferReply failed:", e);
    try { await i.reply({ content: "Kon niet starten (defer failed).", ephemeral: true }); } catch {}
    return;
  }

  try {
    if (i.commandName === "lb_alltime") {
      // status update (handig bij grote kanalen)
      try { await i.editReply("Bezig met verzamelen…"); } catch {}

      const { best, worst, totals } = await getAllTimeFromLog(25, 25);

      const eb1 = new EmbedBuilder()
        .setColor(0x111827)
        .setTitle("🏆 Top 25 All-time Winsten")
        .setDescription(renderBestWorstLines(best).join("\n"));

      const eb2 = new EmbedBuilder()
        .setColor(0x111827)
        .setTitle("📉 Top 25 All-time Verliezen")
        .setDescription(renderBestWorstLines(worst).join("\n"));

      const eb3 = new EmbedBuilder()
        .setColor(0x111827)
        .setTitle("📊 Totale PnL % (best + worst)")
        .setDescription(renderTotalsLines(totals).join("\n"));

      await i.editReply({ content: "", embeds: [eb1, eb2, eb3] });
      return;
    }

    if (i.commandName === "lb_daily") {
      try { await i.editReply("Bezig met verzamelen…"); } catch {}

      const weekly = await getWeeklyTopFromLog(10);

      const eb = new EmbedBuilder()
        .setColor(0x111827)
        .setTitle("📈 Top 10 Weekly Trades (laatste 7 dagen)")
        .setDescription(renderBestWorstLines(weekly).join("\n"));

      await i.editReply({ content: "", embeds: [eb] });
      return;
    }

    // fallback
    await i.editReply("Onbekende command.");
  } catch (err) {
    console.error("interaction error:", err);
    try { await i.editReply("Er ging iets mis tijdens het opbouwen van de lijst."); } catch {}
  }
});

// ------------- AUTO HISTORY BOOTSTRAP (storage only) -------------
async function bootstrapHistory() {
  const limit = 5000;
  const channel = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  let lastId = null;
  let seen = 0;

  console.log("🧹 History bootstrap gestart…");
  while (seen < limit) {
    const batch = await channel.messages.fetch({ limit: 100, before: lastId ?? undefined });
    if (!batch || batch.size === 0) break;

    const msgs = Array.from(batch.values());
    for (const m of msgs) {
      if (seen >= limit) break;
      seen++;
      try {
        if (!m.author.bot) continue;

        const t = parseTradeFromMessage(m);
        if (!t) continue;

        const exist = await pool.query(`SELECT 1 FROM trades WHERE trade_log_message_id=$1`, [m.id]);
        if (exist.rowCount > 0) continue;

        await insertTrade({
          user_id: `name:${t.username.toLowerCase()}`,
          username: t.username,
          symbol: t.symbol,
          side: t.side,
          leverage_x: t.leverage_x,
          entry_raw: "0",
          exit_raw: null,
          entry_num: null,
          exit_num: null,
          pnl_percent: Number(t.pnl_percent.toFixed(6)),
          input_message_id: m.id,
          trade_log_message_id: m.id,
          channel_id: TRADE_LOG_CHANNEL_ID,
        });
      } catch (e) {
        console.error(`bootstrap error on message ${m?.id}:`, e);
      }
    }

    lastId = msgs[msgs.length - 1].id;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log("✅ History bootstrap klaar.");
}

// ------------- CRON (leest uit trade-log) -------------
async function postAllTimeNow() {
  try {
    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    const { best, worst, totals } = await getAllTimeFromLog(25, 25);

    const eb1 = new EmbedBuilder().setColor(0x111827).setTitle("🏆 Top 25 All-time Winsten").setDescription(renderBestWorstLines(best).join("\n"));
    const eb2 = new EmbedBuilder().setColor(0x111827).setTitle("📉 Top 25 All-time Verliezen").setDescription(renderBestWorstLines(worst).join("\n"));
    const eb3 = new EmbedBuilder().setColor(0x111827).setTitle("📊 Totale PnL % (best + worst)").setDescription(renderTotalsLines(totals).join("\n"));

    await ch.send({ embeds: [eb1, eb2, eb3] });
  } catch (e) {
    console.error("auto alltime error:", e);
  }
}

async function postWeeklyNow() {
  try {
    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    const weekly = await getWeeklyTopFromLog(10);
    const eb = new EmbedBuilder().setColor(0x111827).setTitle("📈 Top 10 Weekly Trades (laatste 7 dagen)").setDescription(renderBestWorstLines(weekly).join("\n"));
    await ch.send({ embeds: [eb] });
  } catch (e) {
    console.error("auto weekly error:", e);
  }
}

function setupCrons() {
  cron.schedule("0 20 * * 0", postAllTimeNow, { timezone: TZ }); // zondag 20:00
  cron.schedule("0 9 * * *", postWeeklyNow, { timezone: TZ });   // dagelijks 09:00
}

// ------------ STARTUP ------------
(async () => {
  try {
    await ensureDb();
    await registerCommands();
    await client.login(TOKEN);
    setupCrons();
    console.log("🚀 Bot running with TZ:", TZ);
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
})();

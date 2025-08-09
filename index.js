// index.js  —  Analyesman (Heroku safe build)
// Node 18+  |  discord.js v14  |  pg 8

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
const { Pool } = pkg;

// ------------ ENV ------------
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;         // application id
const GUILD_ID = process.env.GUILD_ID;           // server id
const DATABASE_URL = process.env.DATABASE_URL;
const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID;
const TRADE_LOG_CHANNEL_ID = process.env.TRADE_LOG_CHANNEL_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const TZ = process.env.TZ || "Europe/Amsterdam";

// basic guard
if (!TOKEN || !CLIENT_ID || !GUILD_ID || !DATABASE_URL) {
  console.error("❌ Missing TOKEN, CLIENT_ID, GUILD_ID or DATABASE_URL env.");
  process.exit(1);
}

// ------------ DB ------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// tabel + veilige indexen
async function ensureDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id                  BIGSERIAL PRIMARY KEY,
      user_id             TEXT NOT NULL,
      username            TEXT NOT NULL,
      symbol              TEXT NOT NULL,
      side                TEXT NOT NULL,
      leverage_x          INTEGER NOT NULL,
      entry_raw           TEXT NOT NULL,           -- ruwe input (niet afronden)
      exit_raw            TEXT,                    -- ruwe input
      entry_num           NUMERIC,                 -- optioneel numeriek
      exit_num            NUMERIC,                 -- optioneel numeriek
      pnl_percent         NUMERIC NOT NULL,
      input_message_id    TEXT NOT NULL,
      trade_log_message_id TEXT,                   -- bericht in #trade-log
      channel_id          TEXT NOT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // helper: bestaat kolom?
  const colExists = async (table, col) => {
    const { rows } = await pool.query(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_name=$1 AND column_name=$2`,
      [table, col]
    );
    return rows.length > 0;
  };

  // veilige index: maak alleen als er kolommen zijn en index nog niet bestaat
  const makeIndex = async (idxName, sql) => {
    const { rows } = await pool.query(
      `SELECT to_regclass($1) AS exists`,
      [idxName]
    );
    if (!rows[0].exists) {
      await pool.query(sql);
    }
  };

  // alle indexen eerst checken
  if (await colExists("trades", "created_at")) {
    await makeIndex(
      "idx_trades_created_at",
      `CREATE INDEX idx_trades_created_at ON trades (created_at DESC);`
    );
  }
  if (await colExists("trades", "username") && await colExists("trades","pnl_percent")) {
    await makeIndex(
      "idx_trades_user_pnl",
      `CREATE INDEX idx_trades_user_pnl ON trades (username, pnl_percent DESC);`
    );
  }
  if (await colExists("trades", "pnl_percent")) {
    await makeIndex(
      "idx_trades_pnl",
      `CREATE INDEX idx_trades_pnl ON trades (pnl_percent DESC);`
    );
  }
}

// ------------ DISCORD ------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // nodig voor text input parser
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ⏱ helpers
const now = () => new Date();

// medal
const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`);

// dunne monospace kolommen
const pad = (s, n) => (s + " ".repeat(n)).substring(0, n);

// maak kleine “Trade” link
const tradeLink = (guildId, channelId, messageId) =>
  `[(Trade)](https://discord.com/channels/${guildId}/${channelId}/${messageId})`;

// get PnL kleur
const pnlBadge = (pnl) => {
  const v = Number(pnl);
  const s = v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`;
  return `\`${s}\``;
};

// parse functie (exact jouw format): 
// "!trade add <SYMBOL> <Long|Short> <entry> <exit?> <leverageX>"
const TRADE_REGEX =
  /^!trade\s+add\s+([A-Za-z0-9._/-]+)\s+(long|short)\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)?\s+([0-9]{1,4})\s*$/i;

// schrijf naar #input reply (exact zoals je liet zien; coin **dik**)
const formatInputReply = (symbol, side, leverage, pnl) =>
  `Trade geregistreerd: **${symbol.toUpperCase()}** ${side} ${leverage}x ~ ${pnlBadge(pnl)}`;

// schrijf naar #trade-log (naam **dik** naast percentage, zonder extra regel)
const formatTradeLog = (username, symbol, side, leverage, entryRaw, exitRaw) => {
  const head = `**${username}**  ${pnlBadge("{{PNL}}")}`;
  const body = `${symbol.toUpperCase()} ${side} ${leverage}x\nEntry: ${entryRaw}${exitRaw ? `\nExit: ${exitRaw}` : ""}`;
  return { head, body };
};

// ------------- COMMANDS -------------
const cmds = [
  new SlashCommandBuilder()
    .setName("lb_alltime")
    .setDescription("Post All-Time Top 25 wins + worst 25 + totals (nu)"),
  new SlashCommandBuilder()
    .setName("lb_daily")
    .setDescription("Post Top 10 van de week (nu)"),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: cmds,
  });
  console.log("✅ slash-commands geregistreerd.");
}

// --------- QUERIES ---------
async function insertTrade(row) {
  const {
    user_id,
    username,
    symbol,
    side,
    leverage_x,
    entry_raw,
    exit_raw,
    entry_num,
    exit_num,
    pnl_percent,
    input_message_id,
    channel_id,
  } = row;

  const { rows } = await pool.query(
    `INSERT INTO trades
     (user_id, username, symbol, side, leverage_x,
      entry_raw, exit_raw, entry_num, exit_num, pnl_percent,
      input_message_id, channel_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, created_at`,
    [
      user_id,
      username,
      symbol,
      side,
      leverage_x,
      entry_raw,
      exit_raw ?? null,
      entry_num ?? null,
      exit_num ?? null,
      pnl_percent,
      input_message_id,
      channel_id,
    ]
  );
  return rows[0];
}

// leaderboard helpers
const excludeFromTotals = new Set(["jordanbelfort22"]); // case-insensitive check later

async function getAllTime(limit = 25) {
  // beste
  const best = await pool.query(
    `SELECT username, symbol, side, leverage_x, pnl_percent, channel_id, trade_log_message_id
       FROM trades
      ORDER BY pnl_percent DESC
      LIMIT $1`,
    [limit]
  );
  // slechtste
  const worst = await pool.query(
    `SELECT username, symbol, side, leverage_x, pnl_percent, channel_id, trade_log_message_id
       FROM trades
      ORDER BY pnl_percent ASC
      LIMIT $1`,
    [limit]
  );

  // totals: per user (best + worst)
  const totals = await pool.query(
    `WITH a AS (
       SELECT LOWER(username) AS u,
              MAX(pnl_percent) AS best,
              MIN(pnl_percent) AS worst
         FROM trades
        GROUP BY LOWER(username)
     )
     SELECT u AS username, (best + worst) AS total
       FROM a
      WHERE u <> ALL($1)      -- exclude lijst
      ORDER BY total DESC
      LIMIT 25`,
    [Array.from(excludeFromTotals)]
  );

  return { best: best.rows, worst: worst.rows, totals: totals.rows };
}

async function getWeeklyTop(limit = 10) {
  // laatste 7 dagen strikt
  const { rows } = await pool.query(
    `SELECT username, symbol, side, leverage_x, pnl_percent, channel_id, trade_log_message_id
       FROM trades
      WHERE created_at >= (NOW() - INTERVAL '7 days')
      ORDER BY pnl_percent DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

// ------------- RUNTIME -------------
client.on("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// text input parser in #input
client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channelId !== INPUT_CHANNEL_ID) return;

    const m = msg.content.trim().match(TRADE_REGEX);
    if (!m) return;

    const symbol = m[1];
    const side = m[2].toLowerCase() === "long" ? "Long" : "Short";
    const entryRaw = m[3]; // ruwe string (geen afronding)
    const exitRaw = m[4] || null;
    const lev = parseInt(m[5], 10);

    // pnl berekening alleen tonen indien exit aanwezig
    let pnl = 0;
    if (exitRaw) {
      const entry = Number(entryRaw);
      const exit = Number(exitRaw);
      const dir = side === "Long" ? 1 : -1;
      pnl = ((exit - entry) / entry) * 100 * dir * Math.max(1, lev);
    }

    // 1) bevestiging in #input (exact stijl, coin dik)
    await msg.reply(formatInputReply(symbol, side, lev, pnl));

    // 2) post in #trade-log in hun stijl
    const tradeLog = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
    const { head, body } = formatTradeLog(
      msg.member?.displayName || msg.author.username,
      symbol,
      side,
      lev,
      entryRaw,
      exitRaw
    );

    // we vullen het uiteindelijke pnl in (zonder extra regel)
    const content = head.replace("{{PNL}}", pnl.toFixed(2)) + `\n` + body;

    const tlMsg = await tradeLog.send(content);

    // 3) opslaan in DB (met message link data)
    const row = await insertTrade({
      user_id: msg.author.id,
      username: (msg.member?.displayName || msg.author.username).trim(),
      symbol: symbol.trim(),
      side,
      leverage_x: lev,
      entry_raw: entryRaw,
      exit_raw: exitRaw,
      entry_num: isNaN(Number(entryRaw)) ? null : Number(entryRaw),
      exit_num: exitRaw && !isNaN(Number(exitRaw)) ? Number(exitRaw) : null,
      pnl_percent: Number(pnl.toFixed(6)), // precisie opslaan, maar visueel ronden we zelf
      input_message_id: msg.id,
      channel_id: msg.channelId,
    });

    // trade_log_message_id bijwerken (zodat we de link in leaderboards kunnen plaatsen)
    await pool.query(
      `UPDATE trades SET trade_log_message_id=$1 WHERE id=$2`,
      [tlMsg.id, row.id]
    );
  } catch (err) {
    console.error("messageCreate error:", err);
  }
});

// slash commands
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    if (i.commandName === "lb_alltime") {
      await i.deferReply({ ephemeral: false });

      const { best, worst, totals } = await getAllTime(25);

      // BEST
      const bestLines = best.map((r, idx) => {
        const tag = medal(idx);
        const user = `**${r.username}**`;
        const item = `${r.symbol.toUpperCase()} ${r.side}`;
        const lev = `${r.leverage_x}x`;
        const pnl = pnlBadge(r.pnl_percent);
        const link = r.trade_log_message_id
          ? `  ${tradeLink(GUILD_ID, TRADE_LOG_CHANNEL_ID, r.trade_log_message_id)}`
          : "";
        return `${tag}  ${user}  ${item}  ${lev}  ${pnl}${link}`;
      });

      // WORST
      const worstLines = worst.map((r, idx) => {
        const tag = medal(idx);
        const user = `**${r.username}**`;
        const item = `${r.symbol.toUpperCase()} ${r.side}`;
        const lev = `${r.leverage_x}x`;
        const pnl = pnlBadge(r.pnl_percent);
        const link = r.trade_log_message_id
          ? `  ${tradeLink(GUILD_ID, TRADE_LOG_CHANNEL_ID, r.trade_log_message_id)}`
          : "";
        return `${tag}  ${user}  ${item}  ${lev}  ${pnl}${link}`;
      });

      // TOTALS (exclusief JordanBelfort22)
      const totalsLines = totals.map((r, idx) => {
        const tag = medal(idx);
        const user = `**${r.username}**`;
        const s = Number(r.total);
        const label = s >= 0 ? `+${s.toFixed(2)}%` : `${s.toFixed(2)}%`;
        return `${tag}  ${user}  \`${label}\``;
      });

      const eb1 = new EmbedBuilder()
        .setColor(0x111827)
        .setTitle("🏆 Top 25 All-time Winsten")
        .setDescription(bestLines.join("\n"));

      const eb2 = new EmbedBuilder()
        .setColor(0x111827)
        .setTitle("📉 Top 25 All-time Verliezen")
        .setDescription(worstLines.join("\n"));

      const eb3 = new EmbedBuilder()
        .setColor(0x111827)
        .setTitle("📊 Totale PnL % (best + worst)")
        .setDescription(totalsLines.join("\n"));

      await i.editReply({ embeds: [eb1, eb2, eb3] });
    }

    if (i.commandName === "lb_daily") {
      await i.deferReply({ ephemeral: false });

      const weekly = await getWeeklyTop(10);
      const lines = weekly.map((r, idx) => {
        const tag = medal(idx);
        const user = `**${r.username}**`;
        const item = `${r.symbol.toUpperCase()} ${r.side}`;
        const lev = `${r.leverage_x}x`;
        const pnl = pnlBadge(r.pnl_percent);
        const link = r.trade_log_message_id
          ? `  ${tradeLink(GUILD_ID, TRADE_LOG_CHANNEL_ID, r.trade_log_message_id)}`
          : "";
        return `${tag}  ${user}  ${item}  ${lev}  ${pnl}${link}`;
      });

      const eb = new EmbedBuilder()
        .setColor(0x111827)
        .setTitle("📈 Top 10 Weekly Trades (laatste 7 dagen)")
        .setDescription(lines.join("\n"));

      await i.editReply({ embeds: [eb] });
    }
  } catch (err) {
    console.error("interaction error:", err);
    try {
      await i.editReply("Er ging iets mis bij het opbouwen van de lijst.");
    } catch {}
  }
});

// ------------ STARTUP ------------
(async () => {
  try {
    await ensureDb();
    await registerCommands();
    await client.login(TOKEN);
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
})();

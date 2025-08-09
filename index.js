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
  PermissionsBitField,
} from "discord.js";
import pkg from "pg";
import cron from "node-cron";
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

// ------------ CONSTANTS ------------
const EXCLUDE_USERNAMES = [
  "jordanbelfort22",
  "jordan belfort",
  "jordan_belfort",
  "jordanbelfort",
];

// ------------ DB ------------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// tabel + veilige indexen
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
      pnl_percent          NUMERIC NOT NULL,
      input_message_id     TEXT NOT NULL,
      trade_log_message_id TEXT,
      channel_id           TEXT NOT NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const colExists = async (table, col) => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`,
      [table, col]
    );
    return rows.length > 0;
  };

  const makeIndex = async (idxName, sql) => {
    const { rows } = await pool.query(`SELECT to_regclass($1) AS exists`, [idxName]);
    if (!rows[0].exists) await pool.query(sql);
  };

  if (await colExists("trades", "created_at")) {
    await makeIndex("idx_trades_created_at", `CREATE INDEX idx_trades_created_at ON trades (created_at DESC);`);
  }
  if (await colExists("trades", "username") && await colExists("trades","pnl_percent")) {
    await makeIndex("idx_trades_user_pnl", `CREATE INDEX idx_trades_user_pnl ON trades (username, pnl_percent DESC);`);
  }
  if (await colExists("trades", "pnl_percent")) {
    await makeIndex("idx_trades_pnl", `CREATE INDEX idx_trades_pnl ON trades (pnl_percent DESC);`);
  }
}

// ------------ DISCORD ------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, // voor backfill naam->ID lookup
  ],
  partials: [Partials.Channel, Partials.Message],
});

// helpers
const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`);
const tradeLink = (gid, cid, mid) => `[(Trade)](https://discord.com/channels/${gid}/${cid}/${mid})`;
const pnlBadge = (pnl) => {
  const v = Number(pnl);
  const s = v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`;
  return `\`${s}\``;
};

// toon geldwaarde met exact de ingevoerde precisie (max 6)
function formatValueWithInputPrecision(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s.includes(".")) {
    const [a, b] = s.split(".");
    if (b.length > 6) s = `${a}.${b.slice(0, 6)}`;
  }
  return `$${s}`;
}

// parse functie (exact jouw format):
// "!trade add <SYMBOL> <Long|Short> <entry> <exit?> <leverageX>"
const TRADE_REGEX =
  /^!trade\s+add\s+([A-Za-z0-9._/-]+)\s+(long|short)\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)?\s+([0-9]{1,4})\s*$/i;

// input bericht (los, geen reply)
const formatInputLine = (symbol, side, leverage, pnl) =>
  `Trade geregistreerd: **${symbol.toUpperCase()}** ${side} ${leverage}× → ${pnlBadge(pnl)}`;

// trade-log bericht (kop + body exact als screenshot)
const formatTradeLog = (usernameLower, symbol, side, leverage, entryRaw, exitRaw, pnl) => {
  const head = `**${usernameLower}**  ${pnlBadge(pnl)}`;
  const body = [
    `${symbol.toUpperCase()} ${side} ${leverage}×`,
    `Entry: ${formatValueWithInputPrecision(entryRaw)}`
  ];
  if (exitRaw) body.push(`Exit:  ${formatValueWithInputPrecision(exitRaw)}`);
  return `${head}\n${body.join("\n")}`;
};

// ------------- COMMANDS -------------
const cmds = [
  new SlashCommandBuilder().setName("lb_alltime").setDescription("Post All-Time Top 25 wins + worst 25 + totals (nu)"),
  new SlashCommandBuilder().setName("lb_daily").setDescription("Post Top 10 van de week (nu)"),
  new SlashCommandBuilder().setName("backfill").setDescription("Eenmalig backfillen van #trade-log (admin)"),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: cmds });
  console.log("✅ slash-commands geregistreerd.");
}

// --------- QUERIES ---------
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

const excludeClause = `LOWER(username) <> ALL($1)`;

async function getAllTime(limit = 25) {
  const best = await pool.query(
    `SELECT username, symbol, side, leverage_x, pnl_percent, channel_id, trade_log_message_id
       FROM trades
      WHERE ${excludeClause}
      ORDER BY pnl_percent DESC
      LIMIT $2`,
    [EXCLUDE_USERNAMES, limit]
  );

  const worst = await pool.query(
    `SELECT username, symbol, side, leverage_x, pnl_percent, channel_id, trade_log_message_id
       FROM trades
      WHERE ${excludeClause}
      ORDER BY pnl_percent ASC
      LIMIT $2`,
    [EXCLUDE_USERNAMES, limit]
  );

  const totals = await pool.query(
    `WITH a AS (
       SELECT LOWER(username) AS u,
              MAX(pnl_percent) AS best,
              MIN(pnl_percent) AS worst
         FROM trades
        WHERE ${excludeClause}
        GROUP BY LOWER(username)
     )
     SELECT u AS username, (best + worst) AS total
       FROM a
      ORDER BY total DESC
      LIMIT 25`,
    [EXCLUDE_USERNAMES]
  );

  return { best: best.rows, worst: worst.rows, totals: totals.rows };
}

async function getWeeklyTop(limit = 10) {
  const { rows } = await pool.query(
    `SELECT username, symbol, side, leverage_x, pnl_percent, channel_id, trade_log_message_id
       FROM trades
      WHERE created_at >= (NOW() - INTERVAL '7 days')
        AND ${excludeClause}
      ORDER BY pnl_percent DESC
      LIMIT $2`,
    [EXCLUDE_USERNAMES, limit]
  );
  return rows;
}

// render helpers
function renderBestWorstLines(rows) {
  return rows.map((r, idx) => {
    const tag = medal(idx);
    const user = `**${r.username}**`;
    const item = `${r.symbol.toUpperCase()} ${r.side}`;
    const lev = `${r.leverage_x}×`;
    const pnl = pnlBadge(r.pnl_percent);
    const link = r.trade_log_message_id
      ? `  ${tradeLink(GUILD_ID, TRADE_LOG_CHANNEL_ID, r.trade_log_message_id)}`
      : "";
    return `${tag}  ${user}  ${item}  ${lev}  ${pnl}${link}`;
  });
}

function renderTotalsLines(rows) {
  return rows.map((r, idx) => {
    const tag = medal(idx);
    const user = `**${r.username}**`;
    const s = Number(r.total);
    const label = s >= 0 ? `+${s.toFixed(2)}%` : `${s.toFixed(2)}%`;
    return `${tag}  ${user}  \`${label}\``;
  });
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

    // 1) los bericht in #input (géén reply)
    await msg.channel.send(formatInputLine(symbol, side, lev, pnl));

    // 2) post in #trade-log exact jouw stijl
    const tradeLog = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
    const usernameLower = (msg.member?.displayName || msg.author.username).trim().toLowerCase();

    const content = formatTradeLog(usernameLower, symbol, side, lev, entryRaw, exitRaw, pnl);
    const tlMsg = await tradeLog.send(content);

    // 3) opslaan in DB
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

// slash commands
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    if (i.commandName === "lb_alltime") {
      await i.deferReply({ ephemeral: false });

      const { best, worst, totals } = await getAllTime(25);

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

      await i.editReply({ embeds: [eb1, eb2, eb3] });
    }

    if (i.commandName === "lb_daily") {
      await i.deferReply({ ephemeral: false });

      const weekly = await getWeeklyTop(10);
      const lines = renderBestWorstLines(weekly);

      const eb = new EmbedBuilder()
        .setColor(0x111827)
        .setTitle("📈 Top 10 Weekly Trades (laatste 7 dagen)")
        .setDescription(lines.join("\n"));

      await i.editReply({ embeds: [eb] });
    }

    if (i.commandName === "backfill") {
      // alleen voor mensen met Manage Server
      const member = await i.guild.members.fetch(i.user.id);
      if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        await i.reply({ content: "Je hebt geen toestemming voor /backfill.", ephemeral: true });
        return;
      }
      await i.reply({ content: "Backfill gestart. Dit kan even duren…", ephemeral: true });
      try {
        const { processed, skipped, errors } = await runBackfillVerbose();
        let msg = `Backfill klaar. Verwerkt: ${processed}, overgeslagen: ${skipped}.`;
        if (errors.length) {
          msg += `\nFouten (${errors.length}):\n` + errors.slice(0,5).map(e => `• ${e}`).join("\n");
          if (errors.length > 5) msg += `\n(+${errors.length - 5} extra)`;
        }
        await i.followUp({ content: msg, ephemeral: true });
      } catch (e) {
        console.error("BACKFILL FATAL:", e);
        await i.followUp({ content: `Backfill faalde: ${e?.message || e}`, ephemeral: true });
      }
    }
  } catch (err) {
    console.error("interaction error:", err);
    try { await i.editReply("Er ging iets mis."); } catch {}
  }
});

// ------------- BACKFILL (robuust + logging) -------------
const HEADER_REGEX = /^\*\*(.+?)\*\*\s+`([+\-]?\d+(?:\.\d{1,2})?%)`/m;
const BODY_REGEX = /([A-Z0-9._/-]+)\s+(Long|Short)\s+(\d{1,4})×\s*[\r\n]+Entry:\s+\$([0-9]*\.?[0-9]+)(?:[\r\n]+Exit:\s+\$([0-9]*\.?[0-9]+))?/m;

async function runBackfillVerbose() {
  const channel = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  let lastId = null;
  let processed = 0;
  let skipped = 0;
  const errors = [];

  while (true) {
    let batch;
    try {
      batch = await channel.messages.fetch({ limit: 100, before: lastId ?? undefined });
    } catch (e) {
      errors.push(`messages.fetch failed: ${e?.message || e}`);
      break;
    }
    if (batch.size === 0) break;

    const msgs = Array.from(batch.values());
    for (const m of msgs) {
      try {
        if (!m.author.bot) { skipped++; continue; }
        const content = m.content ?? "";
        const h = content.match(HEADER_REGEX);
        const b = content.match(BODY_REGEX);
        if (!h || !b) { skipped++; continue; }

        const usernameText = h[1].trim();
        if (EXCLUDE_USERNAMES.includes(usernameText.toLowerCase())) { skipped++; continue; }

        const exist = await pool.query(`SELECT 1 FROM trades WHERE trade_log_message_id=$1`, [m.id]);
        if (exist.rowCount > 0) { skipped++; continue; }

        const pnlText = h[2].replace("%","");
        const symbol = b[1].toUpperCase();
        const side = b[2];
        const lev = parseInt(b[3],10);
        const entryRaw = b[4];
        const exitRaw = b[5] || null;

        // Probeer member-ID te vinden (fallback op name:<lowercase>)
        let userId = `name:${usernameText.toLowerCase()}`;
        try {
          const members = await m.guild.members.fetch({ query: usernameText, limit: 1 });
          const cand = members.find(mm =>
            mm.displayName.toLowerCase() === usernameText.toLowerCase() ||
            mm.user.username.toLowerCase() === usernameText.toLowerCase()
          );
          if (cand) userId = cand.id;
        } catch {}

        // PnL
        let pnl = 0;
        if (exitRaw) {
          const entry = Number(entryRaw);
          const exit = Number(exitRaw);
          const dir = side === "Long" ? 1 : -1;
          pnl = ((exit - entry) / entry) * 100 * dir * Math.max(1, lev);
        } else {
          pnl = Number(pnlText);
        }

        await insertTrade({
          user_id: userId,
          username: usernameText,
          symbol,
          side,
          leverage_x: lev,
          entry_raw: entryRaw,
          exit_raw: exitRaw,
          entry_num: isNaN(Number(entryRaw)) ? null : Number(entryRaw),
          exit_num: exitRaw && !isNaN(Number(exitRaw)) ? Number(exitRaw) : null,
          pnl_percent: Number(pnl.toFixed(6)),
          input_message_id: m.id,          // geen input-id bekend; gebruik message id
          trade_log_message_id: m.id,
          channel_id: TRADE_LOG_CHANNEL_ID,
        });

        processed++;
      } catch (e) {
        console.error(`Backfill error on message ${m.id}:`, e);
        errors.push(`msg ${m.id}: ${e?.message || e}`);
      }
    }

    lastId = msgs[msgs.length - 1].id;
    await new Promise(r => setTimeout(r, 500)); // throttle tegen ratelimits
  }

  return { processed, skipped, errors };
}

// ------------- CRON (auto posts) -------------
async function postAllTimeNow() {
  try {
    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    const { best, worst, totals } = await getAllTime(25);

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

    await ch.send({ embeds: [eb1, eb2, eb3] });
  } catch (e) {
    console.error("auto alltime error:", e);
  }
}

async function postWeeklyNow() {
  try {
    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    const weekly = await getWeeklyTop(10);
    const eb = new EmbedBuilder()
      .setColor(0x111827)
      .setTitle("📈 Top 10 Weekly Trades (laatste 7 dagen)")
      .setDescription(renderBestWorstLines(weekly).join("\n"));
    await ch.send({ embeds: [eb] });
  } catch (e) {
    console.error("auto weekly error:", e);
  }
}

// plan: zondag 20:00 en dagelijks 09:00 (Europe/Amsterdam)
function setupCrons() {
  cron.schedule("0 20 * * 0", postAllTimeNow, { timezone: TZ }); // Sun 20:00
  cron.schedule("0 9 * * *", postWeeklyNow, { timezone: TZ });   // Daily 09:00
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

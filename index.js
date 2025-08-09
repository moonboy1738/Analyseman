// index.js
// Analysesman – Discord trade logger + leaderboards
// Node 18+, discord.js v14, pg, node-cron

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import pkg from 'pg';
import cron from 'node-cron';

const {
  TOKEN,
  CLIENT_ID,
  GUILD_ID,
  INPUT_CHANNEL_ID,
  TRADE_LOG_CHANNEL_ID,
  LEADERBOARD_CHANNEL_ID,
  DATABASE_URL,
  TZ = 'Europe/Amsterdam',
} = process.env;

if (
  !TOKEN ||
  !CLIENT_ID ||
  !GUILD_ID ||
  !INPUT_CHANNEL_ID ||
  !TRADE_LOG_CHANNEL_ID ||
  !LEADERBOARD_CHANNEL_ID ||
  !DATABASE_URL
) {
  console.error(
    '❌ Missing required ENV vars. Needed: TOKEN, CLIENT_ID, GUILD_ID, INPUT_CHANNEL_ID, TRADE_LOG_CHANNEL_ID, LEADERBOARD_CHANNEL_ID, DATABASE_URL.'
  );
  process.exit(1);
}

const { Pool } = pkg;
const pool = new Pool({ connectionString: DATABASE_URL });

// ————————————————————————————————————
// DB setup
// ————————————————————————————————————
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,                 -- 'Long' | 'Short'
      entry_raw TEXT NOT NULL,            -- ongewijzigde input
      exit_raw  TEXT NOT NULL,            -- ongewijzigde input
      entry_num DOUBLE PRECISION NOT NULL,
      exit_num  DOUBLE PRECISION NOT NULL,
      leverage INTEGER NOT NULL,
      pnl_pct DOUBLE PRECISION NOT NULL,
      trade_log_message_id TEXT,          -- voor deep link
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS trades_guild_created_idx ON trades(guild_id, created_at DESC);
  `);
}

// ————————————————————————————————————
// Helpers
// ————————————————————————————————————
const EXCLUDED_USERS = ['jordanbelfort', 'jordanbelfort22', 'jordanbelfort_22'];

function isExcludedUser(name) {
  const n = (name || '').toString().toLowerCase();
  return EXCLUDED_USERS.some((x) => n.includes(x));
}

function parseSide(val) {
  const s = (val || '').toLowerCase();
  if (s.startsWith('l')) return 'Long';
  if (s.startsWith('s')) return 'Short';
  return null;
}

function toNumberStrict(str) {
  // Accepteer komma of punt als decimaal, strip spaties
  const n = parseFloat(String(str).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

function fmtPct(p) {
  // badge-tekst, 2 decimalen, min-teken netjes
  const sign = p >= 0 ? '+' : '−';
  const v = Math.abs(p).toFixed(2);
  return `${sign}${v}%`;
}

function bold(txt) {
  return `**${txt}**`;
}

function linkToTrade(guildId, channelId, messageId, label = 'Trade') {
  if (!messageId) return '';
  const url = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
  return ` — [${label}](${url})`;
}

function medalFor(rank) {
  if (rank === 1) return '🥇 ';
  if (rank === 2) return '🥈 ';
  if (rank === 3) return '🥉 ';
  return '';
}

function trimTrailingZeros(str) {
  // Toon input zoals ingevoerd; als we ooit moeten normaliseren:
  if (!str.includes('.')) return str;
  return str.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.$/u, '');
}

// ————————————————————————————————————
// Discord client
// ————————————————————————————————————
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ————————————————————————————————————
// Slash commands
// /lb_alltime  — post All-time Win/Loss/Total
// /lb_daily    — post Weekly Top 10 (laatste 7 dagen)
// ————————————————————————————————————
const commands = [
  new SlashCommandBuilder()
    .setName('lb_alltime')
    .setDescription('Post All-Time Top 25 wins + worst 25 + totals (nu)'),
  new SlashCommandBuilder()
    .setName('lb_daily')
    .setDescription('Post Top 10 van de laatste 7 dagen (nu)'),
].map((c) => c.toJSON());

async function registerCommandsOnce() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: commands,
  });
  console.log('✅ Slash-commands geregistreerd.');
}

// ————————————————————————————————————
// Message parser for !trade add
// Voorbeeld: !trade add PENG Long 0.03674 0.03755 30
// ————————————————————————————————————
async function handleTradeAdd(message) {
  const content = message.content.trim();
  const parts = content.split(/\s+/);
  //             0     1   2     3     4        5        6
  // verwacht:  !trade add  SYMBOL Side entry    exit     leverage
  if (parts.length < 7) return;

  const symbol = parts[2].toUpperCase();
  const side = parseSide(parts[3]);
  if (!side) return;

  // Bewaar raw voor weergave; gebruik numeric voor berekening
  const entryRaw = parts[4];
  const exitRaw = parts[5];
  const levRaw = parts[6];

  const entryNum = toNumberStrict(entryRaw);
  const exitNum = toNumberStrict(exitRaw);
  const leverage = parseInt(levRaw, 10);

  if (!Number.isFinite(entryNum) || !Number.isFinite(exitNum) || !Number.isFinite(leverage))
    return;

  // PnL berekenen
  let pnl = 0;
  if (side === 'Long') {
    pnl = ((exitNum - entryNum) / entryNum) * leverage * 100;
  } else {
    pnl = ((entryNum - exitNum) / entryNum) * leverage * 100;
  }

  const pctBadge = `\`${fmtPct(pnl)}\``;

  // Reply in INPUT – exact jouw stijl (coin dikgedrukt)
  await message.reply(
    `Trade geregistreerd: ${bold(symbol)} ${side} ${leverage}× → ${pctBadge}`
  );

  // Post in TRADE LOG – naam dikgedrukt, % op dezelfde regel, GEEN lege regel,
  // en entry/exit exact zoals ingevoerd (zonder afronding).
  const logMsg = await client.channels.cache
    .get(TRADE_LOG_CHANNEL_ID)
    ?.send(
      `${bold(message.member?.displayName || message.author.username)} ${pctBadge}\n` +
        `${symbol} ${side} ${leverage}×\n` +
        `Entry: $${trimTrailingZeros(entryRaw)}\n` +
        `Exit: $${trimTrailingZeros(exitRaw)}`
    );

  // In DB opslaan
  await pool.query(
    `
    INSERT INTO trades
      (guild_id, user_id, username, symbol, side,
       entry_raw, exit_raw, entry_num, exit_num, leverage,
       pnl_pct, trade_log_message_id)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `,
    [
      GUILD_ID,
      message.author.id,
      message.member?.displayName || message.author.username,
      symbol,
      side,
      entryRaw,
      exitRaw,
      entryNum,
      exitNum,
      leverage,
      pnl,
      logMsg?.id || null,
    ]
  );
}

// ————————————————————————————————————
// Leaderboard builders
// ————————————————————————————————————
async function fetchAllTimeTop(guildId) {
  // Top 25 beste trades (hoogste pnl)
  const best = await pool.query(
    `
    SELECT t.*, LOWER(t.username) AS uname
    FROM trades t
    WHERE t.guild_id = $1
    ORDER BY t.pnl_pct DESC
    LIMIT 25
    `,
    [guildId]
  );

  // Top 25 slechtste trades (laagste pnl)
  const worst = await pool.query(
    `
    SELECT t.*, LOWER(t.username) AS uname
    FROM trades t
    WHERE t.guild_id = $1
    ORDER BY t.pnl_pct ASC
    LIMIT 25
    `,
    [guildId]
  );

  // Totals – som van beste + slechtste trade per user
  const totals = await pool.query(
    `
    WITH best AS (
      SELECT username, MAX(pnl_pct) AS best
      FROM trades WHERE guild_id = $1
      GROUP BY username
    ),
    worst AS (
      SELECT username, MIN(pnl_pct) AS worst
      FROM trades WHERE guild_id = $1
      GROUP BY username
    )
    SELECT b.username,
           COALESCE(b.best,0) + COALESCE(w.worst,0) AS total
    FROM best b
    FULL JOIN worst w USING (username)
    WHERE b.username IS NOT NULL OR w.username IS NOT NULL
    ORDER BY total DESC
    LIMIT 25
    `,
    [guildId]
  );

  // Filter “JordanBelfort” uit alles
  const fBest = best.rows.filter((r) => !isExcludedUser(r.username));
  const fWorst = worst.rows.filter((r) => !isExcludedUser(r.username));
  const fTotals = totals.rows.filter((r) => !isExcludedUser(r.username));

  return { best: fBest, worst: fWorst, totals: fTotals };
}

async function fetchWeeklyTop(guildId) {
  // Laatste 7 dagen
  const weekly = await pool.query(
    `
    SELECT t.*, LOWER(t.username) AS uname
    FROM trades t
    WHERE t.guild_id = $1
      AND t.created_at >= NOW() - INTERVAL '7 days'
    ORDER BY t.pnl_pct DESC
    LIMIT 10
    `,
    [guildId]
  );

  return weekly.rows.filter((r) => !isExcludedUser(r.username));
}

function renderListBlock({
  title,
  rows,
  channelId,
  guildId,
  mode, // 'best' | 'worst' | 'totals' | 'weekly'
}) {
  // Strakke lijst met medailles + Trade link
  // Let op: bij totals hebben we alleen { username, total }
  const lines = rows.map((r, i) => {
    const rank = i + 1;
    const deco = medalFor(rank) + `${rank}. `;
    if (mode === 'totals') {
      const val = fmtPct(r.total).replace('%', '%'); // reuse fmt
      return `${deco}${bold(r.username)}  ${val}`;
    } else {
      const val = fmtPct(r.pnl_pct);
      const link = linkToTrade(guildId, channelId, r.trade_log_message_id, 'Trade');
      return `${deco}${bold(r.username)} ${r.symbol} ${val}${link}`;
    }
  });

  return `> ${title}\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

async function postAllTimeLeaderboard(channel) {
  const { best, worst, totals } = await fetchAllTimeTop(GUILD_ID);

  const blockBest = renderListBlock({
    title: 'Top 25 All-time Winsten',
    rows: best,
    channelId: TRADE_LOG_CHANNEL_ID,
    guildId: GUILD_ID,
    mode: 'best',
  });

  const blockWorst = renderListBlock({
    title: 'Top 25 All-time Verliezen',
    rows: worst,
    channelId: TRADE_LOG_CHANNEL_ID,
    guildId: GUILD_ID,
    mode: 'worst',
  });

  const blockTotals = renderListBlock({
    title: 'Totale PnL % (best + worst)',
    rows: totals,
    channelId: TRADE_LOG_CHANNEL_ID,
    guildId: GUILD_ID,
    mode: 'totals',
  });

  await channel.send(blockBest);
  await channel.send(blockWorst);
  await channel.send(blockTotals);
}

async function postWeeklyTop(channel) {
  const rows = await fetchWeeklyTop(GUILD_ID);

  const block = renderListBlock({
    title: 'Top 10 Weekly Trades (laatste 7 dagen)',
    rows,
    channelId: TRADE_LOG_CHANNEL_ID,
    guildId: GUILD_ID,
    mode: 'weekly',
  });

  await channel.send(block);
}

// ————————————————————————————————————
// Event wiring
// ————————————————————————————————————
client.on('ready', async () => {
  console.log(`✅ Ingelogd als ${client.user.tag}`);
  await ensureTables();
  await registerCommandsOnce();

  // CRON (optioneel): elke zondag 20:00 All-time; elke dag 09:00 Weekly
  cron.schedule(
    '0 20 * * 0',
    async () => {
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
      await postAllTimeLeaderboard(ch);
    },
    { timezone: TZ }
  );
  cron.schedule(
    '0 9 * * *',
    async () => {
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
      await postWeeklyTop(ch);
    },
    { timezone: TZ }
  );
});

client.on('messageCreate', async (message) => {
  try {
    if (
      message.guildId !== GUILD_ID ||
      message.author.bot ||
      message.channelId !== INPUT_CHANNEL_ID
    )
      return;

    const lower = message.content.toLowerCase().trim();
    if (lower.startsWith('!trade add ')) {
      await handleTradeAdd(message);
    }
  } catch (err) {
    console.error('messageCreate error', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);

    if (interaction.commandName === 'lb_alltime') {
      await interaction.reply({
        content: '🏆 All-Time leaderboards gepost (incl. backfill).',
        ephemeral: true,
      });
      await postAllTimeLeaderboard(ch);
    }

    if (interaction.commandName === 'lb_daily') {
      await interaction.reply({
        content: '📈 Weekly Top 10 gepost (incl. backfill).',
        ephemeral: true,
      });
      await postWeeklyTop(ch);
    }
  } catch (err) {
    console.error('interactionCreate error', err);
  }
});

// ————————————————————————————————————
client.login(TOKEN);

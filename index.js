// index.js — zonder dotenv import
import {
  Client,
  GatewayIntentBits,
  Partials,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} from 'discord.js';
import { REST } from 'discord.js';
import pkg from 'pg';

const { Pool } = pkg;

// === ENV ===
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

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !INPUT_CHANNEL_ID || !TRADE_LOG_CHANNEL_ID || !LEADERBOARD_CHANNEL_ID || !DATABASE_URL) {
  console.error('Missing one or more env vars.');
  process.exit(1);
}

// === DB ===
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// tables
await pool.query(`
CREATE TABLE IF NOT EXISTS trades (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  leverage INT NOT NULL,
  entry_raw TEXT NOT NULL,
  exit_raw  TEXT NOT NULL,
  entry_num DOUBLE PRECISION NOT NULL,
  exit_num  DOUBLE PRECISION NOT NULL,
  pnl_percent DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  log_channel_id TEXT,
  log_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_guild ON trades(guild_id);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
`);

// === DISCORD ===
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

// helpers
const medal = (i) => (i === 1 ? '🥇' : i === 2 ? '🥈' : i === 3 ? '🥉' : `${i}.`);
const fmtPct = (n) => (n >= 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`);
const tradeLink = (g, c, m) => (g && c && m) ? ` — [Trade](https://discord.com/channels/${g}/${c}/${m})` : '';
const bold = (t) => `**${t}**`;

// /trade
const commands = [
  new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Voeg een trade toe')
    .addStringOption(o => o.setName('actie').setDescription('add').setRequired(true).addChoices({ name: 'add', value: 'add' }))
    .addStringOption(o => o.setName('symbol').setDescription('bv. PENG').setRequired(true))
    .addStringOption(o => o.setName('zijde').setDescription('Long of Short').setRequired(true).addChoices({ name: 'Long', value: 'Long' }, { name: 'Short', value: 'Short' }))
    .addStringOption(o => o.setName('entry').setDescription('entry prijs (ruwe invoer)').setRequired(true))
    .addStringOption(o => o.setName('exit').setDescription('exit prijs (ruwe invoer)').setRequired(true))
    .addIntegerOption(o => o.setName('leverage').setDescription('hefboom, bv 30').setRequired(true))
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(TOKEN);
async function ensureCommands() {
  try {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log('✓ Slash-commands up-to-date');
  } catch (e) { console.error(e); }
}

// posts
async function postInputReply(interaction, symbol, side, lev, pnl) {
  const badge = pnl >= 0 ? `+${pnl.toFixed(2)}%` : `${pnl.toFixed(2)}%`;
  const content = `Trade geregistreerd: ${bold(symbol)} ${side} ${lev}× → ${badge}`;
  await interaction.reply({ content, allowedMentions: { parse: [] } });
}

async function postTradeLog(guild, userName, pnl, symbol, side, lev, entryRaw, exitRaw) {
  const ch = guild.channels.cache.get(TRADE_LOG_CHANNEL_ID);
  if (!ch) return { id: null };
  const header = `${bold(userName)} ${pnl >= 0 ? `+${pnl.toFixed(2)}%` : `${pnl.toFixed(2)}%`}`;
  const desc = `${symbol} ${side} ${lev}×\nEntry: ${entryRaw}\nExit: ${exitRaw}`;
  const embed = new EmbedBuilder().setDescription(`${header}\n\n${desc}`).setColor(pnl >= 0 ? 0x2ecc71 : 0xe74c3c);
  const sent = await ch.send({ embeds: [embed] });
  return { id: sent.id };
}

// leaderboards
async function buildAllTime(guildId) {
  const topWins = await pool.query(
    `SELECT username, symbol, pnl_percent, log_channel_id, log_message_id
     FROM trades WHERE guild_id=$1 ORDER BY pnl_percent DESC LIMIT 25`, [guildId]);
  const topLoss = await pool.query(
    `SELECT username, symbol, pnl_percent, log_channel_id, log_message_id
     FROM trades WHERE guild_id=$1 ORDER BY pnl_percent ASC LIMIT 25`, [guildId]);
  const totals = await pool.query(
    `WITH agg AS (
       SELECT LOWER(username) AS uname, MAX(pnl_percent) AS best, MIN(pnl_percent) AS worst, ANY_VALUE(username) AS display_name
       FROM trades WHERE guild_id=$1 GROUP BY LOWER(username)
     )
     SELECT display_name AS username, (best+worst) AS total
     FROM agg
     WHERE uname NOT LIKE 'jordanbelfort%'
     ORDER BY total DESC LIMIT 25`, [guildId]);

  const block = (title, rows) =>
    `\`📊\` **${title}**\n` +
    rows.map((r, i) => {
      const link = tradeLink(guildId, r.log_channel_id, r.log_message_id);
      const pct = r.total ?? r.pnl_percent;
      return `${medal(i + 1)} ${bold(r.username)} ${r.symbol ? r.symbol : ''} ${fmtPct(pct)}${link}`;
    }).join('\n');

  return {
    a: block('Top 25 All-time Winsten', topWins.rows),
    b: block('Top 25 All-time Verliezen', topLoss.rows),
    c: block('Totale PnL % (best + worst)', totals.rows.map(r => ({ username: r.username, pnl_percent: r.total }))),
  };
}

async function buildWeekly(guildId) {
  const res = await pool.query(
    `SELECT username, symbol, pnl_percent, log_channel_id, log_message_id
     FROM trades
     WHERE guild_id=$1 AND created_at >= NOW() - INTERVAL '7 days'
     ORDER BY pnl_percent DESC LIMIT 10`, [guildId]);

  return `\`📅\` **Top 10 Weekly Trades (laatste 7 dagen)**\n` +
    res.rows.map((r, i) =>
      `${medal(i + 1)} ${bold(r.username)} ${r.symbol} ${fmtPct(r.pnl_percent)}${tradeLink(guildId, r.log_channel_id, r.log_message_id)}`
    ).join('\n');
}

async function postLeaderboards(guild) {
  const ch = guild.channels.cache.get(LEADERBOARD_CHANNEL_ID);
  if (!ch) return;
  const { a, b, c } = await buildAllTime(guild.id);
  await ch.send({ content: a });
  await ch.send({ content: b });
  await ch.send({ content: c });
  const weekly = await buildWeekly(guild.id);
  await ch.send({ content: weekly });
}

// interactions
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'trade') {
      const action = interaction.options.getString('actie');
      if (action !== 'add') return interaction.reply({ content: 'Alleen “add”.', ephemeral: true });

      const symbol = interaction.options.getString('symbol').toUpperCase();
      const side = interaction.options.getString('zijde');
      const leverage = interaction.options.getInteger('leverage');
      const entryRaw = interaction.options.getString('entry');
      const exitRaw = interaction.options.getString('exit');

      const entry = parseFloat(entryRaw.replace(',', '.'));
      const exit = parseFloat(exitRaw.replace(',', '.'));
      if (!Number.isFinite(entry) || !Number.isFinite(exit)) return interaction.reply({ content: 'Entry/Exit moeten nummers zijn.', ephemeral: true });

      const base = ((exit - entry) / entry) * 100;
      const signed = side.toLowerCase() === 'short' ? -base : base;
      const pnl = signed * leverage;

      await postInputReply(interaction, symbol, side, leverage, pnl);
      const { id: logMsgId } = await postTradeLog(interaction.guild, interaction.user.username, pnl, symbol, side, leverage, entryRaw, exitRaw);

      await pool.query(
        `INSERT INTO trades (guild_id,user_id,username,symbol,side,leverage,entry_raw,exit_raw,entry_num,exit_num,pnl_percent,log_channel_id,log_message_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [interaction.guildId, interaction.user.id, interaction.user.username, symbol, side, leverage, entryRaw, exitRaw, entry, exit, pnl, TRADE_LOG_CHANNEL_ID, logMsgId || null]
      );
    }

    if (interaction.commandName === 'lb_alltime') {
      await interaction.reply({ content: 'All-Time leaderboards gepost (incl. backfill).', ephemeral: true });
      await postLeaderboards(interaction.guild);
    }

    if (interaction.commandName === 'lb_daily') {
      const ch = interaction.guild.channels.cache.get(LEADERBOARD_CHANNEL_ID);
      const weekly = await buildWeekly(interaction.guildId);
      await interaction.reply({ content: 'Weekly Top 10 gepost (incl. backfill).', ephemeral: true });
      if (ch) await ch.send({ content: weekly });
    }
  } catch (e) {
    console.error('interaction error:', e);
    if (interaction.isRepliable()) { try { await interaction.reply({ content: 'Er ging iets mis.', ephemeral: true }); } catch {} }
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await ensureCommands();
});

client.login(TOKEN);

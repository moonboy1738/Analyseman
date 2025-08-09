// index.js — Heroku friendly, zonder dotenv, zonder auto command-registratie
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
} from 'discord.js';
import pkg from 'pg';

const { Pool } = pkg;

/* ====== ENV ====== */
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

function need(name) {
  if (!process.env[name]) {
    console.error(`[ENV] Missing ${name}`);
    return true;
  }
  return false;
}
if (
  [
    'TOKEN',
    'CLIENT_ID',
    'GUILD_ID',
    'INPUT_CHANNEL_ID',
    'TRADE_LOG_CHANNEL_ID',
    'LEADERBOARD_CHANNEL_ID',
    'DATABASE_URL',
  ].some(need)
) {
  process.exit(1);
}

/* ====== DB ====== */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Tabel aanmaken (idempotent)
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

/* ====== DISCORD ====== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

/* ====== HELPERS ====== */
const bold = (t) => `**${t}**`;
const medal = (i) => (i === 1 ? '🥇' : i === 2 ? '🥈' : i === 3 ? '🥉' : `${i}.`);
const fmtPct = (n) => (n >= 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`);
const tradeLink = (g, c, m) =>
  g && c && m ? ` — [Trade](https://discord.com/channels/${g}/${c}/${m})` : '';

/**
 * Input reply — exact zoals jij ‘m wilde:
 * "Trade geregistreerd: **PENG** Long 30× → +66.14%"
 */
async function postInputReply(interaction, symbol, side, lev, pnl) {
  const badge = pnl >= 0 ? `+${pnl.toFixed(2)}%` : `${pnl.toFixed(2)}%`;
  const content = `Trade geregistreerd: ${bold(symbol)} ${side} ${lev}× → ${badge}`;
  await interaction.reply({ content, allowedMentions: { parse: [] } });
}

/**
 * Trade Log-kaartje — username vet + pct, entry/exit = RUWE invoer,
 * geen extra lege regel ertussen.
 */
async function postTradeLog(guild, userName, pnl, symbol, side, lev, entryRaw, exitRaw) {
  const ch = guild.channels.cache.get(TRADE_LOG_CHANNEL_ID);
  if (!ch) return { id: null };

  const header = `${bold(userName)} ${pnl >= 0 ? `+${pnl.toFixed(2)}%` : `${pnl.toFixed(2)}%`}`;
  const lines = [
    `${symbol} ${side} ${lev}×`,
    `Entry: ${entryRaw}`,
    `Exit: ${exitRaw}`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setDescription(`${header}\n${lines}`)
    .setColor(pnl >= 0 ? 0x2ecc71 : 0xe74c3c);

  const sent = await ch.send({ embeds: [embed] });
  return { id: sent.id };
}

/* ====== LEADERBOARDS ====== */
async function buildAllTime(guildId) {
  const topWins = await pool.query(
    `SELECT username, symbol, pnl_percent, log_channel_id, log_message_id
     FROM trades
     WHERE guild_id = $1
     ORDER BY pnl_percent DESC
     LIMIT 25`,
    [guildId]
  );

  const topLoss = await pool.query(
    `SELECT username, symbol, pnl_percent, log_channel_id, log_message_id
     FROM trades
     WHERE guild_id = $1
     ORDER BY pnl_percent ASC
     LIMIT 25`,
    [guildId]
  );

  const totals = await pool.query(
    `WITH agg AS (
       SELECT LOWER(username) AS uname,
              MAX(pnl_percent) AS best,
              MIN(pnl_percent) AS worst,
              ANY_VALUE(username) AS display_name
       FROM trades
       WHERE guild_id = $1
       GROUP BY LOWER(username)
     )
     SELECT display_name AS username,
            (best + worst) AS total
     FROM agg
     WHERE uname <> 'jordanbelfort'
     ORDER BY total DESC
     LIMIT 25`,
    [guildId]
  );

  const blockWins =
    `\`🏆\` **Top 25 All-time Winsten**\n` +
    topWins.rows
      .map(
        (r, i) =>
          `${medal(i + 1)} ${bold(r.username)} ${r.symbol} ${fmtPct(r.pnl_percent)}${tradeLink(
            guildId,
            r.log_channel_id,
            r.log_message_id
          )}`
      )
      .join('\n');

  const blockLoss =
    `\`🧊\` **Top 25 All-time Verliezen**\n` +
    topLoss.rows
      .map(
        (r, i) =>
          `${medal(i + 1)} ${bold(r.username)} ${r.symbol} ${fmtPct(r.pnl_percent)}${tradeLink(
            guildId,
            r.log_channel_id,
            r.log_message_id
          )}`
      )
      .join('\n');

  const blockTotals =
    `\`📦\` **Totale PnL % (best + worst)**\n` +
    totals.rows
      .map((r, i) => `${medal(i + 1)} ${bold(r.username)} ${fmtPct(r.total)}`)
      .join('\n');

  return { blockWins, blockLoss, blockTotals };
}

async function buildWeekly(guildId) {
  const last7 = await pool.query(
    `SELECT username, symbol, pnl_percent, log_channel_id, log_message_id
     FROM trades
     WHERE guild_id = $1
       AND created_at >= NOW() - INTERVAL '7 days'
     ORDER BY pnl_percent DESC
     LIMIT 10`,
    [guildId]
  );

  const blockWeekly =
    `\`📅\` **Top 10 Weekly Trades (laatste 7 dagen)**\n` +
    last7.rows
      .map(
        (r, i) =>
          `${medal(i + 1)} ${bold(r.username)} ${r.symbol} ${fmtPct(r.pnl_percent)}${tradeLink(
            guildId,
            r.log_channel_id,
            r.log_message_id
          )}`
      )
      .join('\n');

  return blockWeekly;
}

async function postLeaderboards(guild) {
  const ch = guild.channels.cache.get(LEADERBOARD_CHANNEL_ID);
  if (!ch) return;

  const { blockWins, blockLoss, blockTotals } = await buildAllTime(guild.id);
  const blockWeekly = await buildWeekly(guild.id);

  await ch.send({ content: blockWins });
  await ch.send({ content: blockLoss });
  await ch.send({ content: blockTotals });
  await ch.send({ content: blockWeekly });
}

/* ====== INTERACTIONS ====== */
client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'trade') {
      const action = interaction.options.getString('actie');
      if (action !== 'add') {
        return interaction.reply({ content: 'Alleen “add”.', ephemeral: true });
      }

      const symbol = interaction.options.getString('symbol').toUpperCase();
      const side = interaction.options.getString('zijde');
      const leverage = interaction.options.getInteger('leverage');

      // Gebruik exact RUWE invoer — >6 decimalen toegestaan
      const entryRaw = interaction.options.getString('entry');
      const exitRaw = interaction.options.getString('exit');
      const entry = parseFloat(entryRaw.replace(',', '.'));
      const exit = parseFloat(exitRaw.replace(',', '.'));

      if (!Number.isFinite(entry) || !Number.isFinite(exit)) {
        return interaction.reply({
          content: 'Entry/Exit moeten valide getallen zijn.',
          ephemeral: true,
        });
      }

      // PnL
      const base = ((exit - entry) / entry) * 100;
      const signed = side.toLowerCase() === 'short' ? -base : base;
      const pnl = signed * leverage;

      // 1) input reply (exact zoals jij wilt)
      await postInputReply(interaction, symbol, side, leverage, pnl);

      // 2) trade-log kaartje + DB
      const { id: logMsgId } = await postTradeLog(
        interaction.guild,
        interaction.user.username,
        pnl,
        symbol,
        side,
        leverage,
        entryRaw,
        exitRaw
      );

      await pool.query(
        `INSERT INTO trades
         (guild_id, user_id, username, symbol, side, leverage,
          entry_raw, exit_raw, entry_num, exit_num, pnl_percent,
          created_at, log_channel_id, log_message_id)
         VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12,$13)`,
        [
          interaction.guildId,
          interaction.user.id,
          interaction.user.username,
          symbol,
          side,
          leverage,
          entryRaw,
          exitRaw,
          entry,
          exit,
          pnl,
          TRADE_LOG_CHANNEL_ID,
          logMsgId || null,
        ]
      );
    }

    if (interaction.commandName === 'lb_alltime') {
      await interaction.reply({
        content: 'All-Time leaderboards gepost (incl. backfill).',
        ephemeral: true,
      });
      await postLeaderboards(interaction.guild);
    }

    if (interaction.commandName === 'lb_daily') {
      const weekly = await buildWeekly(interaction.guildId);
      await interaction.reply({
        content: 'Weekly Top 10 gepost (incl. backfill).',
        ephemeral: true,
      });
      const ch = interaction.guild.channels.cache.get(LEADERBOARD_CHANNEL_ID);
      if (ch) await ch.send({ content: weekly });
    }
  } catch (err) {
    console.error('[interactionCreate] error:', err);
    try {
      if (interaction.isRepliable())
        await interaction.reply({ content: 'Er ging iets mis.', ephemeral: true });
    } catch {}
  }
});

/* ====== READY ====== */
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log('Guild:', GUILD_ID);
  console.log('Channels:', { INPUT_CHANNEL_ID, TRADE_LOG_CHANNEL_ID, LEADERBOARD_CHANNEL_ID });
});

client.on('error', (e) => console.error('[client error]', e));
client.on('shardError', (e) => console.error('[shard error]', e));

/* ====== START ====== */
client.login(TOKEN);

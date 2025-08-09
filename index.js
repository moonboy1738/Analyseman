// index.js
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import pkg from 'pg';
import cron from 'node-cron';

const { Pool } = pkg;

/* ====== ENV (Heroku Config Vars) ======
TOKEN
GUILD_ID
INPUT_CHANNEL_ID
TRADE_LOG_CHANNEL_ID
LEADERBOARD_CHANNEL_ID
DATABASE_URL
TZ=Europe/Amsterdam
======================================= */

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID;
const TRADE_LOG_CHANNEL_ID = process.env.TRADE_LOG_CHANNEL_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;

// ====== DB ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('amazonaws.com') ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      message_id TEXT UNIQUE,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('Long','Short')),
      entry NUMERIC NOT NULL,
      exit NUMERIC NOT NULL,
      leverage INTEGER NOT NULL,
      pnl NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS message_id TEXT UNIQUE;`);
}

async function tradeExistsByMessageId(messageId) {
  const { rows } = await pool.query(`SELECT 1 FROM trades WHERE message_id = $1`, [messageId]);
  return rows.length > 0;
}

// ====== Discord Client ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// ====== Helpers ======
const multTimes = (n) => `${n}\u00D7`;  // 35× voor #input
const multAscii = (n) => `${n}x`;       // 35x voor #trade-log (match historie)
const money  = (v) => `$${Number(v).toFixed(2)}`;
const pct    = (p) => `${Number(p).toFixed(2)}%`;
const sign   = (p) => (p >= 0 ? '+' : '');

function calcPnl(side, entry, exit, lev){
  const e = Number(entry), x = Number(exit), L = Number(lev);
  const base = side.toLowerCase()==='short' ? (e - x)/e : (x - e)/e;
  return base * L * 100;
}

function tradeLink(messageId) {
  if (!GUILD_ID || !TRADE_LOG_CHANNEL_ID || !messageId) return '';
  return `https://discord.com/channels/${GUILD_ID}/${TRADE_LOG_CHANNEL_ID}/${messageId}`;
}

// ====== #input (EXACT + symbool vet) ======
async function sendInputLine({ symbol, side, lev, pnl }) {
  const ch = await client.channels.fetch(INPUT_CHANNEL_ID);
  const line = `Trade geregistreerd: **${symbol.toUpperCase()}** ${side} ${multTimes(lev)} → \`${pct(pnl)}\``;
  await ch.send(line);
}

// ====== #trade-log (geen embed, naam vet naast percentage, geen lege regel) ======
async function sendTradeLog({ author, symbol, side, entry, exit, lev, pnl }) {
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  const header = `**${author}** \`${pct(pnl)}\``;
  const body   = `${symbol.toUpperCase()} ${side} ${multAscii(lev)}\nEntry: ${money(entry)}\nExit: ${money(exit)}`;
  const sent = await ch.send(`${header}\n${body}`);
  return sent; // we willen id én createdAt
}

// ====== Opslaan (met optionele createdAt) ======
async function saveTrade(t) {
  if (t.createdAt) {
    await pool.query(
      `INSERT INTO trades (message_id, user_id, username, symbol, side, entry, exit, leverage, pnl, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (message_id) DO NOTHING`,
      [t.messageId ?? null, t.userId, t.username, t.symbol.toUpperCase(), t.side, t.entry, t.exit, t.lev, t.pnl, t.createdAt]
    );
  } else {
    await pool.query(
      `INSERT INTO trades (message_id, user_id, username, symbol, side, entry, exit, leverage, pnl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (message_id) DO NOTHING`,
      [t.messageId ?? null, t.userId, t.username, t.symbol.toUpperCase(), t.side, t.entry, t.exit, t.lev, t.pnl]
    );
  }
}

// ====== Centrale flow ======
async function handleTrade({ userId, username, symbol, side, entry, exit, lev }) {
  const pnl = calcPnl(side, entry, exit, lev);

  await sendInputLine({ symbol, side, lev, pnl });

  const sent = await sendTradeLog({ author: username, symbol, side, entry, exit, lev, pnl });

  await saveTrade({
    messageId: sent.id,
    userId,
    username,
    symbol,
    side,
    entry,
    exit,
    lev,
    pnl,
    createdAt: new Date(sent.createdTimestamp)
  });
}

// ====== Parser voor backfill van oude trade-log berichten ======
function parseTradeFromMessage(msg) {
  const parts = [msg.content, ...(msg.embeds || []).map(e => e?.description || '')].filter(Boolean);
  const text = parts.join('\n').trim();
  if (!text) return null;

  // header: **username** `-26.52%`  of  username `-26.52%`
  const headerMatch = text.match(/^\*{0,2}(.+?)\*{0,2}\s+`([+-]?\d+(?:\.\d+)?)%`/m);
  if (!headerMatch) return null;
  const username = headerMatch[1].trim();
  const pnl = Number(headerMatch[2]);

  // main: "PENG Long 30x" of "PENG Long 30×"
  const mainMatch = text.match(/^\s*([A-Z0-9/]+)\s+(Long|Short)\s+(\d+)\s*[x×]/mi);
  const entryMatch = text.match(/Entry:\s*\$?\s*([0-9]*\.?[0-9]+)/i);
  const exitMatch  = text.match(/Exit:\s*\$?\s*([0-9]*\.?[0-9]+)/i);
  if (!mainMatch || !entryMatch || !exitMatch) return null;

  const symbol = mainMatch[1].toUpperCase();
  const side   = mainMatch[2];
  const lev    = parseInt(mainMatch[3], 10);
  const entry  = Number(entryMatch[1]);
  const exit   = Number(exitMatch[1]);

  return { username, symbol, side, lev, entry, exit, pnl };
}

async function backfillFromTradeLog() {
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  let before = undefined;
  let totalNew = 0;

  for (;;) {
    const batch = await ch.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;

    for (const [, m] of batch) {
      const already = await tradeExistsByMessageId(m.id);
      if (already) continue;

      const parsed = parseTradeFromMessage(m);
      if (!parsed) continue;

      await saveTrade({
        messageId: m.id,
        userId: m.author?.id || 'unknown',
        username: parsed.username,
        symbol: parsed.symbol,
        side: parsed.side,
        entry: parsed.entry,
        exit: parsed.exit,
        lev: parsed.lev,
        pnl: parsed.pnl,
        createdAt: new Date(m.createdTimestamp)
      });
      totalNew++;
    }

    before = batch.last()?.id;
  }

  if (totalNew > 0) {
    console.log(`Backfill: ${totalNew} trades toegevoegd vanuit #trade-log.`);
  } else {
    console.log('Backfill: geen nieuwe trades gevonden.');
  }
}

// ====== Tekstcommando: !trade add … ======
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.id !== INPUT_CHANNEL_ID) return;

    const parts = message.content.trim().split(/\s+/);
    if (parts[0].toLowerCase() !== '!trade' || (parts[1]?.toLowerCase() !== 'add')) return;

    if (parts.length < 7) {
      await message.reply('Formaat: `!trade add <SYM> <Long|Short> <entry> <exit> <leverage>`');
      return;
    }

    const symbol = parts[2];
    const side   = /^s/i.test(parts[3]) ? 'Short' : 'Long';
    const entry  = Number(parts[4]);
    const exit   = Number(parts[5]);
    const lev    = parseInt(parts[6], 10);

    if ([entry, exit, lev].some(v => Number.isNaN(v))) {
      await message.reply('Formaat: `!trade add <SYM> <Long|Short> <entry> <exit> <leverage>`');
      return;
    }

    await handleTrade({
      userId: message.author.id,
      username: message.author.username,
      symbol, side, entry, exit, lev
    });
  } catch (err) {
    console.error('messageCreate error', err);
  }
});

// ====== Slash commands: /trade, /lb_alltime, /lb_daily ======
client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'trade') {
      if (i.options.getString('actie') !== 'add') {
        await i.reply({ content: 'Alleen `add` wordt ondersteund.', ephemeral: true });
        return;
      }
      const symbol = i.options.getString('symbool');
      const side   = i.options.getString('zijde');        // 'Long' | 'Short'
      const entry  = i.options.getNumber('entry');
      const exit   = i.options.getNumber('exit');
      const lev    = i.options.getInteger('leverage');

      await i.deferReply({ ephemeral: true });
      await handleTrade({
        userId: i.user.id,
        username: i.user.username,
        symbol, side, entry, exit, lev
      });
      await i.editReply('✅ Trade geregistreerd.');
      return;
    }

    if (i.commandName === 'lb_alltime') {
      await i.deferReply({ ephemeral: true });
      await backfillFromTradeLog();

      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
      const e1 = await renderAllTimeEmbed(true);
      const e2 = await renderAllTimeEmbed(false);
      const t  = await renderTotalsEmbed();

      await ch.send({ embeds: [e1] });
      await ch.send({ embeds: [e2] });
      await ch.send({ embeds: [t] });
      await i.editReply('✅ All-Time leaderboards gepost (incl. backfill).');
      return;
    }

    if (i.commandName === 'lb_daily') {
      await i.deferReply({ ephemeral: true });
      await backfillFromTradeLog();

      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
      const e = await renderWeeklyTop10Embed();
      await ch.send({ embeds: [e] });
      await i.editReply('✅ Weekly Top 10 gepost (incl. backfill).');
      return;
    }
  } catch (err) {
    console.error('interactionCreate error', err);
  }
});

// ====== Leaderboard (mooie embeds met klikbare [Trade]) ======
function padRank(n){ return String(n).padStart(2,' '); }

function rowTrade(rank, r){
  const s = sign(Number(r.pnl));
  const url = tradeLink(r.message_id);
  return `${padRank(rank)}. **${r.username}** ${r.symbol} \`${s}${Number(r.pnl).toFixed(2)}%\` — [Trade](${url})`;
}

function rowTotals(rank, r){
  const s = sign(Number(r.total));
  return `${padRank(rank)}. **${r.username}** \`${s}${Number(r.total).toFixed(2)}%\``;
}

async function renderAllTimeEmbed(isWinners){
  const order = isWinners ? 'DESC' : 'ASC';
  const signOp  = isWinners ? '>='   : '<=';
  const title = isWinners ? '🏆 Top 25 All-time Winsten' : '💀 Top 25 All-time Verliezen';

  const { rows } = await pool.query(
    `SELECT username, symbol, pnl, message_id
       FROM trades
      WHERE pnl ${signOp} 0
      ORDER BY pnl ${order}
      LIMIT 25`
  );

  const lines = rows.length
    ? rows.map((r, i) => rowTrade(i+1, r)).join('\n')
    : 'Geen data.';

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines)
    .setColor(0x5865F2);
}

async function renderTotalsEmbed(){
  const { rows } = await pool.query(
    `SELECT username, SUM(pnl) AS total
       FROM trades
      GROUP BY username
      ORDER BY SUM(pnl) DESC`
  );

  const lines = rows.length
    ? rows.map((r, i) => rowTotals(i+1, r)).join('\n')
    : 'Geen data.';

  return new EmbedBuilder()
    .setTitle('📊 Totale PnL % (best → worst)')
    .setDescription(lines)
    .setColor(0x43B581);
}

async function renderWeeklyTop10Embed(){
  // Exact laatste 7 dagen, gebaseerd op echte bericht-tijd (created_at)
  const { rows } = await pool.query(
    `SELECT username, symbol, pnl, message_id
       FROM trades
      WHERE created_at >= NOW() - INTERVAL '7 days'
      ORDER BY pnl DESC
      LIMIT 10`
  );

  const lines = rows.length
    ? rows.map((r, i) => rowTrade(i+1, r)).join('\n')
    : 'Geen data.';

  return new EmbedBuilder()
    .setTitle('📅 Top 10 Weekly Trades (laatste 7 dagen)')
    .setDescription(lines)
    .setColor(0xFAA61A);
}

// ====== Cron (met backfill) ======
cron.schedule('0 20 * * 0', async () => { // Zondag 20:00
  try {
    await backfillFromTradeLog();
    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    const e1 = await renderAllTimeEmbed(true);
    const e2 = await renderAllTimeEmbed(false);
    const t  = await renderTotalsEmbed();
    await ch.send({ embeds: [e1] });
    await ch.send({ embeds: [e2] });
    await ch.send({ embeds: [t] });
  } catch (e) { console.error('weekly cron error', e); }
});

cron.schedule('0 9 * * *', async () => {  // Dagelijks 09:00
  try {
    await backfillFromTradeLog();
    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    const e = await renderWeeklyTop10Embed();
    await ch.send({ embeds: [e] });
  } catch (e) { console.error('daily cron error', e); }
});

// ====== Ready ======
client.once('ready', async () => {
  await initDb();
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(TOKEN);

// index.js
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import pkg from 'pg';
import cron from 'node-cron';

const { Pool } = pkg;

/* ====== ENV (Heroku Config Vars) ======
TOKEN
INPUT_CHANNEL_ID
TRADE_LOG_CHANNEL_ID
LEADERBOARD_CHANNEL_ID
DATABASE_URL
TZ=Europe/Amsterdam
======================================= */

const TOKEN = process.env.TOKEN;
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
      message_id TEXT UNIQUE,               -- koppelt DB record aan Discord bericht
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('Long','Short')),
      entry NUMERIC NOT NULL,
      exit NUMERIC NOT NULL,
      leverage INTEGER NOT NULL,
      pnl NUMERIC NOT NULL,                 -- percentage (kan negatief)
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  // Zorg dat kolom bestaat als je van oudere versie komt
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
const multTimes = (n) => `${n}\u00D7`;                 // 35× (mooie x)
const multAscii = (n) => `${n}x`;                      // 35x (matcht historie in trade-log)
const money  = (v) => `$${Number(v).toFixed(2)}`;      // $0.04
const pct    = (p) => `${Number(p).toFixed(2)}%`;

function calcPnl(side, entry, exit, lev){
  const e = Number(entry), x = Number(exit), L = Number(lev);
  const base = side.toLowerCase()==='short' ? (e - x)/e : (x - e)/e;
  return base * L * 100;
}

// ====== #input (EXACT + symbool vet) ======
async function sendInputLine({ symbol, side, lev, pnl }) {
  const ch = await client.channels.fetch(INPUT_CHANNEL_ID);
  const line = `Trade geregistreerd: **${symbol.toUpperCase()}** ${side} ${multTimes(lev)} → \`${pct(pnl)}\``;
  await ch.send(line);
}

// ====== #trade-log (GEEN EMBED; exact zoals jouw oude stijl) ======
async function sendTradeLog({ author, symbol, side, entry, exit, lev, pnl }) {
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  const header = `${author} \`${pct(pnl)}\``; // bovenste regel met grijze code-label op percentage
  const body   = `${symbol.toUpperCase()} ${side} ${multAscii(lev)}\nEntry: ${money(entry)}\nExit: ${money(exit)}`;
  const sent = await ch.send(`${header}\n\n${body}`);
  return sent.id; // message_id gebruiken voor unieke opslag
}

// ====== Opslaan ======
async function saveTrade(t) {
  await pool.query(
    `INSERT INTO trades (message_id, user_id, username, symbol, side, entry, exit, leverage, pnl)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (message_id) DO NOTHING`,
    [t.messageId ?? null, t.userId, t.username, t.symbol.toUpperCase(), t.side, t.entry, t.exit, t.lev, t.pnl]
  );
}

// ====== Centrale flow ======
async function handleTrade({ userId, username, symbol, side, entry, exit, lev }) {
  const pnl = calcPnl(side, entry, exit, lev);

  // 1) input melding exact
  await sendInputLine({ symbol, side, lev, pnl });

  // 2) trade-log bericht (zonder embed) en DB opslaan met message_id
  const messageId = await sendTradeLog({ author: username, symbol, side, entry, exit, lev, pnl });
  await saveTrade({ messageId, userId, username, symbol, side, entry, exit, lev, pnl });
}

// ====== Parser voor backfill van oude trade-log berichten ======
function parseTradeFromMessage(msg) {
  // Verzamel content + (eventuele) embed descriptions
  const parts = [msg.content, ...(msg.embeds || []).map(e => e?.description || '')].filter(Boolean);
  const text = parts.join('\n').trim();
  if (!text) return null;

  // 1) Bovenste regel: <username> `-26.52%`
  const headerMatch = text.match(/^(.+?)\s+`([+-]?\d+(?:\.\d+)?)%`/m);
  if (!headerMatch) return null;
  const username = headerMatch[1].trim();
  const pnl = Number(headerMatch[2]);

  // 2) Blok met symbol/side/lev + entry/exit
  // Zoeken naar bv: "PENG Long 30x" of "PENG Long 30×"
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
      // Alleen bot-berichten van deze bot (of alles? => hier alles, want oude berichten staan op naam "Analyseman")
      // Maar we dedupliceren op message_id in de DB.
      const already = await tradeExistsByMessageId(m.id);
      if (already) continue;

      const parsed = parseTradeFromMessage(m);
      if (!parsed) continue;

      // Sla op met message_id (geen herberekening nodig; pnl uit header nemen)
      await saveTrade({
        messageId: m.id,
        userId: m.author?.id || 'unknown',
        username: parsed.username,
        symbol: parsed.symbol,
        side: parsed.side,
        entry: parsed.entry,
        exit: parsed.exit,
        lev: parsed.lev,
        pnl: parsed.pnl
      });
      totalNew++;
    }

    // paginate
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
      // >>> Belangrijk: backfill eerst, zodat ALLE oude posts meegeteld worden
      await backfillFromTradeLog();

      const t1 = await renderAllTime(true);
      const t2 = await renderAllTime(false);
      const t3 = await renderTotals();
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
      await ch.send(t1 || 'Geen data.');
      await ch.send(t2 || 'Geen data.');
      await ch.send(t3 || 'Geen data.');
      await i.editReply('✅ All-Time leaderboards gepost (incl. backfill).');
      return;
    }

    if (i.commandName === 'lb_daily') {
      await i.deferReply({ ephemeral: true });
      // >>> Ook hier backfill zodat weekly top10 klopt met historie
      await backfillFromTradeLog();

      const t = await renderWeeklyTop10();
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
      await ch.send(t || 'Geen data.');
      await i.editReply('✅ Weekly Top 10 gepost (incl. backfill).');
      return;
    }
  } catch (err) {
    console.error('interactionCreate error', err);
  }
});

// ====== Leaderboard helpers ======
function padRank(n){ return String(n).padStart(2,' '); }
function lineUser(rank, name, valuePct){
  const uname = (name ?? 'unknown').slice(0, 24);
  const sign  = valuePct >= 0 ? '+' : '';
  return `${padRank(rank)}. ${uname}  ${sign}${valuePct.toFixed(2)}%`;
}

async function renderAllTime(isWinners){
  const order = isWinners ? 'DESC' : 'ASC';
  const sign  = isWinners ? '>='   : '<=';
  const title = isWinners ? '🏆 Top 25 All-time Winsten' : '💀 Top 25 All-time Verliezen';

  const { rows } = await pool.query(
    `SELECT username, pnl
       FROM trades
      WHERE pnl ${sign} 0
      ORDER BY pnl ${order}
      LIMIT 25`
  );

  if (!rows.length) return 'Geen data.';
  const body = rows.map((r, i) => lineUser(i+1, r.username, Number(r.pnl)));
  return '```' + [title, ...body].join('\n') + '```';
}

async function renderTotals(){
  const { rows } = await pool.query(
    `SELECT username, SUM(pnl) AS total
       FROM trades
      GROUP BY username
      ORDER BY SUM(pnl) DESC`
  );
  if (!rows.length) return 'Geen data.';
  const title = '📊 Totale PnL % (best → worst)';
  const body  = rows.map((r,i) => lineUser(i+1, r.username, Number(r.total)));
  return '```' + [title, ...body].join('\n') + '```';
}

async function renderWeeklyTop10(){
  const { rows } = await pool.query(
    `SELECT username, symbol, pnl
       FROM trades
      WHERE created_at >= NOW() - INTERVAL '7 days'
      ORDER BY pnl DESC
      LIMIT 10`
  );
  if (!rows.length) return 'Geen data.';
  const title = '📅 Top 10 Weekly Trades';
  const body  = rows.map((r,i) => {
    const sign = Number(r.pnl) >= 0 ? '+' : '';
    return `${padRank(i+1)}. ${r.username} ${r.symbol} ${sign}${Number(r.pnl).toFixed(2)}%`;
  });
  return '```' + [title, ...body].join('\n') + '```';
}

// ====== Cron (post in #leaderboard op schema; mét backfill) ======
cron.schedule('0 20 * * 0', async () => { // Zondag 20:00
  try {
    await backfillFromTradeLog();
    const t1 = await renderAllTime(true);
    const t2 = await renderAllTime(false);
    const t3 = await renderTotals();
    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    if (t1) await ch.send(t1);
    if (t2) await ch.send(t2);
    if (t3) await ch.send(t3);
  } catch (e) { console.error('weekly cron error', e); }
});

cron.schedule('0 9 * * *', async () => {  // Dagelijks 09:00
  try {
    await backfillFromTradeLog();
    const t = await renderWeeklyTop10();
    const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    if (t) await ch.send(t);
  } catch (e) { console.error('daily cron error', e); }
});

// ====== Ready ======
client.once('ready', async () => {
  await initDb();
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(TOKEN);

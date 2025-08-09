// index.js
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
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

// ====== Database ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('amazonaws.com')
    ? { rejectUnauthorized: false }
    : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('Long','Short')),
      entry NUMERIC NOT NULL,
      exit NUMERIC NOT NULL,
      leverage INTEGER NOT NULL,
      pnl NUMERIC NOT NULL,             -- percentage
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
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
const mult  = (n) => `${n}\u00D7`;                 // 35×
const money = (v) => `$${Number(v).toFixed(2)}`;   // $0.04
const pct   = (p) => `${Number(p).toFixed(2)}%`;

function calcPnl(side, entry, exit, lev){
  const e = Number(entry), x = Number(exit), L = Number(lev);
  const base = side.toLowerCase()==='short' ? (e - x)/e : (x - e)/e;
  return base * L * 100;
}

async function saveTrade(t) {
  if (!process.env.DATABASE_URL) return;
  await pool.query(
    `INSERT INTO trades (user_id, username, symbol, side, entry, exit, leverage, pnl)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [t.userId, t.username, t.symbol.toUpperCase(), t.side, t.entry, t.exit, t.lev, t.pnl]
  );
}

// ====== Exacte output voor #input ======
async function sendInputLine({ symbol, side, lev, pnl }) {
  const ch = await client.channels.fetch(INPUT_CHANNEL_ID);
  const line = `Trade geregistreerd: ${symbol.toUpperCase()} ${side} ${mult(lev)} → \`${pct(pnl)}\``;
  await ch.send(line);
}

// ====== Exacte output voor #trade-log ======
async function sendTradeLog({ author, symbol, side, entry, exit, lev, pnl }) {
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  const header = `${author} \`${pct(pnl)}\``; // Bovenste regel
  const embed = new EmbedBuilder().setDescription(
    `**${symbol.toUpperCase()} ${side} ${mult(lev)}**\n` +
    `**Entry:** ${money(entry)}\n` +
    `**Exit:** ${money(exit)}`
  );
  await ch.send({ content: header, embeds: [embed] });
}

// ====== Centrale handler (gebruikt door !trade en /trade) ======
async function handleTrade({ userId, username, symbol, side, entry, exit, lev }) {
  const pnl = calcPnl(side, entry, exit, lev);
  await sendInputLine({ symbol, side, lev, pnl });
  await saveTrade({ userId, username, symbol, side, entry, exit, lev, pnl });
  await sendTradeLog({ author: username, symbol, side, entry, exit, lev, pnl });
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
      const t1 = await renderAllTime(true);
      const t2 = await renderAllTime(false);
      const t3 = await renderTotals();
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
      if (t1) await ch.send(t1); else await ch.send('Geen data.');
      if (t2) await ch.send(t2); else await ch.send('Geen data.');
      if (t3) await ch.send(t3); else await ch.send('Geen data.');
      await i.editReply('✅ All-Time leaderboards gepost.');
      return;
    }

    if (i.commandName === 'lb_daily') {
      await i.deferReply({ ephemeral: true });
      const t = await renderWeeklyTop10();
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
      if (t) await ch.send(t); else await ch.send('Geen data.');
      await i.editReply('✅ Weekly Top 10 gepost.');
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

// ====== Planningen (automatisch posten in #leaderboard) ======
cron.schedule('0 20 * * 0', async () => { // Zondag 20:00
  try {
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

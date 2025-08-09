import { Client, GatewayIntentBits, Partials, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import pkg from 'pg';
import cron from 'node-cron';

const { Pool } = pkg;

// ==== ENV ====
const TOKEN = process.env.TOKEN;
const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID;
const TRADE_LOG_CHANNEL_ID = process.env.TRADE_LOG_CHANNEL_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;

// ==== DB ====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('amazonaws.com') ? { rejectUnauthorized: false } : false
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
      pnl NUMERIC NOT NULL,          -- percent (can be negative)
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ==== Discord client ====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// ==== Helpers ====
const mult = (n) => `${n}\u00D7`;                       // 35×
const money2 = (v) => `$${Number(v).toFixed(2)}`;        // $0.04
const pct = (p) => p.toFixed(2) + '%';                   // 12.34%
function calcPnl(side, entry, exit, lev){
  const e = Number(entry), x = Number(exit), L = Number(lev);
  const base = side.toLowerCase()==='short' ? (e - x)/e : (x - e)/e;
  return base * L * 100;
}

// exact reply line in INPUT
async function replyInInputChannel(message, {symbol, side, lev, pnl}) {
  const line = `Trade geregistreerd: ${symbol.toUpperCase()} ${side} ${mult(lev)} → \`${pct(pnl)}\``;
  await message.reply(line);
}

// exact log post
async function postTradeLog({author, symbol, side, entry, exit, lev, pnl}) {
  const header = `${author} \`${pct(pnl)}\``;
  const embed = new EmbedBuilder()
    .setDescription(
      `**${symbol.toUpperCase()} ${side} ${mult(lev)}**\n` +
      `**Entry:** ${money2(entry)}\n` +
      `**Exit:** ${money2(exit)}`
    );
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  await ch.send({ content: header, embeds: [embed] });
}

// save trade
async function saveTrade(t) {
  await pool.query(
    `INSERT INTO trades (user_id, username, symbol, side, entry, exit, leverage, pnl)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [t.userId, t.username, t.symbol.toUpperCase(), t.side, t.entry, t.exit, t.lev, t.pnl]
  );
}

// parse & handle for both !trade and /trade
async function handleTrade({userId, username, channelId, replyTo, symbol, side, entry, exit, lev}) {
  const pnl = calcPnl(side, entry, exit, lev);

  // input reply ONLY in the input channel
  if (channelId === INPUT_CHANNEL_ID && replyTo) {
    await replyInInputChannel(replyTo, {symbol, side, lev, pnl});
  }

  // log + db
  await saveTrade({userId, username, symbol, side, entry, exit, lev, pnl});
  await postTradeLog({author: username, symbol, side, entry, exit, lev, pnl});
}

// ==== Text command !trade ====
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
    const side = /^s/i.test(parts[3]) ? 'Short' : 'Long';
    const entry = Number(parts[4]);
    const exit  = Number(parts[5]);
    const lev   = parseInt(parts[6], 10);
    if ([entry, exit, lev].some(v => Number.isNaN(v))) {
      await message.reply('Formaat: `!trade add <SYM> <Long|Short> <entry> <exit> <leverage>`');
      return;
    }
    await handleTrade({
      userId: message.author.id,
      username: message.author.username,
      channelId: message.channel.id,
      replyTo: message,
      symbol, side, entry, exit, lev
    });
  } catch (e) {
    console.error('messageCreate error', e);
  }
});

// ==== Slash commands ====
client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    if (i.commandName === 'trade') {
      if (i.options.getString('actie') !== 'add') {
        await i.reply({ content: 'Alleen `add` wordt ondersteund.', ephemeral: true });
        return;
      }
      const symbol = i.options.getString('symbool');
      const side   = i.options.getString('zijde');
      const entry  = i.options.getNumber('entry');
      const exit   = i.options.getNumber('exit');
      const lev    = i.options.getInteger('leverage');
      await i.deferReply({ ephemeral: true }); // we antwoorden in kanaal via replyInInputChannel
      await handleTrade({
        userId: i.user.id,
        username: i.user.username,
        channelId: INPUT_CHANNEL_ID, // forceer dezelfde input‐style
        replyTo: await client.channels.fetch(INPUT_CHANNEL_ID).then(c=>({ reply: (t)=>c.send(t) , id:INPUT_CHANNEL_ID, channel:c, author:i.user, reply: (t)=>c.send(t)})),
        symbol, side, entry, exit, lev
      });
      await i.editReply('✅ Trade geregistreerd.');
    }
    if (i.commandName === 'leaderboard') {
      const sub = i.options.getSubcommand();
      await i.deferReply();
      let text = '';
      if (sub === 'alltime_gainers') text = await renderAllTime(true);
      if (sub === 'alltime_losers')  text = await renderAllTime(false);
      if (sub === 'totals')          text = await renderTotals();
      if (sub === 'weekly_top10')    text = await renderWeeklyTop10();
      await i.editReply({ content: text || 'Geen data.' });
    }
  } catch (e) {
    console.error('interaction error', e);
  }
});

// ==== Leaderboard helpers ====
function linePad(rank, name, v){
  const r = String(rank).padStart(2,' ');
  const n = name.length > 20 ? name.slice(0,20) : name;
  const s = (v>=0?'+':'') + v.toFixed(2) + '%';
  return `${r}. ${n}  ${s}`;
}

async function renderAllTime(isWinners){
  const order = isWinners ? 'DESC' : 'ASC';
  const sign  = isWinners ? '>=' : '<=';
  const { rows } = await pool.query(
    `SELECT username, pnl
     FROM trades
     WHERE pnl ${sign} 0
     ORDER BY pnl ${order}
     LIMIT 25`
  );
  if (!rows.length) return 'Geen data.';
  const title = isWinners ? '🏆 Top 25 All-time Winsten' : '💀 Top 25 All-time Verliezen';
  return '```' + [title, ...rows.map((r,idx)=>linePad(idx+1, r.username, Number(r.pnl)))].join('\n') + '```';
}

async function renderTotals(){
  const { rows } = await pool.query(
    `SELECT username, SUM(pnl) AS total
     FROM trades
     GROUP BY username
     ORDER BY SUM(pnl) DESC`
  );
  if (!rows.length) return 'Geen data.';
  return '```' + ['📊 Totale PnL % (best → worst)', ...rows.map((r,idx)=>linePad(idx+1, r.username, Number(r.total)))].join('\n') + '```';
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
  const lines = rows.map((r,idx)=>`${String(idx+1).padStart(2,' ')}. ${r.username} ${r.symbol} ${(Number(r.pnl)>=0?'+':'')+Number(r.pnl).toFixed(2)}%`);
  return '```' + ['📅 Top 10 Weekly Trades', ...lines].join('\n') + '```';
}

// ==== Schedulers ====
async function postToLeaderboard(text){
  if (!text) return;
  const ch = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  await ch.send(text);
}

cron.schedule('0 20 * * 0', async () => {        // Zondag 20:00
  try {
    const t1 = await renderAllTime(true);
    const t2 = await renderAllTime(false);
    const t3 = await renderTotals();
    await postToLeaderboard(t1);
    await postToLeaderboard(t2);
    await postToLeaderboard(t3);
  } catch (e) { console.error('weekly cron error', e); }
});

cron.schedule('0 9 * * *', async () => {         // Dagelijks 09:00
  try {
    const t = await renderWeeklyTop10();
    await postToLeaderboard(t);
  } catch (e) { console.error('daily cron error', e); }
});

// ==== Ready ====
client.once('ready', async () => {
  await initDb();
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(TOKEN);

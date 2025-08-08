import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  Colors
} from 'discord.js';
import cron from 'node-cron';

/* ====== ENV ====== */
const {
  DISCORD_TOKEN,
  INPUT_CHANNEL_ID,       // 1397658460211908801
  TRADE_LOG_CHANNEL_ID,   // 1395887706755829770
  LEADERBOARD_CHANNEL_ID, // 1395887166890184845
  TZ                      // Europe/Amsterdam
} = process.env;

if (!DISCORD_TOKEN || !INPUT_CHANNEL_ID || !TRADE_LOG_CHANNEL_ID || !LEADERBOARD_CHANNEL_ID) {
  console.error('Missing required env vars.');
  process.exit(1);
}

/* ====== CLIENT ====== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const PREFIX = '!'; // keep the legacy prefix

/* ====== HELPERS ====== */
const fmtMoney = v => `$${Number(v).toFixed(4)}`;
const signPct   = n => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const pill      = s => '`' + s + '`'; // inline-code bubble
const mult      = '×';

function parseTradeCommand(content) {
  // !trade add PENG Long 0.03674 0.03755 30
  const re = /^!trade\s+add\s+([A-Za-z0-9]+)\s+(Long|Short)\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)\s+([0-9]+)\s*$/i;
  const m = content.trim().match(re);
  if (!m) return null;
  const [, sym, sideRaw, entry, exit, lev] = m;
  const side = sideRaw.toLowerCase() === 'short' ? 'SHORT' : 'LONG';
  const leverage = parseInt(lev, 10);
  const entryN = Number(entry);
  const exitN  = Number(exit);
  if (!isFinite(entryN) || !isFinite(exitN) || !isFinite(leverage)) return null;

  // base pct (no leverage)
  const base = ((exitN - entryN) / entryN) * 100;
  const dir  = (side === 'SHORT') ? -1 : 1;
  const pnl  = base * dir * leverage;

  return {
    symbol: sym.toUpperCase(),
    side,
    entry: entryN,
    exit: exitN,
    leverage,
    pnl
  };
}

function buildInputAck({ symbol, side, leverage, pnl }) {
  // “Trade geregistreerd: **PENG** Long 30× → `+66.14%`”
  const sideNice = side === 'LONG' ? 'Long' : 'Short';
  return `Trade geregistreerd: **${symbol}** ${sideNice} ${leverage}${mult} → ${pill(signPct(pnl))}`;
}

function buildTradeLogMessage(username, { symbol, side, leverage, entry, exit, pnl }) {
  const header = `**${username}** ${pill(signPct(pnl))}`;
  const line2  = `${symbol} ${side} ${leverage}${mult}`;
  return `${header}\n${line2}\nEntry: ${fmtMoney(entry)}\nExit:  ${fmtMoney(exit)}`;
}

/** Parse one trade-log message back to {user, pnl, url, symbol, side, leverage, timestamp} */
function parseTradeLogPost(msg) {
  // we only parse our bot messages
  if (msg.author?.id !== client.user?.id) return null;

  const lines = msg.content.split('\n');
  // Expect:
  // **username** `+66.14%`
  // SYMBOL LONG 30×
  // Entry: $0.0000
  // Exit:  $0.0000
  if (lines.length < 2) return null;

  const m1 = lines[0].match(/\*\*(.+?)\*\*\s+`([+\-]?\d+(?:\.\d+)?)%`/);
  const m2 = lines[1].match(/^([A-Z0-9]+)\s+(LONG|SHORT)\s+(\d+)[×x]$/i);

  if (!m1 || !m2) return null;

  const user = m1[1];
  const pnl  = Number(m1[2]);
  const symbol = m2[1].toUpperCase();
  const side   = m2[2].toUpperCase();
  const lev    = parseInt(m2[3], 10);

  return {
    user,
    pnl,
    symbol,
    side,
    leverage: lev,
    url: msg.url,
    timestamp: msg.createdTimestamp
  };
}

async function fetchAllTradesFromLog() {
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  let lastId = null;
  const results = [];
  while (true) {
    const batch = await ch.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
    if (batch.size === 0) break;
    for (const [,m] of batch) {
      const t = parseTradeLogPost(m);
      if (t) results.push(t);
    }
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }
  return results;
}

function buildAllTimeEmbeds(trades) {
  const sorted = [...trades].sort((a,b) => b.pnl - a.pnl);
  const wins = sorted.slice(0, 25);
  const losses = [...trades].sort((a,b) => a.pnl - b.pnl).slice(0, 25);

  const makeLines = (arr) => arr.map((t, i) => {
    const rank = i + 1;
    const medal = rank === 1 ? '🥇 ' : rank === 2 ? '🥈 ' : rank === 3 ? '🥉 ' : `${rank}. `;
    const sideTxt = t.side === 'LONG' ? 'LONG' : 'SHORT';
    return `${medal}${signPct(t.pnl).padStart(8)} ${t.symbol} ${sideTxt} — by ${t.user} — [Trade](${t.url})`;
  }).join('\n');

  const e1 = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle('Top 25 All-Time winsten')
    .setDescription(makeLines(wins))
    .setFooter({ text: '[ANALYSEMAN-ALLTIME-WIN]' });

  const e2 = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle('Top 25 All-Time verliezen')
    .setDescription(makeLines(losses))
    .setFooter({ text: '[ANALYSEMAN-ALLTIME-LOSS]' });

  return [e1, e2];
}

function buildTotalsEmbed(trades) {
  const map = new Map();
  for (const t of trades) {
    map.set(t.user, (map.get(t.user) ?? 0) + t.pnl);
  }
  const rows = [...map.entries()]
    .sort((a,b) => b[1] - a[1])
    .map(([user,sum], i) => `${String(i+1).padStart(2,'.')} ${user} — ${signPct(sum)}`)
    .join('\n');

  return new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle('Trader Totals (All-Time)')
    .setDescription(rows || 'Geen trades gevonden.')
    .setFooter({ text: '[ANALYSEMAN-TOTALS]' });
}

function buildWeeklyEmbed(trades) {
  const weekAgo = Date.now() - 7*24*60*60*1000;
  const recent = trades.filter(t => t.timestamp >= weekAgo);
  const top10  = recent.sort((a,b)=>b.pnl - a.pnl).slice(0,10);
  const lines = top10.map((t,i)=> {
    const rank = i+1;
    return `${rank}. ${signPct(t.pnl).padStart(8)} ${t.symbol} ${t.side} — by ${t.user} — [Trade](${t.url})`;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('Top 10 Weekly (laatste 7 dagen)')
    .setDescription(lines || 'Geen geldige trades gevonden in de periode.')
    .setFooter({ text: '[ANALYSEMAN-WEEKLY]' });
}

/* ====== MESSAGE (prefix command) ====== */
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channelId !== INPUT_CHANNEL_ID) return;
    if (!msg.content.startsWith(`${PREFIX}trade`)) return;

    const parsed = parseTradeCommand(msg.content);
    if (!parsed) {
      await msg.reply('Ongeldige input. Gebruik: `!trade add SYMBOL SIDE ENTRY EXIT [LEVERAGE]` (bv. `!trade add PENG Long 0.03674 0.03755 30`)');
      return;
    }

    // Ack in #input
    const ack = buildInputAck(parsed);
    await msg.channel.send(ack);

    // Post in #trade-log
    const user = msg.author.username; // exact gebruikersnaam
    const tradeLog = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
    await tradeLog.send(buildTradeLogMessage(user, parsed));
  } catch (e) {
    console.error(e);
  }
});

/* ====== SLASH COMMANDS ====== */
client.on('interactionCreate', async (itx) => {
  if (!itx.isChatInputCommand()) return;

  if (itx.commandName === 'lb_alltime') {
    await itx.deferReply({ ephemeral: true });
    const trades = await fetchAllTradesFromLog();
    const [e1, e2] = buildAllTimeEmbeds(trades);
    const lb = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    await lb.send({ embeds: [e1] });
    await lb.send({ embeds: [e2] });
    await itx.editReply('All-time Top 25 gepost & gepind.');
  }

  if (itx.commandName === 'lb_weekly') {
    await itx.deferReply({ ephemeral: true });
    const trades = await fetchAllTradesFromLog();
    const e = buildWeeklyEmbed(trades);
    const lb = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    await lb.send({ embeds: [e] });
    await itx.editReply('Weekly Top 10 gepost & gepind.');
  }

  if (itx.commandName === 'totals') {
    await itx.deferReply({ ephemeral: true });
    const trades = await fetchAllTradesFromLog();
    const e = buildTotalsEmbed(trades);
    const lb = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    await lb.send({ embeds: [e] });
    await itx.editReply('Totals gepost & gepind.');
  }
});

/* ====== CRON SCHEDULES ====== */
// Zondag 20:00 → all-time + totals
cron.schedule('0 20 * * 0', async () => {
  try {
    const trades = await fetchAllTradesFromLog();
    const [e1, e2] = buildAllTimeEmbeds(trades);
    const t = buildTotalsEmbed(trades);
    const lb = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    await lb.send({ embeds: [e1] });
    await lb.send({ embeds: [e2] });
    await lb.send({ embeds: [t] });
  } catch (e) { console.error('cron alltime/totals', e); }
}, { timezone: TZ || 'Europe/Amsterdam' });

// Elke dag 09:00 → weekly top 10
cron.schedule('0 9 * * *', async () => {
  try {
    const trades = await fetchAllTradesFromLog();
    const e = buildWeeklyEmbed(trades);
    const lb = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
    await lb.send({ embeds: [e] });
  } catch (e) { console.error('cron weekly', e); }
}, { timezone: TZ || 'Europe/Amsterdam' });

/* ====== LOGIN ====== */
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});
client.login(DISCORD_TOKEN);

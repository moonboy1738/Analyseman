// ===== Dependencies =====
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import cron from 'node-cron';

// ===== ENV =====
const {
  DISCORD_TOKEN,
  INPUT_CHANNEL,          // 1397658460211908801
  TRADE_LOG_CHANNEL,      // 1395887706755829770
  LEADERBOARD_CHANNEL,    // 1395887166890184845
  TZ = 'Europe/Amsterdam'
} = process.env;

if (!DISCORD_TOKEN || !INPUT_CHANNEL || !TRADE_LOG_CHANNEL || !LEADERBOARD_CHANNEL) {
  console.error('ENV mist: DISCORD_TOKEN, INPUT_CHANNEL, TRADE_LOG_CHANNEL, LEADERBOARD_CHANNEL, TZ');
  process.exit(1);
}

// ===== Client =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ===== Helpers =====
const cap = (s) => (s ?? '').toString().trim().toUpperCase();
const normalizeNum = (s) => Number(String(s).trim().replace(',', '.'));
const money = (n) => `$${Number(n).toFixed(4)}`;
const fmtPct = (n) => `${n >= 0 ? '+' : ''}${Math.round(n * 100) / 100}%`;
const levTxt = (n) => `${n}×`;

// PnL in %, met leverage, LONG/SHORT
function calcPnl(entry, exit, side, lev) {
  if (entry <= 0 || !isFinite(entry) || !isFinite(exit)) return NaN;
  const raw = side === 'short'
    ? (entry - exit) / entry
    : (exit - entry) / entry;
  return raw * 100 * (lev || 1);
}

// robuuste parser voor onze 4-regelige trade posts in #trade-log
function parseTradeMessage(content) {
  // Verwacht:
  // 1: <username> <+/-xx.xx%>
  // 2: <SYMBOL> <SIDE> <LEV>×
  // 3: Entry: $0.0000
  // 4: Exit:  $0.0000
  const lines = content.split('\n').map((l) => l.trim());
  if (lines.length < 4) return null;

  const m1 = lines[0].match(/^(.+?)\s+([+\-]?\d+(?:\.\d+)?)%$/);
  const m2 = lines[1].match(/^([A-Z0-9:_-]+)\s+(LONG|SHORT)\s+(\d+)[x×]$/i);
  const m3 = lines[2].match(/^Entry:\s*\$?([0-9]+(?:\.[0-9]+)?)$/i);
  const m4 = lines[3].match(/^Exit:\s*\$?([0-9]+(?:\.[0-9]+)?)$/i);
  if (!m1 || !m2 || !m3 || !m4) return null;

  return {
    user: m1[1],
    pnl: Number(m1[2]),
    symbol: cap(m2[1]),
    side: m2[2].toLowerCase(),
    lev: Number(m2[3]),
    entry: Number(m3[1]),
    exit: Number(m4[1]),
    ts: null // vullen we bij ophalen bericht
  };
}

// alle trades uit #trade-log ophalen (pagineert door history)
async function fetchAllTrades() {
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL);
  let lastId = null;
  const trades = [];

  while (true) {
    const batch = await ch.messages.fetch({ limit: 100, before: lastId || undefined });
    if (batch.size === 0) break;

    for (const [, msg] of batch) {
      if (!msg.content) continue;
      const t = parseTradeMessage(msg.content);
      if (t) {
        t.ts = msg.createdTimestamp || Date.parse(msg.createdAt);
        trades.push(t);
      }
    }
    lastId = batch.last()?.id;
    if (!lastId) break;
    if (trades.length > 5000) break; // safety
  }

  return trades.sort((a, b) => a.ts - b.ts);
}

function rankList(items, limit = 25, desc = true) {
  const arr = [...items].sort((a, b) => desc ? b.pnl - a.pnl : a.pnl - b.pnl).slice(0, limit);
  return arr.map((t, i) =>
    `${String(i + 1).padStart(2, ' ')}. ${fmtPct(t.pnl).padStart(8, ' ')}  ${t.symbol.padEnd(6)}  ${t.side.toUpperCase().padEnd(5)}  ${String(t.lev).padStart(3)}×  —  ${t.user}`
  );
}

function lastDays(trades, days) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return trades.filter(t => t.ts >= since);
}

function totalsByUser(trades) {
  const map = new Map();
  for (const t of trades) {
    map.set(t.user, (map.get(t.user) || 0) + t.pnl);
  }
  return [...map.entries()].map(([user, pnl]) => ({ user, pnl }));
}

async function postAllTime() {
  const ch = await client.channels.fetch(LEADERBOARD_CHANNEL);
  const trades = await fetchAllTrades();
  if (trades.length === 0) {
    await ch.send('Geen trades gevonden.');
    return;
  }
  const wins = rankList(trades.filter(t => t.pnl !== 0).map(t => t), 25, true);
  const loss = rankList(trades.filter(t => t.pnl !== 0).map(t => t), 25, false);

  await ch.send('All-time Top 25 gepost & gepind.');
  await ch.send([
    '```',
    'Top 25 All-Time winsten',
    'Rank   PnL%    Sym   Side  Lev   Trader',
    '----------------------------------------',
    ...wins,
    '```'
  ].join('\n'));

  await ch.send([
    '```',
    'Top 25 All-Time verliezen',
    'Rank   PnL%    Sym   Side  Lev   Trader',
    '----------------------------------------',
    ...loss,
    '```'
  ].join('\n'));
}

async function postWeeklyTop10() {
  const ch = await client.channels.fetch(LEADERBOARD_CHANNEL);
  const trades = lastDays(await fetchAllTrades(), 7);
  if (trades.length === 0) {
    await ch.send('Geen trades in de laatste 7 dagen.');
    return;
  }
  const top = rankList(trades, 10, true);
  await ch.send([
    '```',
    'Top 10 (laatste 7 dagen)',
    'Rank   PnL%    Sym   Side  Lev   Trader',
    '----------------------------------------',
    ...top,
    '```'
  ].join('\n'));
}

async function postTotalsAllTime() {
  const ch = await client.channels.fetch(LEADERBOARD_CHANNEL);
  const trades = await fetchAllTrades();
  if (trades.length === 0) {
    await ch.send('Geen trades gevonden.');
    return;
  }
  const totals = totalsByUser(trades)
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 50)
    .map((t, i) => `${String(i + 1).padStart(2, ' ')}. ${fmtPct(t.pnl).padStart(8, ' ')}  ${t.user}`);

  await ch.send([
    '```',
    'Trader Totals (All-Time) — som van alle PnL%',
    'Rank   PnL%     Trader',
    '------------------------------',
    ...totals,
    '```'
  ].join('\n'));
}

// ===== Command handling =====
// Lossere regex – accepteert Long/long, extra spaties, en 30 of 30x/30×
const TRADE_CMD = /^!trade\s+add\b[\s:]*([A-Za-z0-9:_-]+)\s+(long|short)\s+([-\d.,]+)\s+([-\d.,]+)\s+(\d+)(?:x|×)?\b/i;

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;

    // Alleen in input-channel reageren op het add-commando
    if (msg.channelId === INPUT_CHANNEL) {
      const m = msg.content.match(TRADE_CMD);
      if (m) {
        const [, rawSym, rawSide, rawEntry, rawExit, rawLev] = m;
        const symbol = cap(rawSym);
        const side = rawSide.toLowerCase(); // long | short
        const entry = normalizeNum(rawEntry);
        const exit = normalizeNum(rawExit);
        const lev = parseInt(rawLev, 10);

        if ([entry, exit].some(Number.isNaN) || Number.isNaN(lev)) {
          await msg.reply('Ongeldige input. Gebruik: `!trade add SYMBOL SIDE ENTRY EXIT LEVERAGE` (bv. `!trade add PENG long 0.03674 0.03755 30`)');
          return;
        }

        const pnl = calcPnl(entry, exit, side, lev);

        // Bevestiging in #input (zelfde look & feel)
        await msg.channel.send(
          `Trade geregistreerd: **${symbol}** ${side.toUpperCase()} ${levTxt(lev)} → ${fmtPct(pnl)}`
        );

        // Plaats in #trade-log precies zoals jouw voorbeeld
        const tradeLog = await client.channels.fetch(TRADE_LOG_CHANNEL);
        const userShown = msg.member?.nickname || msg.author.username;
        const lines = [
          `${userShown} ${fmtPct(pnl)}`,
          `${symbol} ${side.toUpperCase()} ${levTxt(lev)}`,
          `Entry: ${money(entry)}`,
          `Exit: ${money(exit)}`
        ].join('\n');
        await tradeLog.send(lines);

        return; // klaar
      }
    }

    // Leaderboard/manual commands (mag overal, maar we limiteren tot leaderboard channel om spam te voorkomen)
    if (msg.channelId === LEADERBOARD_CHANNEL) {
      const txt = msg.content.trim().toLowerCase();
      if (txt === '!lb alltime' || txt === '!lb_alltime' || txt === '/lb_alltime') {
        await postAllTime();
        return;
      }
      if (txt === '!lb weekly' || txt === '!lb_weekly' || txt === '/lb_weekly') {
        await postWeeklyTop10();
        return;
      }
      if (txt === '!totals' || txt === '/totals') {
        await postTotalsAllTime();
        return;
      }
    }

  } catch (err) {
    console.error('messageCreate error:', err);
    try { await msg.reply('Kon je bericht niet verwerken. Check logs.'); } catch {}
  }
});

// ===== Schedules =====
// Dagelijks 09:00 -> weekly top 10
cron.schedule('0 9 * * *', async () => {
  try { await postWeeklyTop10(); } catch (e) { console.error('cron weekly 09:00', e); }
}, { timezone: TZ });

// Zondag 20:00 -> all-time win/loss + totals
cron.schedule('0 20 * * 0', async () => {
  try {
    await postAllTime();
    await postTotalsAllTime();
  } catch (e) { console.error('cron sunday 20:00', e); }
}, { timezone: TZ });

// ===== Startup =====
client.once('ready', () => {
  console.log(`Ingelogd als ${client.user.tag} — TZ: ${TZ}`);
});

client.login(DISCORD_TOKEN);

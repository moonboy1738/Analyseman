// index.js
// Analyseman – trade logger + leaderboards (prefix-commands)

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import cron from 'node-cron';

const {
  DISCORD_TOKEN,
  INPUT_CHANNEL,
  TRADE_LOG_CHANNEL,
  LEADERBOARD_CHANNEL,
  TZ = 'Europe/Amsterdam',
} = process.env;

if (!DISCORD_TOKEN || !INPUT_CHANNEL || !TRADE_LOG_CHANNEL || !LEADERBOARD_CHANNEL) {
  console.error('❌ Missing env vars: DISCORD_TOKEN / INPUT_CHANNEL / TRADE_LOG_CHANNEL / LEADERBOARD_CHANNEL');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const PREFIX = '!';

client.once('ready', async () => {
  console.log(`[Analyseman] Ingelogd als ${client.user.tag}`);
  console.log(`[Analyseman] TZ: ${TZ}`);

  // Cron: Daily Top 10 weekly (09:00)
  cron.schedule(
    '0 0 9 * * *',
    async () => {
      try {
        await postWeeklyTop10();
      } catch (e) {
        console.error('[Analyseman] Weekly top10 job error:', e);
      }
    },
    { timezone: TZ }
  );

  // Cron: Sunday 20:00 – All-time tops + Totals
  cron.schedule(
    '0 0 20 * * 0',
    async () => {
      try {
        await postAllTimeTops();
        await postTotalsAllTime();
      } catch (e) {
        console.error('[Analyseman] Sunday jobs error:', e);
      }
    },
    { timezone: TZ }
  );

  console.log('[Analyseman] Cron jobs geregistreerd.');
});

// ========== Utilities ==========

function toFixed2(n) {
  const sign = n < 0 ? -1 : 1;
  const val = Math.round(Math.abs(n) * 100) / 100;
  return (sign * val).toFixed(2);
}
function fmtUsd(n) {
  return `$${Number(n).toFixed(4)}`;
}
function asBold(s) {
  return `**${s}**`;
}
function normalizeSide(sideRaw) {
  const s = String(sideRaw || '').toLowerCase();
  if (s.startsWith('l')) return 'Long';
  if (s.startsWith('s')) return 'Short';
  return 'Long';
}
function normalizeSymbol(sym) {
  return String(sym || '').toUpperCase();
}
function parseLeverage(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^(\d+)(x)?$/i);
  return m ? parseInt(m[1], 10) : null;
}
function calcPnlPercent(entry, exit, side, lev) {
  // base return
  const base = ((exit - entry) / entry) * 100;
  const dir = side === 'Short' ? -1 : 1;
  const levBase = (base * dir) * (lev || 1);
  return levBase;
}

// Fetch all messages from trade-log (paginate)
async function fetchAllTradeLogMessages(channel) {
  const all = [];
  let lastId = undefined;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
    if (batch.size === 0) break;
    // Only messages by the bot (format we post) OR historically similar layout
    for (const [, msg] of batch) {
      all.push(msg);
    }
    lastId = batch.last().id;
    // Safety limit to avoid insane loops
    if (all.length > 5000) break;
  }
  return all;
}

// Parse our trade card from message content
// Expected layout:
// **username**  +12.34%
// SYMBOL Long 35×
// Entry: $0.03674
// Exit:  $0.03755
function parseTradeFromContent(msg) {
  const lines = msg.content.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 4) return null;

  // line 1: **username**  +12.34%
  const l1 = lines[0];
  const uMatch = l1.match(/\*\*(.+?)\*\*/);
  const pMatch = l1.match(/([+\-]?\d+(\.\d+)?)%/);
  const username = uMatch ? uMatch[1] : null;
  const pnl = pMatch ? parseFloat(pMatch[1]) : null;

  // line 2: SYMBOL Long 35×
  const l2 = lines[1];
  const sMatch = l2.match(/^([A-Z.\-]+)\s+(Long|Short)\s+(\d+)×$/i);
  if (!sMatch) return null;
  const symbol = sMatch[1].toUpperCase();
  const side = sMatch[2] === 'Short' ? 'Short' : 'Long';
  const lev = parseInt(sMatch[3], 10);

  // line 3: Entry: $0.0000
  const l3 = lines[2];
  const eMatch = l3.match(/Entry:\s*\$(\d+(\.\d+)?)/i);
  const entry = eMatch ? parseFloat(eMatch[1]) : null;

  // line 4: Exit:  $0.0000
  const l4 = lines[3];
  const xMatch = l4.match(/Exit:\s*\$(\d+(\.\d+)?)/i);
  const exit = xMatch ? parseFloat(xMatch[1]) : null;

  if (!username || pnl === null || entry === null || exit === null || !lev) {
    return null;
  }
  return {
    username,
    pnl,
    symbol,
    side,
    lev,
    entry,
    exit,
    createdAt: msg.createdAt,
    url: msg.url,
  };
}

// Helpers to build leaderboards
function topNTrades(trades, n, pick = 'best') {
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  return pick === 'worst' ? sorted.slice(-n).reverse() : sorted.slice(0, n);
}
function withinDays(trade, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return trade.createdAt.getTime() >= cutoff;
}
function sumByUser(trades) {
  const map = new Map();
  for (const t of trades) {
    map.set(t.username, (map.get(t.username) || 0) + t.pnl);
  }
  const out = [];
  for (const [user, total] of map.entries()) out.push({ user, total });
  out.sort((a, b) => b.total - a.total);
  return out;
}

// ========== Command handling ==========

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channelId !== INPUT_CHANNEL) return;

    const content = message.content.trim();
    if (!content.startsWith(PREFIX)) return;

    const args = content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = args.shift()?.toLowerCase();

    if (cmd !== 'trade') return;

    const sub = (args.shift() || '').toLowerCase();

    if (sub !== 'add') {
      await message.reply('Gebruik: `!trade add SYMBOL Side Entry Exit Leverage` (bv. `!trade add PENG Long 0.03674 0.03755 30`)');
      return;
    }

    // Expect leverage at the end. But support both orders.
    // Try pattern: SYMBOL SIDE ENTRY EXIT LEV
    let [symbolRaw, sideRaw, entryRaw, exitRaw, levRaw] = args;
    // If user typed leverage before exit (old habit), swap.
    if (levRaw && !/^\d+x?$/i.test(levRaw) && exitRaw && /^\d+x?$/i.test(exitRaw)) {
      // they did: SYMBOL SIDE ENTRY LEV EXIT
      [symbolRaw, sideRaw, entryRaw, levRaw, exitRaw] = args;
    }

    const symbol = normalizeSymbol(symbolRaw);
    const side = normalizeSide(sideRaw);
    const entry = parseFloat(entryRaw);
    const exit = parseFloat(exitRaw);
    const lev = parseLeverage(levRaw);

    if (!symbol || !(side === 'Long' || side === 'Short') || !isFinite(entry) || !isFinite(exit) || !lev) {
      await message.reply('Ongeldige input. Gebruik: `!trade add SYMBOL Side Entry Exit Leverage` (bv. `!trade add PENG Long 0.03674 0.03755 30`)');
      return;
    }

    const pnl = calcPnlPercent(entry, exit, side, lev);
    const pnlStr = `${pnl >= 0 ? '+' : ''}${toFixed2(pnl)}%`;

    // Post to trade-log with exact formatting + bold username
    const tradeLog = await client.channels.fetch(TRADE_LOG_CHANNEL);
    const usernameToShow = message.author.username; // volledige username zoals “moonboy1738”
    const card =
`${asBold(usernameToShow)}  ${pnlStr}
${symbol} ${side} ${lev}×
Entry: ${fmtUsd(entry)}
Exit:  ${fmtUsd(exit)}`;

    const posted = await tradeLog.send(card);

    // Confirm in input
    await message.reply(
      `Trade geregistreerd: ${symbol} ${side} ${lev}× → ${pnlStr}\nEntry: ${fmtUsd(entry)} / Exit: ${fmtUsd(exit)}\n[Trade](${posted.url})`
    );

  } catch (e) {
    console.error('[Analyseman] messageCreate error:', e);
    try { await message.reply('Er ging iets mis bij het verwerken van deze trade.'); } catch {}
  }
});

// ========== Leaderboard jobs ==========

async function parseAllTrades() {
  const tradeLog = await client.channels.fetch(TRADE_LOG_CHANNEL);
  const msgs = await fetchAllTradeLogMessages(tradeLog);
  const trades = [];
  for (const m of msgs) {
    // alleen onze kaarten (die **username** / SYMBOL lijn bevatten)
    if (!m.content || !m.content.includes('Entry:') || !m.content.includes('×')) continue;
    const t = parseTradeFromContent(m);
    if (t) trades.push(t);
  }
  return trades;
}

function buildListLines(trades) {
  return trades.map((t, i) => {
    const rank = (i + 1).toString().padStart(2, ' ');
    const sign = t.pnl >= 0 ? '+' : '';
    return `${rank}. ${sign}${toFixed2(t.pnl)}% ${t.symbol} ${t.side.toUpperCase()} — by ${t.username} — [Trade](${t.url})`;
  });
}

async function postAllTimeTops() {
  const lbChan = await client.channels.fetch(LEADERBOARD_CHANNEL);
  const trades = await parseAllTrades();
  if (trades.length === 0) {
    await lbChan.send('Geen geldige trades gevonden in de periode.');
    return;
  }
  // Best 25
  const best25 = topNTrades(trades, 25, 'best');
  // Worst 25
  const worst25 = topNTrades(trades, 25, 'worst');

  const bestMsg =
`**Top 25 All-Time winsten**
\`\`\`
Rank  PnL%   Sym  Side  Trader
--------------------------------
\`\`\`
${buildListLines(best25).join('\n')}
[ANALYSEMAN-ALLTIME-WIN]`;

  const worstMsg =
`**Top 25 All-Time verliezen**
\`\`\`
Rank  PnL%   Sym  Side  Trader
--------------------------------
\`\`\`
${buildListLines(worst25).join('\n')}
[ANALYSEMAN-ALLTIME-LOSS]`;

  const m1 = await lbChan.send(bestMsg);
  const m2 = await lbChan.send(worstMsg);
  try { await m1.pin(); } catch {}
  try { await m2.pin(); } catch {}
}

async function postWeeklyTop10() {
  const lbChan = await client.channels.fetch(LEADERBOARD_CHANNEL);
  const trades = await parseAllTrades();
  const weekly = trades.filter(t => withinDays(t, 7));
  if (weekly.length === 0) {
    await lbChan.send('Geen geldige trades gevonden in de afgelopen 7 dagen.');
    return;
  }
  const best10 = topNTrades(weekly, 10, 'best');
  const msg =
`**Top 10 prestaties – afgelopen 7 dagen**
\`\`\`
Rank  PnL%   Sym  Side  Trader
--------------------------------
\`\`\`
${buildListLines(best10).join('\n')}
[ANALYSEMAN-WEEKLY]`;
  const m = await lbChan.send(msg);
  try { await m.pin(); } catch {}
}

async function postTotalsAllTime() {
  const lbChan = await client.channels.fetch(LEADERBOARD_CHANNEL);
  const trades = await parseAllTrades();
  if (trades.length === 0) {
    await lbChan.send('Geen geldige trades gevonden voor totals.');
    return;
  }
  const totals = sumByUser(trades).slice(0, 50); // top 50 users indien veel traders
  const lines = totals.map((t, i) => {
    const rank = (i + 1).toString().padStart(2, ' ');
    const sign = t.total >= 0 ? '+' : '';
    return `${rank}. ${sign}${toFixed2(t.total)}% — ${t.user}`;
  });

  const msg =
`**Trader Totals (All-Time)**
\`\`\`
Rank  Total PnL%  Trader
-------------------------
\`\`\`
${lines.join('\n')}
[ANALYSEMAN-TOTALS]`;
  const m = await lbChan.send(msg);
  try { await m.pin(); } catch {}
}

// ========== Start ==========
client.login(DISCORD_TOKEN);

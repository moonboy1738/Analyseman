// index.js
// Analyseman – complete bot
// Node 18+, discord.js v14

require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const cron = require('node-cron');

const TOKEN      = process.env.DISCORD_TOKEN;
const INPUT_CH   = process.env.INPUT_CHANNEL;       // 🖊️∣-input
const TRADE_CH   = process.env.TRADE_LOG_CHANNEL;   // 📝∣-trade-log
const LB_CH      = process.env.LEADERBOARD_CHANNEL; // 🥇∣-leaderboard
const TZ         = process.env.TZ || 'Europe/Amsterdam';

if (!TOKEN || !INPUT_CH || !TRADE_CH || !LB_CH) {
  console.error('[Analyseman] Missing ENV vars: DISCORD_TOKEN / INPUT_CHANNEL / TRADE_LOG_CHANNEL / LEADERBOARD_CHANNEL');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ---------- helpers ----------
function fmtNum(n, d = 2) {
  const x = Number(n);
  if (!isFinite(x)) return n;
  return x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtUsd(n) { return `$${fmtNum(n, 4)}`; }
function signPct(n, d = 2) {
  const v = Number(n);
  const s = (v > 0 ? '+' : '') + v.toFixed(d) + '%';
  return s;
}

// leverage-aware PnL
function calcPnlPercent(entry, exit, side, lev) {
  const e = Number(entry), x = Number(exit), L = Math.abs(Number(lev) || 1);
  if (!isFinite(e) || e === 0 || !isFinite(x)) return 0;
  let raw = ((x - e) / e) * 100;
  if (String(side).toLowerCase() === 'short') raw = -raw;
  return raw * L;
}

// maak een nette embed voor trade-log
function buildTradeLogEmbed({ username, pnlPct, symbol, side, lev, entry, exit }) {
  const title = `**${username}** — ${signPct(pnlPct)}`;
  const desc =
    `${symbol.toUpperCase()} ${side.toUpperCase()} ${lev}×\n` +
    `Entry: ${fmtUsd(entry)}\n` +
    `Exit:  ${fmtUsd(exit)}`;
  const color =
    pnlPct > 0 ? 0x22c55e : pnlPct < 0 ? 0xef4444 : 0x999999;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(desc)
    .setFooter({ text: 'ANALYSEMAN-TRADE' })
    .setTimestamp(new Date());
}

// Input-channel bevestiging (klein kaartje)
function buildInputAckEmbed({ symbol, side, lev, pnlPct, entry, exit }) {
  const color =
    pnlPct > 0 ? 0x22c55e : pnlPct < 0 ? 0xef4444 : 0x999999;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`Trade geregistreerd: ${symbol.toUpperCase()} ${side.toUpperCase()} ${lev}× → ${signPct(pnlPct)}`)
    .setDescription(`Entry: ${fmtUsd(entry)} / Exit: ${fmtUsd(exit)}`)
    .setFooter({ text: 'ANALYSEMAN-INPUT' })
    .setTimestamp(new Date());
}

// --------- parsing van trade-log berichten (door deze bot geplaatst) ----------
const TRADE_RE = {
  // Titel: **username** — +12.34%
  title: /^\*\*(.+?)\*\*\s+—\s+([+\-]?\d+(?:\.\d+)?)%$/i,
  // Body-lijnen:
  // SYMBOL SIDE L×
  // Entry: $x
  // Exit:  $y
  body1: /^([A-Z0-9]+)\s+(LONG|SHORT)\s+(\d+)×$/i,
  bodyEntry: /^Entry:\s*\$?([\d.]+)$/i,
  bodyExit: /^Exit:\s*\$?([\d.]+)$/i,
};

function parseTradeFromEmbed(embed) {
  if (!embed?.title || !embed?.description) return null;
  const t = embed.title.trim();
  const mTitle = t.match(TRADE_RE.title);
  if (!mTitle) return null;
  const username = mTitle[1];
  const pnlPct = Number(mTitle[2]);

  const lines = embed.description.split(/\r?\n/).map(s => s.trim());
  const mB1 = lines[0]?.match(TRADE_RE.body1);
  const mEn = lines[1]?.match(TRADE_RE.bodyEntry);
  const mEx = lines[2]?.match(TRADE_RE.bodyExit);
  if (!mB1 || !mEn || !mEx) return null;

  return {
    username,
    pnlPct,
    symbol: mB1[1].toUpperCase(),
    side: mB1[2].toUpperCase(),
    lev: Number(mB1[3]),
    entry: Number(mEn[1]),
    exit: Number(mEx[1]),
  };
}

async function fetchAllTradesFromLogChannel() {
  const ch = await client.channels.fetch(TRADE_CH);
  if (!ch) return [];
  let before;
  const out = [];

  while (true) {
    const msgs = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!msgs || msgs.size === 0) break;
    for (const [, msg] of msgs) {
      if (!msg.embeds?.length) continue;
      // pak de 1e embed
      const trade = parseTradeFromEmbed(msg.embeds[0].data ?? msg.embeds[0]);
      if (trade) {
        trade.ts = msg.createdTimestamp;
        trade.msgUrl = msg.url;
        out.push(trade);
      }
    }
    before = msgs.last()?.id;
    if (!before) break;
  }
  return out;
}

// helpers leaderboard/totals
function pad(str, len) {
  const s = String(str);
  if (s.length >= len) return s;
  return s + ' '.repeat(len - s.length);
}
function fmtRow(rank, pct, sym, side, lev, user) {
  return `${pad(rank+'.', 4)} ${pad(signPct(pct), 8)} ${pad(sym, 5)} ${pad(side, 5)} ${pad(lev+'×', 4)} — ${user}`;
}
function codeBlock(lines) {
  return '```' + 'text' + '\n' + lines.join('\n') + '\n```';
}

// --------- Leaderboards & Totals ----------
async function postAllTimeLeaderboards() {
  const ch = await client.channels.fetch(LB_CH);
  if (!ch) return;
  const trades = await fetchAllTradesFromLogChannel();
  if (trades.length === 0) {
    await ch.send({ content: 'Top 25 All-Time: geen trades gevonden.' });
    return;
  }
  const wins = [...trades].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 25);
  const loss = [...trades].sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 25);

  const winLines = wins.map((t, i) =>
    `${pad((i+1)+'.', 4)} ${pad(signPct(t.pnlPct), 8)} ${pad(t.symbol,5)} ${pad(t.side,5)} ${pad(t.lev+'×',4)} — door ${t.username}  —  [Trade](${t.msgUrl})`
  );
  const lossLines = loss.map((t, i) =>
    `${pad((i+1)+'.', 4)} ${pad(signPct(t.pnlPct), 8)} ${pad(t.symbol,5)} ${pad(t.side,5)} ${pad(t.lev+'×',4)} — door ${t.username}  —  [Trade](${t.msgUrl})`
  );

  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('Top 25 All-Time winsten')
        .setDescription(codeBlock(winLines))
        .setFooter({ text: 'ANALYSEMAN-ALLTIME-WIN' })
        .setTimestamp(),
    ]
  });
  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle('Top 25 All-Time verliezen')
        .setDescription(codeBlock(lossLines))
        .setFooter({ text: 'ANALYSEMAN-ALLTIME-LOSS' })
        .setTimestamp(),
    ]
  });
}

async function postWeeklyTop10Daily() {
  const ch = await client.channels.fetch(LB_CH);
  if (!ch) return;
  const trades = await fetchAllTradesFromLogChannel();
  const cutoff = Date.now() - 7*24*60*60*1000;
  const within = trades.filter(t => t.ts >= cutoff);
  if (within.length === 0) {
    await ch.send({ content: 'Top 10 Weekly: geen trades gevonden in de laatste 7 dagen.' });
    return;
  }
  const top = [...within].sort((a, b) => Math.abs(b.pnlPct) - Math.abs(a.pnlPct)).slice(0, 10);
  const lines = top.map((t, i) =>
    `${pad((i+1)+'.', 4)} ${pad(signPct(t.pnlPct), 8)} ${pad(t.symbol,5)} ${pad(t.side,5)} ${pad(t.lev+'×',4)} — door ${t.username} — [Trade](${t.msgUrl})`
  );
  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x2563eb)
        .setTitle('Top 10 Weekly (laatste 7 dagen)')
        .setDescription(codeBlock(lines))
        .setFooter({ text: 'ANALYSEMAN-WEEKLY' })
        .setTimestamp(),
    ]
  });
}

async function postTotalsAllTime() {
  const ch = await client.channels.fetch(LB_CH);
  if (!ch) return;
  const trades = await fetchAllTradesFromLogChannel();
  if (trades.length === 0) {
    await ch.send({ content: 'Trader Totals: geen trades gevonden.' });
    return;
  }
  const byUser = new Map();
  for (const t of trades) {
    byUser.set(t.username, (byUser.get(t.username) || 0) + t.pnlPct);
  }
  const rows = [...byUser.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([user, sum], i) => `${pad((i+1)+'.', 4)} ${pad(signPct(sum), 10)} — ${user}`);

  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x8b5cf6)
        .setTitle('Trader Totals (All-Time)')
        .setDescription(codeBlock(rows))
        .setFooter({ text: 'ANALYSEMAN-TOTALS' })
        .setTimestamp(),
    ]
  });
}

// ---------- message handler: !trade add SYMBOL SIDE ENTRY EXIT LEV ----------
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channelId !== INPUT_CH) return;

    const content = msg.content.trim();

    // Alleen prefix "!" en exact patroon "trade add SYMBOL Side Entry Exit Leverage"
    const m = content.match(/^!trade\s+add\s+([A-Za-z0-9]+)\s+(long|short)\s+([\d.]+)\s+([\d.]+)\s+(\d+)$/i);
    if (!m) return; // negeer andere berichten

    const symbol = m[1].toUpperCase();
    const side   = m[2].toUpperCase();
    const entry  = Number(m[3]);
    const exit   = Number(m[4]);
    const lev    = Number(m[5]);

    const pnlPct = calcPnlPercent(entry, exit, side, lev);

    // 1) bevestiging terug in 🖊️∣-input
    const ack = buildInputAckEmbed({ symbol, side, lev, pnlPct, entry, exit });
    await msg.channel.send({ embeds: [ack] });

    // 2) post naar 📝∣-trade-log in exact format (via embed met vetgedrukte username)
    const tradeCh = await client.channels.fetch(TRADE_CH);
    const username = msg.author.username; // volledige gebruikersnaam (geen afkorting)
    const emb = buildTradeLogEmbed({ username, pnlPct, symbol, side, lev, entry, exit });
    await tradeCh.send({ embeds: [emb] });

  } catch (e) {
    console.error('[Analyseman] messageCreate error:', e);
  }
});

// ---------- CRON JOBS ----------
// Dagelijks 09:00 (local TZ) -> Top 10 Weekly
cron.schedule('0 9 * * *', () => {
  postWeeklyTop10Daily().catch(console.error);
}, { timezone: TZ });

// Zondag 20:00 -> All-Time leaderboards (Top 25 win/loss) + Trader Totals
cron.schedule('0 20 * * 0', () => {
  postAllTimeLeaderboards().catch(console.error);
  postTotalsAllTime().catch(console.error);
}, { timezone: TZ });

// ---------- ready ----------
client.once('ready', async () => {
  console.log(`[Analyseman] Ingelogd als ${client.user.tag}`);
  console.log(`[Analyseman] Cron jobs actief, TZ: ${TZ}`);
});

client.login(TOKEN);

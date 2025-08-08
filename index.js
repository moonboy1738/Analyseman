// ===== Analyseman — leaderboard clean format + names (CommonJS) =====
const cron = require('node-cron');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');

const TRADE_LOG_ID = process.env.TRADE_LOG_CHANNEL || '1395887706755829770';
const LEADERBOARD_ID = process.env.LEADERBOARD_CHANNEL || '1395887166890184845';
const TZ = process.env.TZ || 'Europe/Amsterdam';
const GUILD_ID = process.env.GUILD_ID || process.env.SERVER_ID || null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ---------------- helpers ----------------
async function fetchAllMessages(channel, days = null) {
  const out = [];
  let lastId;
  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

  while (true) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const batch = await channel.messages.fetch(opts);
    if (batch.size === 0) break;

    for (const m of batch.values()) {
      if (cutoff && m.createdTimestamp < cutoff) return out;
      out.push(m);
    }
    lastId = batch.last().id;
  }
  return out;
}

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function normalizeNumber(raw) {
  if (raw == null) return null;
  const s = String(raw)
    .replace(/\s+/g, '')
    .replace(/[’‘‚]/g, "'")
    .replace(/[€$]/g, '')
    .replace(/(?<=\d)[._](?=\d{3}\b)/g, '') // 1.000 -> 1000
    .replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function expandK(n) {
  if (typeof n !== 'string') return n;
  const m = n.match(/^([\-+]?\d+(?:[.,]\d+)?)[kK]$/);
  if (!m) return n;
  const base = normalizeNumber(m[1]);
  return base != null ? String(base * 1000) : n;
}
function computePnlPercent({ side, entry, exit }) {
  if (![entry, exit].every(Number.isFinite)) return null;
  const change = (exit - entry) / entry;
  const directional = side?.toUpperCase() === 'SHORT' ? -change : change;
  return directional * 100;
}
function cleanContent(content) {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`/g, ' ')
    .replace(/\*\*/g, ' ')
    .replace(/<:[A-Za-z0-9_]+:\d+>/g, ' ')
    .replace(/<@!?&?\d+>/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
}

// ---- better PnL extraction ----
function extractPnl(raw, side, entry, exit) {
  // 1) labels
  const labeled = raw.match(/\b(pnl|p&l|roi|return)\b[^%\-+]*([-+]?[\d.,]+)\s*%/i);
  if (labeled) {
    const val = normalizeNumber(labeled[2]);
    if (Number.isFinite(val) && Math.abs(val) <= 1000) return val;
  }
  // 2) compute from entry/exit
  if (side && entry != null && exit != null) {
    const val = computePnlPercent({ side, entry, exit });
    if (Number.isFinite(val) && Math.abs(val) <= 1000) return val;
  }
  // 3) single percent in text
  const all = [...raw.matchAll(/([-+]?[\d.,]+)\s*%/g)].map(m => normalizeNumber(m[1])).filter(Number.isFinite);
  if (all.length === 1 && Math.abs(all[0]) <= 1000) return all[0];

  // 4) otherwise give up (we vermijden noise zoals “24h +3.2%”)
  return null;
}

// ---- ultra-lenient parser with username ----
function parseTrade(msg) {
  const raw = cleanContent(msg.content);
  if (!raw) return null;

  const trader =
    msg.member?.displayName ||
    msg.author?.globalName ||
    msg.author?.username ||
    'Onbekend';

  const sideMatch = raw.match(/\b(LONG|SHORT)\b/i);
  const side = sideMatch ? sideMatch[1].toUpperCase() : null;

  // Prefer symbols like BTC, ETH, SOL, or BTCUSDT/ETHUSD, trim suffixes
  let symbol = null;
  const sym = raw.match(/\b([A-Z]{2,10})(?:-?PERP|USDT|USD|USDC)?\b/) || raw.match(/\b([A-Z]{2,10})\/[A-Z]{2,6}\b/);
  if (sym) {
    symbol = (sym[1] || sym[0]).toUpperCase().replace(/[^A-Z]/g, '');
    symbol = symbol.replace(/(USDT|USD|USDC)$/, '');
  }

  const entryWord = raw.match(/\b(entry|ingang|open|in)\b[:\s-]*([\-+]?[\d.,kK]+)/i);
  const exitWord  = raw.match(/\b(exit|close|out|sluit)\b[:\s-]*([\-+]?[\d.,kK]+)/i);
  const entry = entryWord ? normalizeNumber(expandK(entryWord[2])) : null;
  const exit  = exitWord  ? normalizeNumber(expandK(exitWord[2]))  : null;

  const levMatch = raw.match(/(\d+(?:[.,]\d+)?)\s*x\b/i);
  const lev = levMatch ? normalizeNumber(levMatch[1]) : null;

  let pnl = extractPnl(raw, side, entry, exit);
  if (pnl == null || !Number.isFinite(pnl)) return null;

  // safety clamp to avoid garbage outliers
  pnl = clamp(pnl, -1000, 1000);

  const guildId = msg.guild?.id || '000000000000000000';
  const link = `https://discord.com/channels/${guildId}/${msg.channelId}/${msg.id}`;

  return { id: msg.id, link, trader, side, symbol, entry, exit, lev, pnl, ts: msg.createdTimestamp };
}

// --------------- leaderboard ---------------
function pad(n, len) {
  const s = String(n);
  return s.length >= len ? s : '0'.repeat(len - s.length) + s;
}

function fmtLine(t, i) {
  // Example: 01) -12.34%  BTC  SHORT  5x  by MoonBoy — Trade
  const rank = pad(i + 1, 2);
  const pnl = `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}%`;
  const parts = [
    `${rank}) ${pnl}`,
    t.symbol ? t.symbol : '—',
    t.side || '—',
    t.lev ? `${t.lev}x` : null,
    `by ${t.trader}`,
    `[Trade](${t.link})`,
  ].filter(Boolean);
  return parts.join('  ·  ');
}

async function buildLeaderboard(days = 7, topN = 10, wins = true) {
  const channel = await client.channels.fetch(TRADE_LOG_ID);
  const messages = await fetchAllMessages(channel, days);
  const trades = messages.map(parseTrade).filter(t => t && Number.isFinite(t.pnl));

  const sorted = trades.sort((a, b) => wins ? b.pnl - a.pnl : a.pnl - b.pnl);
  const top = sorted.slice(0, topN); // altijd exact topN (als er genoeg zijn)

  const lines = top.map((t, i) => fmtLine(t, i));
  const desc = lines.join('\n').slice(0, 3900) || '_Geen geldige trades gevonden in de periode._';

  const embed = new EmbedBuilder()
    .setColor(wins ? 0x2ecc71 : 0xe74c3c)
    .setTitle(wins
      ? `Top ${topN} ${days ? `${days}-daagse` : 'All-Time'} winsten`
      : `Top ${topN} ${days ? `${days}-daagse` : 'All-Time'} verliezen`
    )
    .setDescription(desc)
    .setFooter({ text: wins ? (days ? '[ANALYSEMAN-DAILY]' : '[ANALYSEMAN-ALLTIME-WIN]') : (days ? '[ANALYSEMAN-DAILY-LOSS]' : '[ANALYSEMAN-ALLTIME-LOSS]') })
    .setTimestamp();

  return embed;
}

async function postAndPin(embed, tag) {
  const lb = await client.channels.fetch(LEADERBOARD_ID);
  const pins = await lb.messages.fetchPinned();
  const old = pins.find(p => p.embeds[0]?.footer?.text === tag);
  if (old) await old.unpin().catch(() => {});
  const sent = await lb.send({ embeds: [embed] });
  await sent.pin().catch(() => {});
}

async function runWeeklyTop10() {
  const wins = await buildLeaderboard(7, 10, true);
  await postAndPin(wins, '[ANALYSEMAN-DAILY]');
}
async function runAllTimeTop50() {
  const wins = await buildLeaderboard(null, 50, true);
  const losses = await buildLeaderboard(null, 50, false);
  await postAndPin(wins, '[ANALYSEMAN-ALLTIME-WIN]');
  await postAndPin(losses, '[ANALYSEMAN-ALLTIME-LOSS]');
}

// --------------- ready ---------------
client.once('ready', async () => {
  console.log(`[Analyseman] Ingelogd als ${client.user.tag}`);

  const tradeLog = await client.channels.fetch(TRADE_LOG_ID);
  const leaderboard = await client.channels.fetch(LEADERBOARD_ID);
  const me = await leaderboard.guild.members.fetch(client.user.id);

  const need = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ManageMessages,
  ];
  const okTrade = need.every(p => tradeLog.permissionsFor(me)?.has(p));
  const okLB = need.every(p => leaderboard.permissionsFor(me)?.has(p));
  console.log(`[Analyseman] Perms trade-log OK: ${okTrade}, leaderboard OK: ${okLB}`);

  cron.schedule('0 9 * * *', async () => {
    console.log('[Analyseman] Trigger: daily weekly top10 (09:00 Europe/Amsterdam)');
    try { await runWeeklyTop10(); console.log('[Analyseman] Daily top10 posted.'); }
    catch (e) { console.error('[Analyseman] Daily job error:', e); }
  }, { timezone: TZ });

  cron.schedule('0 20 * * 0', async () => {
    console.log('[Analyseman] Trigger: all-time top50 (zondag 20:00 Europe/Amsterdam)');
    try { await runAllTimeTop50(); console.log('[Analyseman] All-time top50 posted.'); }
    catch (e) { console.error('[Analyseman] Weekly job error:', e); }
  }, { timezone: TZ });

  console.log('[Analyseman] Cron jobs registered with timezone:',

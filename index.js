// ===== Analyseman — stabiele fetch, strakke leaderboards, namen + async replies =====
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

// ---- Config uit Heroku (met fallbacks) ----
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

// ---------- Utils ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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

// ---------- Messages fetch (rate-limit safe) ----------
async function fetchAllMessages(channel, days = null) {
  const out = [];
  let lastId;
  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

  while (true) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;

    const batch = await channel.messages.fetch(opts);
    if (batch.size === 0) break;

    // push while respecting cutoff
    for (const m of batch.values()) {
      if (cutoff && m.createdTimestamp < cutoff) return out;
      out.push(m);
    }
    lastId = batch.last().id;

    // kleine pauze om rate-limits te vermijden
    await sleep(250);
  }
  return out;
}

// ---------- PnL extraction ----------
function extractPnl(raw, side, entry, exit) {
  // 1) labels
  const labeled = raw.match(/\b(pnl|p&l|roi|return)\b[^%\-+]*([-+]?[\d.,]+)\s*%/i);
  if (labeled) {
    const val = normalizeNumber(labeled[2]);
    if (Number.isFinite(val) && Math.abs(val) <= 2000) return val;
  }
  // 2) compute from entry/exit
  if (side && entry != null && exit != null) {
    const val = computePnlPercent({ side, entry, exit });
    if (Number.isFinite(val) && Math.abs(val) <= 2000) return val;
  }
  // 3) één enkel percentage in tekst
  const all = [...raw.matchAll(/([-+]?[\d.,]+)\s*%/g)]
    .map(m => normalizeNumber(m[1]))
    .filter(Number.isFinite);
  if (all.length === 1 && Math.abs(all[0]) <= 2000) return all[0];

  return null;
}

// ---------- Parser (lenient + namen) ----------
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

  // symbol (BTC, ETH, SOL, BTCUSDT, ETH/USD, etc.) – strip suffixes
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

  pnl = clamp(pnl, -2000, 2000);

  const guildId = msg.guild?.id || '000000000000000000';
  const link = `https://discord.com/channels/${guildId}/${msg.channelId}/${msg.id}`;

  return { id: msg.id, link, trader, side, symbol, entry, exit, lev, pnl, ts: msg.createdTimestamp };
}

// ---------- Leaderboard ----------
function padLeft(str, len) {
  const s = String(str);
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}
function padRight(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}
function medal(i) {
  return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : padLeft(i + 1, 2) + '.';
}

function formatRows(trades) {
  // kolommen: Rank | PnL% | Sym | Side | Lev | Trader | Link
  const lines = [];
  lines.push('```');
  lines.push(padRight('Rank', 6) + padRight('PnL%', 9) + padRight('Sym', 6) + padRight('Side', 8) + padRight('Lev', 6) + 'Trader');
  lines.push('-'.repeat(60));
  trades.forEach((t, i) => {
    const rank = padRight(medal(i), 6);
    const pnl = padRight(`${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}%`, 9);
    const sym = padRight(t.symbol || '—', 6);
    const side = padRight(t.side || '—', 8);
    const lev = padRight(t.lev ? `${t.lev}x` : '—', 6);
    const trader = t.trader || '—';
    lines.push(rank + pnl + sym + side + lev + trader);
  });
  lines.push('```');
  // aparte linkregeltjes (anders breken codeblocks de links)
  trades.forEach((t, i) => {
    lines.push(`${padLeft(i + 1, 2)} ▸ [Trade](${t.link})`);
  });
  return lines.join('\n');
}

async function buildLeaderboard(days = 7, topN = 10, wins = true) {
  const channel = await client.channels.fetch(TRADE_LOG_ID);
  const messages = await fetchAllMessages(channel, days);
  const trades = messages.map(parseTrade).filter(t => t && Number.isFinite(t.pnl));

  const sorted = trades.sort((a, b) => wins ? b.pnl - a.pnl : a.pnl - b.pnl);
  const top = sorted.slice(0, topN);

  const desc = top.length ? formatRows(top).slice(0, 3900) : '_Geen geldige trades gevonden in de periode._';

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

// ---------- Jobs ----------
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

// ---------- Ready ----------
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

  // Cron (Amsterdam TZ)
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

  console.log('[Analyseman] Cron jobs registered with timezone:', TZ);

  // Slash-commands: guild (direct zichtbaar) of global
  try {
    const commands = [
      new SlashCommandBuilder().setName('lb_daily').setDescription('Post de Top 10 van de week (nu)'),
      new SlashCommandBuilder().setName('lb_alltime').setDescription('Post de Top 50 all-time wins & losses (nu)'),
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
      console.log('[Analyseman] Slash commands geregistreerd voor guild:', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.warn('[Analyseman] Geen GUILD_ID/SERVER_ID, commands GLOBAL (kan ~1u duren).');
    }
  } catch (e) {
    console.error('[Analyseman] Slash command deploy error:', e);
  }
});

// ---------- Interactions (asynchroon + snelle reply) ----------
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'lb_daily') {
    await i.deferReply({ ephemeral: true });
    i.editReply('⏳ Bezig met berekenen (week)…');
    try { await runWeeklyTop10(); await i.editReply('✅ Week Top 10 gepost & gepind.'); }
    catch (e) { console.error(e); await i.editReply('❌ Fout bij posten van Week Top 10.'); }
  }

  if (i.commandName === 'lb_alltime') {
    await i.deferReply({ ephemeral: true });
    i.editReply('⏳ Bezig met berekenen (all-time, dit kan even duren)…');
    try { await runAllTimeTop50(); await i.editReply('✅ All-time Top 50 wins & losses gepost & gepind.'); }
    catch (e) { console.error(e); await i.editReply('❌ Fout bij posten van All-time Top 50.'); }
  }
});

// ---------- Start ----------
client.login(process.env.DISCORD_TOKEN);

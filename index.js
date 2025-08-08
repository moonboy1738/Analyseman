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

const TRADE_LOG_ID = '1395887706755829770';
const LEADERBOARD_ID = '1395887166890184845';
const TZ = 'Europe/Amsterdam';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// === Fetch messages ===
async function fetchAllMessages(channel, days = null) {
  let messages = [];
  let lastId;
  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;
  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const fetched = await channel.messages.fetch(options);
    if (fetched.size === 0) break;
    for (const msg of fetched.values()) {
      if (cutoff && msg.createdTimestamp < cutoff) return messages;
      messages.push(msg);
    }
    lastId = fetched.last().id;
  }
  return messages;
}

// === Utilities ===
function normalizeNumber(raw) {
  if (!raw) return null;
  const s = String(raw)
    .replace(/\s+/g, '')
    .replace(/[€$]/g, '')
    .replace(/(?<=\d)[._](?=\d{3}\b)/g, '')
    .replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function expandK(n) {
  if (typeof n !== 'string') return n;
  const m = n.match(/^([\-+]?\d+(?:[.,]\d+)?)([kK])$/);
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
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/<:[A-Za-z0-9_]+:\d+>/g, '')
    .replace(/<@!?&?\d+>/g, '')
    .trim();
}

const patterns = [
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?\b(?:entry|open)\b[:\s]*?(?<entry>[-+]?[\d.,kK]+).*?\b(?:exit|close)\b[:\s]*?(?<exit>[-+]?[\d.,kK]+).*?(?:pnl|p&l)\b[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i,
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?\b(?:pnl|p&l)\b[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i
];

function parseTrade(msg) {
  const raw = cleanContent(msg.content);
  for (const rx of patterns) {
    const m = raw.match(rx);
    if (!m) continue;
    const g = m.groups || {};
    const side = g.side ? g.side.toUpperCase() : null;
    const symbol = g.symbol ? g.symbol.toUpperCase() : null;
    const entryStr = expandK(g.entry || '');
    const exitStr  = expandK(g.exit  || '');
    const entry = normalizeNumber(entryStr);
    const exit  = normalizeNumber(exitStr);
    let pnl     = normalizeNumber(g.pnl);
    if (pnl == null && side && entry != null && exit != null) {
      pnl = computePnlPercent({ side, entry, exit });
    }
    if (pnl == null) continue;
    const trader = msg.member ? msg.member.displayName : msg.author?.username || 'Onbekend';
    const guildId = msg.guild?.id || '000000000000000000';
    const link = `https://discord.com/channels/${guildId}/${msg.channelId}/${msg.id}`;
    return { trader, link, side, symbol, entry, exit, pnl };
  }
  return null;
}

// === Build leaderboards ===
async function buildLeaderboard(days = null, topN = 10, wins = true) {
  const channel = await client.channels.fetch(TRADE_LOG_ID);
  const messages = await fetchAllMessages(channel, days);
  const trades = messages.map(parseTrade).filter(t => t && Number.isFinite(t.pnl));
  const sorted = trades.sort((a, b) => wins ? b.pnl - a.pnl : a.pnl - b.pnl).slice(0, topN);
  const rows = sorted.map((t, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} ${t.pnl >= 0 ? '🟢' : '🔴'} **${t.pnl.toFixed(2)}%** — ${t.trader} — ${t.symbol || '—'} ${t.side || ''} [Link](${t.link})`;
  });
  const embed = new EmbedBuilder()
    .setColor(wins ? 0x00ff00 : 0xff0000)
    .setTitle(wins ? `Top ${topN} ${days ? `${days}-daagse` : 'All-Time'} Winsten` : `Top ${topN} ${days ? `${days}-daagse` : 'All-Time'} Verliezen`)
    .setDescription(rows.join('\n') || '_Geen data_')
    .setFooter({ text: wins ? '[ANALYSEMAN-DAILY]' : '[ANALYSEMAN-LOSS]' })
    .setTimestamp();
  return embed;
}

// === Trader totals ===
async function buildTraderTotals(topN = 25) {
  const ch = await client.channels.fetch(TRADE_LOG_ID);
  const msgs = await fetchAllMessages(ch, null);
  const trades = msgs.map(parseTrade).filter(Boolean);
  const byTrader = new Map();
  for (const t of trades) {
    if (!byTrader.has(t.trader)) byTrader.set(t.trader, { total: 0, n: 0 });
    const agg = byTrader.get(t.trader);
    agg.total += t.pnl;
    agg.n += 1;
  }
  const sorted = [...byTrader.entries()]
    .map(([name, a]) => ({ name, total: a.total, avg: a.total / a.n, n: a.n }))
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);
  const rows = sorted.map((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} ${r.total >= 0 ? '🟢' : '🔴'} **${r.total.toFixed(2)}%** — ${r.name} (trades: ${r.n}, avg: ${r.avg.toFixed(2)}%)`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`All-Time Trader Totals (som PnL%)`)
    .setDescription(rows.join('\n') || '_Geen data_')
    .setFooter({ text: '[ANALYSEMAN-TOTALS]' })
    .setTimestamp();
  return embed;
}

// === Post & pin ===
async function postAndPin(embed, tag) {
  const lbChannel = await client.channels.fetch(LEADERBOARD_ID);
  const pins = await lbChannel.messages.fetchPinned();
  const oldPin = pins.find(p => p.embeds[0]?.footer?.text === tag);
  if (oldPin) await oldPin.unpin().catch(() => {});
  const sent = await lbChannel.send({ embeds: [embed] });
  await sent.pin().catch(() => {});
}

// === Jobs ===
async function runWeeklyTop10() {
  const wins = await buildLeaderboard(7, 10, true);
  await postAndPin(wins, '[ANALYSEMAN-DAILY]');
}
async function runAllTimeTop25() {
  const wins = await buildLeaderboard(null, 25, true);
  const losses = await buildLeaderboard(null, 25, false);
  const totals = await buildTraderTotals(25);
  await postAndPin(wins, '[ANALYSEMAN-DAILY]');
  await postAndPin(losses, '[ANALYSEMAN-LOSS]');
  await postAndPin(totals, '[ANALYSEMAN-TOTALS]');
}

// === Ready ===
client.once('ready', async () => {
  console.log(`[Analyseman] Ingelogd als ${client.user.tag}`);
  cron.schedule('0 9 * * *', runWeeklyTop10, { timezone: TZ });
  cron.schedule('0 20 * * 0', runAllTimeTop25, { timezone: TZ });
  const commands = [
    new SlashCommandBuilder().setName('lb_daily').setDescription('Post de Top 10 van de week (nu)'),
    new SlashCommandBuilder().setName('lb_alltime').setDescription('Post de Top 25 all-time wins & losses (nu)'),
    new SlashCommandBuilder().setName('lb_totals').setDescription('Post de All-time Trader Totals (nu)'),
  ].map(c => c.toJSON());
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});

// === Command handler ===
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  try { await i.deferReply({ ephemeral: true }); } catch {}
  if (i.commandName === 'lb_daily') {
    await runWeeklyTop10();
    await i.editReply('✅ Daily Top 10 gepost.');
  }
  if (i.commandName === 'lb_alltime') {
    await runAllTimeTop25();
    await i.editReply('✅ All-time Top 25 gepost.');
  }
  if (i.commandName === 'lb_totals') {
    const totals = await buildTraderTotals(25);
    await postAndPin(totals, '[ANALYSEMAN-TOTALS]');
    await i.editReply('✅ Trader Totals gepost.');
  }
});

client.login(process.env.DISCORD_TOKEN);

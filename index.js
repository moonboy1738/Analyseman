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

async function fetchAllMessages(channel) {
  let messages = [];
  let lastId;
  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const fetched = await channel.messages.fetch(options);
    if (fetched.size === 0) break;
    messages.push(...fetched.values());
    lastId = fetched.last().id;
  }
  return messages;
}

function normalizeNumber(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\s+/g, '').replace(/[€$]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function computePnlPercent({ side, entry, exit }) {
  if (![entry, exit].every(Number.isFinite)) return null;
  const change = (exit - entry) / entry;
  return (side?.toUpperCase() === 'SHORT' ? -change : change) * 100;
}

function cleanContent(content) {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

const patterns = [
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?(?:entry|open)\b[:\s]*?(?<entry>[-+]?[\d.,]+).*?(?:exit|close)\b[:\s]*?(?<exit>[-+]?[\d.,]+).*?(?:pnl|p&l)\b[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i,
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?(?:pnl|p&l)\b[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i,
];

function parseTrade(msg) {
  const raw = cleanContent(msg.content);
  for (const rx of patterns) {
    const m = raw.match(rx);
    if (!m) continue;
    const g = m.groups || {};
    const side = g.side ? g.side.toUpperCase() : null;
    const entry = normalizeNumber(g.entry);
    const exit = normalizeNumber(g.exit);
    let pnl = normalizeNumber(g.pnl);
    if (pnl == null && side && entry != null && exit != null) {
      pnl = computePnlPercent({ side, entry, exit });
    }
    if (pnl == null) continue;
    return {
      user: msg.author.username,
      pnl,
      side,
      symbol: g.symbol ? g.symbol.toUpperCase() : null,
      entry,
      exit,
      link: `https://discord.com/channels/${msg.guildId}/${msg.channelId}/${msg.id}`,
    };
  }
  return null;
}

async function buildLeaderboard({ days = null, topN = 10, wins = true }) {
  const channel = await client.channels.fetch(TRADE_LOG_ID);
  let messages = await fetchAllMessages(channel);
  if (days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    messages = messages.filter(m => m.createdTimestamp >= cutoff);
  }
  const trades = messages.map(parseTrade).filter(Boolean);
  const sorted = trades.sort((a, b) => wins ? b.pnl - a.pnl : a.pnl - b.pnl);
  const top = sorted.slice(0, topN);
  const rows = top.map((t, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} ${t.user} — ${t.pnl >= 0 ? '🟢' : '🔴'} **${t.pnl.toFixed(2)}%** ${t.symbol ? `· ${t.symbol}` : ''} ${t.side ? `· ${t.side}` : ''} — [Trade](${t.link})`;
  });
  return new EmbedBuilder()
    .setColor(wins ? 0x00ff00 : 0xff0000)
    .setTitle(`${wins ? 'Top' : 'Worst'} ${topN} ${days ? `${days}-day` : 'All-Time'}`)
    .setDescription(rows.join('\n') || '_No trades found_')
    .setTimestamp();
}

async function buildTotals() {
  const channel = await client.channels.fetch(TRADE_LOG_ID);
  const messages = await fetchAllMessages(channel);
  const trades = messages.map(parseTrade).filter(Boolean);
  const totals = {};
  trades.forEach(t => {
    totals[t.user] = (totals[t.user] || 0) + t.pnl;
  });
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const rows = sorted.map(([user, total], i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} ${user} — ${total >= 0 ? '🟢' : '🔴'} **${total.toFixed(2)}%**`;
  });
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('Trader Totals (All-Time)')
    .setDescription(rows.join('\n') || '_No trades found_')
    .setTimestamp();
}

async function postAndPin(embed, tag) {
  const lbChannel = await client.channels.fetch(LEADERBOARD_ID);
  const pins = await lbChannel.messages.fetchPinned();
  const oldPin = pins.find(p => p.embeds[0]?.title === embed.data.title);
  if (oldPin) await oldPin.unpin().catch(() => {});
  const sent = await lbChannel.send({ embeds: [embed] });
  await sent.pin().catch(() => {});
}

async function runDailyTop10() {
  const winsEmbed = await buildLeaderboard({ days: 7, topN: 10, wins: true });
  await postAndPin(winsEmbed);
}

async function runWeeklyAllTime() {
  const winsEmbed = await buildLeaderboard({ days: null, topN: 25, wins: true });
  const lossesEmbed = await buildLeaderboard({ days: null, topN: 25, wins: false });
  const totalsEmbed = await buildTotals();
  await postAndPin(winsEmbed);
  await postAndPin(lossesEmbed);
  await postAndPin(totalsEmbed);
}

client.once('ready', async () => {
  console.log(`[Analyseman] Logged in as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder().setName('lb_daily').setDescription('Post the Top 10 of the last 7 days'),
    new SlashCommandBuilder().setName('lb_alltime').setDescription('Post the Top 25 all-time wins & losses'),
    new SlashCommandBuilder().setName('lb_totals').setDescription('Post Trader Totals all-time')
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log('[Analyseman] Slash commands registered');

  cron.schedule('0 9 * * *', runDailyTop10, { timezone: TZ });
  cron.schedule('0 20 * * 0', runWeeklyAllTime, { timezone: TZ });
});

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  await i.deferReply({ ephemeral: true });
  if (i.commandName === 'lb_daily') {
    await runDailyTop10();
    await i.editReply('✅ Daily Top 10 posted.');
  }
  if (i.commandName === 'lb_alltime') {
    await runWeeklyAllTime();
    await i.editReply('✅ All-time leaderboard posted.');
  }
  if (i.commandName === 'lb_totals') {
    const totals = await buildTotals();
    await postAndPin(totals);
    await i.editReply('✅ Trader Totals posted.');
  }
});

client.login(process.env.DISCORD_TOKEN);

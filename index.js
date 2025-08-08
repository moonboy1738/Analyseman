// ===== Analyseman — volledige bot (CommonJS) =====
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

// ========= Config uit Heroku (met veilige fallbacks) =========
const TRADE_LOG_ID = process.env.TRADE_LOG_CHANNEL || '1395887706755829770';
const LEADERBOARD_ID = process.env.LEADERBOARD_CHANNEL || '1395887166890184845';
const TZ = process.env.TZ || 'Europe/Amsterdam';
const GUILD_ID = process.env.GUILD_ID || null;

// ========= Client =========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ========= Utilities =========
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

function normalizeNumber(raw) {
  if (!raw) return null;
  const s = String(raw)
    .replace(/\s+/g, '')
    .replace(/[’‘‚]/g, "'")
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

// ========= Parser =========
const patterns = [
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?\b(?:entry|in|ingang|open)\b[:\s]*?(?<entry>[-+]?[\d.,kK]+).*?\b(?:exit|out|sluit|close)\b[:\s]*?(?<exit>[-+]?[\d.,kK]+).*?(?:lev(?:erage)?|x)\b[:\s]*?(?<lev>[\d.,]+)x?.*?\b(?:pnl|p&l)\b[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i,
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?\b(?:entry|open)\b[:\s]*?(?<entry>[-+]?[\d.,kK]+).*?\b(?:exit|close)\b[:\s]*?(?<exit>[-+]?[\d.,kK]+).*?\b(?:pnl|p&l)\b[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i,
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?\b(?:pnl|p&l)\b[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i,
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?(?:lev(?:erage)?|x)\s*[:\s]*?(?<lev>[\d.,]+)x?.*?(?:pnl|p&l)\s*[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i,
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?\b(?:entry|open)\b[:\s]*?(?<entry>[-+]?[\d.,kK]+).*?\b(?:exit|close)\b[:\s]*?(?<exit>[-+]?[\d.,kK]+)/i,
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
    const lev   = normalizeNumber(g.lev);
    let pnl     = normalizeNumber(g.pnl);

    if (pnl == null && side && entry != null && exit != null) {
      pnl = computePnlPercent({ side, entry, exit });
    }
    if (pnl == null && entry == null && exit == null) continue;

    const guildId = msg.guild?.id || '000000000000000000';
    const link = `https://discord.com/channels/${guildId}/${msg.channelId}/${msg.id}`;

    return { id: msg.id, link, content: msg.content, side, symbol, entry, exit, lev, pnl, ts: msg.createdTimestamp };
  }
  return null;
}

// ========= Leaderboard =========
async function buildLeaderboard(days = 7, topN = 10, wins = true) {
  const channel = await client.channels.fetch(TRADE_LOG_ID);
  const messages = await fetchAllMessages(channel, days);
  const trades = messages.map(parseTrade).filter(t => t && Number.isFinite(t.pnl));

  const sorted = trades.sort((a, b) => wins ? b.pnl - a.pnl : a.pnl - b.pnl);
  const top = sorted.slice(0, topN);

  const fmtSide = s => s ? (s === 'LONG' ? '🟩 LONG' : '🟥 SHORT') : '';
  const fmtSym = s => s ? `**${s}**` : '—';

  const rows = top.map((t, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const pnlStr = `${t.pnl >= 0 ? '🟢' : '🔴'} **${t.pnl.toFixed(2)}%**`;
    const extra = [
      fmtSym(t.symbol),
      fmtSide(t.side),
      t.lev ? `${t.lev}x` : null,
      (t.entry != null && t.exit != null) ? `E:${t.entry} → X:${t.exit}` : null
    ].filter(Boolean).join(' · ');
    return `${medal} ${pnlStr} — ${extra} — [Trade](${t.link})`;
  });

  const desc = rows.join('\n').slice(0, 3900) || '_Geen geldige trades gevonden in de periode._';

  const embed = new EmbedBuilder()
    .setColor(wins ? 0x00ff00 : 0xff0000)
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
  const lbChannel = await client.channels.fetch(LEADERBOARD_ID);
  const pins = await lbChannel.messages.fetchPinned();
  const oldPin = pins.find(p => p.embeds[0]?.footer?.text === tag);
  if (oldPin) await oldPin.unpin().catch(() => {});
  const sent = await lbChannel.send({ embeds: [embed] });
  await sent.pin().catch(() => {});
}

async function runWeeklyTop10() {
  const winsEmbed = await buildLeaderboard(7, 10, true);
  await postAndPin(winsEmbed, '[ANALYSEMAN-DAILY]');
}
async function runAllTimeTop50() {
  const winsEmbed = await buildLeaderboard(null, 50, true);
  const lossesEmbed = await buildLeaderboard(null, 50, false);
  await postAndPin(winsEmbed, '[ANALYSEMAN-ALLTIME-WIN]');
  await postAndPin(lossesEmbed, '[ANALYSEMAN-ALLTIME-LOSS]');
}

// ========= Ready =========
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

  // Cron
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

  // Slash-commands: GUILD (direct zichtbaar) → anders GLOBAL (kan ~1u duren)
  try {
    const commands = [
      new SlashCommandBuilder().setName('lb_daily').setDescription('Post de Top 10 van de week (nu)'),
      new SlashCommandBuilder().setName('lb_alltime').setDescription('Post de Top 50 all-time wins & losses (nu)'),
    ].map(c => c.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    if (GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, GUILD_ID),
        { body: commands }
      );
      console.log('[Analyseman] Slash commands geregistreerd voor guild:', GUILD_ID);
    } else {
      console.warn('[Analyseman] Geen GUILD_ID gezet; registreer GLOBAL (kan ~1u duren).');
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('[Analyseman] Slash commands GLOBAL geregistreerd');
    }
  } catch (e) {
    console.error('[Analyseman] Slash command deploy error:', e);
  }
});

// ========= Interactions =========
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'lb_daily') {
    await i.deferReply({ ephemeral: true });
    try { await runWeeklyTop10(); await i.editReply('✅ Daily Top 10 gepost.'); }
    catch (e) { console.error(e); await i.editReply('❌ Fout bij posten van Daily Top 10.'); }
  }

  if (i.commandName === 'lb_alltime') {
    await i.deferReply({ ephemeral: true });
    try { await runAllTimeTop50(); await i.editReply('✅ All-time Top 50 gepost.'); }
    catch (e) { console.error(e); await i.editReply('❌ Fout bij posten van All-time Top 50.'); }
  }
});

// ========= Start =========
client.login(process.env.DISCORD_TOKEN);

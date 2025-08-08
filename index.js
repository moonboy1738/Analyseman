// index.js
// Analyseman — Trades + Leaderboards
// Node 18+, discord.js v14

const cron = require('node-cron');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

// ====== ENV / IDs ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const INPUT_ID      = process.env.INPUT_CHANNEL;       // 🖊️∣-input
const TRADELOG_ID   = process.env.TRADE_LOG_CHANNEL;   // 📝∣-trade-log
const LEADER_ID     = process.env.LEADERBOARD_CHANNEL; // 🥇∣-leaderboard
const TZ            = process.env.TZ || 'Europe/Amsterdam';

// ====== Client ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ====== Utils ======
const MULT = '\u00D7'; // ×

function usernameExact(msg) {
  // Gebruik altijd de echte Discord username (geen nickname)
  // Vb: "moonboy1738"
  return msg.author?.username || 'Onbekend';
}

function signPct(p) {
  if (!Number.isFinite(p)) return '0.00%';
  const s = p >= 0 ? '+' : '';
  return `${s}${p.toFixed(2)}%`;
}

function fmtUSD(n) {
  if (!Number.isFinite(n)) return '0.00';
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function parseNumber(s) {
  if (s == null) return null;
  const n = Number(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function computePnlPercent(side, entry, exit) {
  if (![entry, exit].every(Number.isFinite)) return null;
  const chg = (exit - entry) / entry;
  return (side.toUpperCase() === 'SHORT' ? -chg : chg) * 100;
}

// ====== Build trade embed (exact layout) ======
function buildTradeEmbed({ authorName, pnl, symbol, side, lev, entry, exit }) {
  const title = `${authorName} ${signPct(pnl)}`;
  const desc =
    `${symbol.toUpperCase()} ${side[0].toUpperCase()}${side.slice(1).toLowerCase()} ${lev}${MULT}\n` +
    `Entry: $${fmtUSD(entry)}\n` +
    `Exit:  $${fmtUSD(exit)}`;

  return new EmbedBuilder()
    .setColor(pnl >= 0 ? 0x00c853 : 0xd32f2f)
    .setTitle(title)
    .setDescription(desc)
    // Footer tag zodat we ze later makkelijk kunnen herkennen/parsen
    .setFooter({ text: '[ANALYSEMAN-TRADE]' })
    .setTimestamp();
}

// ====== Parse command: "!trade add SYMBOL SIDE ENTRY EXIT LEVERAGE" ======
function tryParseTradeAdd(content) {
  // Voorbeeld: !trade add PENG Long 0.03674 0.03755 30
  const rx = /^\s*!trade\s+add\s+([A-Za-z0-9._-]+)\s+(long|short)\s+([0-9.,]+)\s+([0-9.,]+)\s+([0-9.,]+)\s*$/i;
  const m = content.match(rx);
  if (!m) return null;

  const symbol = m[1];
  const side   = m[2];
  const entry  = parseNumber(m[3]);
  const exit   = parseNumber(m[4]);
  const lev    = parseNumber(m[5]);

  if (!symbol || !side || !Number.isFinite(entry) || !Number.isFinite(exit) || !Number.isFinite(lev)) {
    return null;
  }
  const pnl = computePnlPercent(side, entry, exit);

  return { symbol, side, entry, exit, lev, pnl };
}

// ====== Post to trade-log ======
async function postTradeToLog(trade, sourceMsg) {
  const tradeLog = await client.channels.fetch(TRADELOG_ID);
  const authorName = usernameExact(sourceMsg);
  const embed = buildTradeEmbed({ authorName, ...trade });

  const sent = await tradeLog.send({ embeds: [embed] });
  return sent;
}

// ====== Command handler in #input ======
async function handleMessageInInput(msg) {
  const parsed = tryParseTradeAdd(msg.content);
  if (!parsed) {
    // Foutmelding met exact verwacht patroon
    await msg.reply({
      content: 'Ongeldige input. Gebruik: `!trade add SYMBOL SIDE ENTRY EXIT LEVERAGE` (bv. `!trade add PENG Long 0.03674 0.03755 30`).',
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  // Plaats in trade-log
  const sent = await postTradeToLog(parsed, msg);

  // Bevestiging in input (compact)
  const pct = signPct(parsed.pnl);
  await msg.reply({
    content: `Trade geregistreerd: **${parsed.symbol.toUpperCase()} ${parsed.side} ${parsed.lev}${MULT}** → ${pct}\nEntry: $${fmtUSD(parsed.entry)} / Exit: $${fmtUSD(parsed.exit)}\n[Trade](${sent.url})`,
    allowedMentions: { repliedUser: false },
  });
}

// ====== Fetch + parse bestaand trade-log voor leaderboards ======
async function fetchAllMessages(channel, days = null) {
  const out = [];
  let lastId;
  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    for (const m of batch.values()) {
      if (cutoff && m.createdTimestamp < cutoff) return out;
      out.push(m);
    }
    lastId = batch.last().id;
  }
  return out;
}

function parseTradeFromEmbed(msg) {
  const e = msg.embeds?.[0];
  if (!e) return null;
  const footerText = e.footer?.text || '';
  if (!footerText.includes('[ANALYSEMAN-TRADE]')) return null;

  // Title: "<username> +123.45%"  of "<username> -12.34%"
  const t = e.title || '';
  const mt = t.match(/^(.+)\s([+\-]?\d+(?:\.\d+)?)%$/);
  if (!mt) return null;
  const authorName = mt[1].trim();
  const pnl = parseNumber(mt[2]);

  // Desc:
  // "PENG Long 35×\nEntry: $0.0367\nExit:  $0.0376"
  const d = e.description || '';
  const md = d.match(
    /^([A-Za-z0-9._-]+)\s+(Long|Short)\s+([0-9.,]+)×\s*[\r\n]+Entry:\s*\$([0-9.,]+)\s*[\r\n]+Exit:\s*\$\s*([0-9.,]+)\s*$/i
  );
  if (!md) return null;

  const symbol = md[1].toUpperCase();
  const side   = md[2].toUpperCase();
  const lev    = parseNumber(md[3]);
  const entry  = parseNumber(md[4]);
  const exit   = parseNumber(md[5]);

  return {
    id: msg.id,
    link: msg.url,
    ts: msg.createdTimestamp,
    authorName,
    pnl,
    symbol,
    side,
    lev,
    entry,
    exit,
  };
}

// ====== Leaderboard builders ======
async function buildLeaderboard({ days = null, topN = 10, wins = true }) {
  const ch = await client.channels.fetch(TRADELOG_ID);
  const messages = await fetchAllMessages(ch, days);
  const trades = messages.map(parseTradeFromEmbed).filter(t => t && Number.isFinite(t.pnl));

  const sorted = trades.sort((a, b) => wins ? (b.pnl - a.pnl) : (a.pnl - b.pnl));
  const top = sorted.slice(0, topN);

  const rows = top.map((t, i) => {
    const rank = `${i + 1}.`;
    const pct  = `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}%`;
    const sideNice = t.side === 'LONG' ? 'Long' : 'Short';
    return `${rank} ${pct} ${t.symbol} ${sideNice} — by ${t.authorName} — [Trade](${t.link})`;
  });

  const title = wins
    ? `Top ${topN} ${days ? 'All-Time winsten (7d niet van toepassing)' : 'All-Time winsten'}`
    : `Top ${topN} All-Time verliezen`;

  const prettyTitle =
    days != null
      ? (wins ? `Top ${topN} winsten (laatste ${days} dagen)` : `Top ${topN} verliezen (laatste ${days} dagen)`)
      : (wins ? `Top ${topN} All-Time winsten` : `Top ${topN} All-Time verliezen`);

  const embed = new EmbedBuilder()
    .setColor(wins ? 0x00c853 : 0xd32f2f)
    .setTitle(prettyTitle)
    .setDescription(rows.join('\n') || '_Geen geldige trades gevonden._')
    .setFooter({
      text: days != null
        ? (wins ? '[ANALYSEMAN-DAILY]' : '[ANALYSEMAN-DAILY-LOSS]')
        : (wins ? '[ANALYSEMAN-ALLTIME-WIN]' : '[ANALYSEMAN-ALLTIME-LOSS]'),
    })
    .setTimestamp();

  return embed;
}

async function postAndPinLeaderboard(embed, tag) {
  const lb = await client.channels.fetch(LEADER_ID);
  const pins = await lb.messages.fetchPinned().catch(() => null);
  const old = pins?.find(m => m.embeds?.[0]?.footer?.text === tag);
  if (old) await old.unpin().catch(() => {});
  const sent = await lb.send({ embeds: [embed] });
  await sent.pin().catch(() => {});
}

// ====== Scheduled jobs ======
async function runDailyTop10() {
  const embed = await buildLeaderboard({ days: 7, topN: 10, wins: true });
  await postAndPinLeaderboard(embed, '[ANALYSEMAN-DAILY]');
}

async function runAllTimeTop25() {
  const wins = await buildLeaderboard({ days: null, topN: 25, wins: true });
  const loss = await buildLeaderboard({ days: null, topN: 25, wins: false });
  await postAndPinLeaderboard(wins, '[ANALYSEMAN-ALLTIME-WIN]');
  await postAndPinLeaderboard(loss, '[ANALYSEMAN-ALLTIME-LOSS]');
}

// ====== Events ======
client.once('ready', async () => {
  console.log(`[Analyseman] Ingelogd als ${client.user.tag}`);

  // Perm check (nuttig voor debugging)
  const tradeLog = await client.channels.fetch(TRADELOG_ID);
  const leaderboard = await client.channels.fetch(LEADER_ID);
  const me = await leaderboard.guild.members.fetch(client.user.id);

  const need = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ManageMessages, // voor pin/unpin
  ];
  const okTrade = need.every(p => tradeLog.permissionsFor(me)?.has(p));
  const okLB = need.every(p => leaderboard.permissionsFor(me)?.has(p));
  console.log(`[Analyseman] Perms trade-log OK: ${okTrade}, leaderboard OK: ${okLB}`);

  // Cron: 09:00 dagelijks — weekly Top 10 (laatste 7 dagen)
  cron.schedule('0 9 * * *', async () => {
    try {
      console.log('[Analyseman] Daily 09:00 → Top 10 (7d)');
      await runDailyTop10();
    } catch (e) {
      console.error('Daily job error:', e);
    }
  }, { timezone: TZ });

  // Cron: Zondag 20:00 — All-Time Top 25 wins & losses
  cron.schedule('0 20 * * 0', async () => {
    try {
      console.log('[Analyseman] Sunday 20:00 → All-Time Top 25 wins & losses');
      await runAllTimeTop25();
    } catch (e) {
      console.error('Weekly job error:', e);
    }
  }, { timezone: TZ });

  console.log('[Analyseman] Cron jobs registered:', TZ);
});

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channelId !== INPUT_ID) return;

    // Alleen in #input luisteren naar !trade add ...
    if (/^\s*!trade\s+add\b/i.test(msg.content)) {
      await handleMessageInInput(msg);
    }
  } catch (e) {
    console.error('messageCreate error:', e);
  }
});

client.login(DISCORD_TOKEN);

// index.js — Analyseman (alles-in-één, behoudt bestaand trade-log formaat)

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

// ====== KANAAL-IDS (jouw echte) ======
const INPUT_CHANNEL_ID      = '1397658460211908801'; // 🖊️-input
const TRADE_LOG_ID          = '1395887706755829770'; // 📝-trade-log
const LEADERBOARD_ID        = '1395887166890184845'; // 🥇-leaderboard
const TZ = 'Europe/Amsterdam';

// ====== DISCORD CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ====== HELPERS ======
async function fetchAllMessages(channel, days = null) {
  let out = [];
  let lastId;
  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const fetched = await channel.messages.fetch(options);
    if (fetched.size === 0) break;

    for (const msg of fetched.values()) {
      if (cutoff && msg.createdTimestamp < cutoff) return out;
      out.push(msg);
    }
    lastId = fetched.last().id;
  }
  return out;
}

function normalizeNumber(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw)
    .replace(/\s+/g, '')
    .replace(/[’‘‚]/g, "'")
    .replace(/[€$]/g, '')
    .replace(/(?<=\d)[._](?=\d{3}\b)/g, '') // strip thousand sep .,_
    .replace(',', '.');                     // decimal comma -> dot
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

// Parser die je bestaande layout en varianten aankan
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

    const trader =
      msg.member?.displayName ||
      msg.author?.globalName ||
      msg.author?.username ||
      'Onbekend';

    const guildId = msg.guild?.id || '000000000000000000';
    const link = `https://discord.com/channels/${guildId}/${msg.channelId}/${msg.id}`;

    return { id: msg.id, link, trader, side, symbol, entry, exit, lev, pnl, ts: msg.createdTimestamp };
  }
  return null;
}

// ====== LEADERBOARDS ======
const fmtUser = (u) => u || 'Onbekend';
const fmtSide = (s) => (s ? (s === 'LONG' ? '🟩 LONG' : '🟥 SHORT') : '');

async function buildLeaderboard(days = 7, topN = 10, wins = true) {
  const ch = await client.channels.fetch(TRADE_LOG_ID);
  const msgs = await fetchAllMessages(ch, days);
  const trades = msgs.map(parseTrade).filter(t => t && Number.isFinite(t.pnl));

  const sorted = trades.sort((a, b) => wins ? b.pnl - a.pnl : a.pnl - b.pnl);
  const top = sorted.slice(0, topN);

  const rows = top.map((t, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const left = `${t.pnl >= 0 ? '🟢' : '🔴'} **${t.pnl.toFixed(2)}%**`;
    const mid = [t.symbol || '—', fmtSide(t.side), t.lev ? `${t.lev}x` : null].filter(Boolean).join(' · ');
    return `${medal} ${left} — ${fmtUser(t.trader)} — ${mid} — [Trade](${t.link})`;
  });

  const title = wins
    ? `Top ${topN} ${days ? `${days}-daagse` : 'All-Time'} winsten`
    : `Top ${topN} ${days ? `${days}-daagse` : 'All-Time'} verliezen`;

  const footerTag = wins
    ? (days ? '[ANALYSEMAN-DAILY]' : '[ANALYSEMAN-ALLTIME-WIN]')
    : (days ? '[ANALYSEMAN-DAILY-LOSS]' : '[ANALYSEMAN-ALLTIME-LOSS]');

  return new EmbedBuilder()
    .setColor(wins ? 0x00ff00 : 0xff0000)
    .setTitle(title)
    .setDescription(rows.join('\n').slice(0, 3900) || '_Geen geldige trades gevonden in de periode._')
    .setFooter({ text: footerTag })
    .setTimestamp();
}

async function buildTraderTotals(topN = 25) {
  const ch = await client.channels.fetch(TRADE_LOG_ID);
  const msgs = await fetchAllMessages(ch, null);
  const trades = msgs.map(parseTrade).filter(t => t && Number.isFinite(t.pnl));

  const map = new Map();
  for (const t of trades) {
    if (!map.has(t.trader)) map.set(t.trader, { total: 0, n: 0 });
    const a = map.get(t.trader);
    a.total += t.pnl;
    a.n += 1;
  }

  const sorted = [...map.entries()]
    .map(([name, a]) => ({ name, total: a.total, n: a.n, avg: a.total / a.n }))
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);

  const rows = sorted.map((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const left = `${r.total >= 0 ? '🟢' : '🔴'} **${r.total.toFixed(2)}%**`;
    return `${medal} ${left} — ${fmtUser(r.name)} (trades: ${r.n}, avg: ${r.avg.toFixed(2)}%)`;
  });

  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('All-Time Trader Totals (som PnL%)')
    .setDescription(rows.join('\n') || '_Geen data_')
    .setFooter({ text: '[ANALYSEMAN-TOTALS]' })
    .setTimestamp();
}

async function postAndPin(embed, tag) {
  const lbCh = await client.channels.fetch(LEADERBOARD_ID);
  const pins = await lbCh.messages.fetchPinned();
  const oldPin = pins.find(p => p.embeds[0]?.footer?.text === tag);
  if (oldPin) await oldPin.unpin().catch(() => {});
  const sent = await lbCh.send({ embeds: [embed] });
  await sent.pin().catch(() => {});
}

// Jobs
async function runDailyTop10() {
  const e = await buildLeaderboard(7, 10, true);
  await postAndPin(e, '[ANALYSEMAN-DAILY]');
}
async function runAllTimeTop25() {
  const wins = await buildLeaderboard(null, 25, true);
  const loss = await buildLeaderboard(null, 25, false);
  await postAndPin(wins, '[ANALYSEMAN-ALLTIME-WIN]');
  await postAndPin(loss, '[ANALYSEMAN-ALLTIME-LOSS]');
}
async function runTotals() {
  const t = await buildTraderTotals(25);
  await postAndPin(t, '[ANALYSEMAN-TOTALS]');
}

// ====== /trade formatting (exact jouw layout) ======
function fmtMoney(n) {
  if (n == null) return null;
  return `$${Number(n).toFixed(2)}`;
}
function fmtPct(n) {
  if (n == null) return null;
  const s = Number(n).toFixed(2) + '%';
  return (n >= 0 ? `+${s}` : s);
}
function buildTradeLogText({ trader, symbol, side, lev, entry, exit, pnl }) {
  // Regels exact zoals jouw screenshot:
  // Regel 1: <trader>  <+/-xx.xx%>  (pnl badge visueel door %, we zetten textueel erbij)
  // Regel 2: SYMBOL SIDE <lev>x
  // Regel 3: Entry: $...
  // Regel 4: Exit:  $...
  const l1 = pnl != null
    ? `${trader} — ${fmtPct(pnl)}`
    : `${trader}`;
  const levStr = lev ? ` ${lev}x` : '';
  const l2 = `${symbol || ''} ${side || ''}${levStr}`.trim();
  const l3 = entry != null ? `Entry: ${fmtMoney(entry)}` : null;
  const l4 = exit  != null ? `Exit: ${fmtMoney(exit)}`  : null;

  return [l1, l2, l3, l4].filter(Boolean).join('\n');
}

// ====== BOT READY ======
client.once('ready', async () => {
  console.log(`[Analyseman] Ingelogd als ${client.user.tag}`);

  // slash commands registeren
  const commands = [
    new SlashCommandBuilder()
      .setName('trade')
      .setDescription('Registreer een trade (alleen in #input)')
      .addStringOption(o => o.setName('symbol').setDescription('Bijv. BTC, ETH, SOL').setRequired(true))
      .addStringOption(o => o.setName('side').setDescription('LONG of SHORT').setRequired(true).addChoices(
        { name: 'LONG', value: 'LONG' },
        { name: 'SHORT', value: 'SHORT' }
      ))
      .addIntegerOption(o => o.setName('leverage').setDescription('Leverage, bijv. 25').setRequired(false))
      .addNumberOption(o => o.setName('entry').setDescription('Entry prijs').setRequired(false))
      .addNumberOption(o => o.setName('exit').setDescription('Exit prijs').setRequired(false))
      .addNumberOption(o => o.setName('pnl').setDescription('PnL in %, bijv. 12.5 of -8.4').setRequired(false)),
    new SlashCommandBuilder().setName('lb_daily').setDescription('Post de Top 10 van de laatste 7 dagen'),
    new SlashCommandBuilder().setName('lb_alltime').setDescription('Post de Top 25 all-time wins & losses'),
    new SlashCommandBuilder().setName('lb_totals').setDescription('Post Trader Totals all-time'),
  ].map(c => c.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('[Analyseman] Slash commands geregistreerd.');
  } catch (e) {
    console.error('Slash command deploy error:', e);
  }

  // Cronjobs
  cron.schedule('0 9 * * *', async () => {
    try { await runDailyTop10(); } catch (e) { console.error('Daily job error:', e); }
  }, { timezone: TZ });

  cron.schedule('0 20 * * 0', async () => {
    try { await runAllTimeTop25(); await runTotals(); } catch (e) { console.error('Weekly job error:', e); }
  }, { timezone: TZ });
});

// ====== INTERACTIONS ======
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'trade') {
    try { await i.deferReply({ ephemeral: true }); } catch {}

    // Alleen in #input toestaan
    if (i.channelId !== INPUT_CHANNEL_ID) {
      try { await i.editReply('❌ Gebruik dit commando in het 🖊️-input kanaal.'); } catch {}
      return;
    }

    const symbol  = i.options.getString('symbol').toUpperCase();
    const side    = i.options.getString('side').toUpperCase();
    const lev     = i.options.getInteger('leverage') || null;
    const entry   = i.options.getNumber('entry');
    const exit    = i.options.getNumber('exit');
    let pnl       = i.options.getNumber('pnl');

    // Bereken PnL% indien niet meegegeven maar entry/exit wel
    if (pnl == null && entry != null && exit != null) {
      pnl = computePnlPercent({ side, entry, exit });
    }

    const trader = i.member?.displayName || i.user.username;

    // Bevestiging in INPUT
    const pct = (v) => (v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`);
    const levStr = lev ? ` ${lev}x` : '';
    const entryStr = entry != null ? `\nEntry: ${fmtMoney(entry)}` : '';
    const exitStr  = exit  != null ? `\nExit: ${fmtMoney(exit)}`  : '';
    const pnlStr   = pnl   != null ? ` → ${pct(pnl)}`            : '';
    const confirm  = `Trade geregistreerd: **${symbol} ${side}${levStr}**${pnlStr}${entryStr}${exitStr}`;

    try {
      const inputCh = await client.channels.fetch(INPUT_CHANNEL_ID);
      await inputCh.send(confirm);
    } catch (e) { /* ignore */ }

    // Post in TRADE LOG in exact jouw format
    const tradeLogText = buildTradeLogText({ trader, symbol, side, lev, entry, exit, pnl });
    try {
      const logCh = await client.channels.fetch(TRADE_LOG_ID);
      await logCh.send(tradeLogText);
    } catch (e) {
      console.error('Trade log post error:', e);
      try { await i.editReply('❌ Fout bij posten in trade-log.'); } catch {}
      return;
    }

    try { await i.editReply('✅ Trade geregistreerd.'); } catch {}
  }

  if (i.commandName === 'lb_daily') {
    try { await i.deferReply({ ephemeral: true }); } catch {}
    try { await runDailyTop10(); await i.editReply('✅ Daily Top 10 gepost.'); }
    catch (e) { console.error(e); try { await i.editReply('❌ Fout bij posten.'); } catch {} }
  }

  if (i.commandName === 'lb_alltime') {
    try { await i.deferReply({ ephemeral: true }); } catch {}
    try { await runAllTimeTop25(); await i.editReply('✅ All-Time Top 25 wins & losses gepost.'); }
    catch (e) { console.error(e); try { await i.editReply('❌ Fout bij posten.'); } catch {} }
  }

  if (i.commandName === 'lb_totals') {
    try { await i.deferReply({ ephemeral: true }); } catch {}
    try { await runTotals(); await i.editReply('✅ Trader Totals gepost.'); }
    catch (e) { console.error(e); try { await i.editReply('❌ Fout bij posten.'); } catch {} }
  }
});

// ====== START ======
client.login(process.env.DISCORD_TOKEN);

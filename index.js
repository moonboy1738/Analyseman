// index.js — Analyseman (prefix + slash, behoudt trade-log layout)

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

// ====== JOUW KANALEN (blijven zo) ======
const INPUT_CHANNEL_ID      = '1397658460211908801'; // 🖊️-input
const TRADE_LOG_ID          = '1395887706755829770'; // 📝-trade-log
const LEADERBOARD_ID        = '1395887166890184845'; // 🥇-leaderboard
const TZ = 'Europe/Amsterdam';
const PREFIX = '!'; // prefix voor tekstcommando

// ====== CLIENT ======
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

// Parser van bestaande logs
const patterns = [
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?\b(?:entry|in|ingang|open)\b[:\s]*?(?<entry>[-+]?[\d.,kK]+).*?\b(?:exit|out|sluit|close)\b[:\s]*?(?<exit>[-+]?[\d.,kK]+).*?(?:lev(?:erage)?|x)\b[:\s]*?(?<lev>[\d.,]+)x?.*?\b(?:pnl|p&l)\b[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i,
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?\b(?:entry|open)\b[:\s]*?(?<entry>[-+]?[\d.,kK]+).*?\b(?:exit|close)\b[:\s]*?(?<exit>[-+]?[\d.,kK]+).*?\b(?:pnl|p&l)\b[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i,
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?\b(?:pnl|p&l)\b[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i,
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?(?:lev(?:erage)?|x)\s*[:\s]*?(?<lev>[\d.,]+)x?.*?(?:pnl|p&l)\s*[:\s]*?(?<pnl>[-+]?[\d.,]+)\s*%/i,
  /(?:(?<symbol>[A-Z]{2,15}))?.*?\b(?<side>LONG|SHORT)\b.*?\b(?:entry|open)\b[:\s]*?(?<entry>[-+]?[\d.,kK]+).*?\b(?:exit|close)\b[:\s]*?(?<exit>[-+]?[\d.,kK]+)/i,
];

function parseTradeFromMsg(msg) {
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

const fmtUser = (u) => u || 'Onbekend';
const fmtSide = (s) => (s ? (s === 'LONG' ? '🟩 LONG' : '🟥 SHORT') : '');

async function buildLeaderboard(days = 7, topN = 10, wins = true) {
  const ch = await client.channels.fetch(TRADE_LOG_ID);
  const msgs = await fetchAllMessages(ch, days);
  const trades = msgs.map(parseTradeFromMsg).filter(t => t && Number.isFinite(t.pnl));

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
  const trades = msgs.map(parseTradeFromMsg).filter(t => t && Number.isFinite(t.pnl));

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

// ====== TRADE-LOG LAYOUT ======
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
  const l1 = pnl != null ? `${trader} — ${fmtPct(pnl)}` : `${trader}`;
  const levStr = lev ? ` ${lev}x` : '';
  const l2 = `${symbol || ''} ${side || ''}${levStr}`.trim();
  const l3 = entry != null ? `Entry: ${fmtMoney(entry)}` : null;
  const l4 = exit  != null ? `Exit: ${fmtMoney(exit)}`  : null;
  return [l1, l2, l3, l4].filter(Boolean).join('\n');
}

// ====== Centrale handler voor zowel slash als prefix ======
async function handleTradePost({ guild, channelId, user, member, symbol, side, leverage, entry, exit, pnl }) {
  const trader = member?.displayName || user?.globalName || user?.username || 'Onbekend';

  // PnL berekenen indien nodig
  let usePnl = pnl;
  if (usePnl == null && entry != null && exit != null) {
    usePnl = computePnlPercent({ side, entry, exit });
  }

  // Bevestiging in INPUT
  const pct = (v) => (v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`);
  const levStr = leverage ? ` ${leverage}x` : '';
  const entryStr = entry != null ? `\nEntry: ${fmtMoney(entry)}` : '';
  const exitStr  = exit  != null ? `\nExit: ${fmtMoney(exit)}`  : '';
  const pnlStr   = usePnl   != null ? ` → ${pct(usePnl)}`      : '';
  const confirm  = `Trade geregistreerd: **${symbol} ${side}${levStr}**${pnlStr}${entryStr}${exitStr}`;

  try {
    const inputCh = await client.channels.fetch(INPUT_CHANNEL_ID);
    await inputCh.send(confirm);
  } catch (e) { /* ignore */ }

  // Post in TRADE LOG in exact layout
  const tradeLogText = buildTradeLogText({
    trader,
    symbol,
    side,
    lev: leverage || null,
    entry,
    exit,
    pnl: usePnl
  });

  try {
    const logCh = await client.channels.fetch(TRADE_LOG_ID);
    await logCh.send(tradeLogText);
  } catch (e) {
    console.error('Trade log post error:', e);
    throw e;
  }
}

// ====== READY ======
client.once('ready', async () => {
  console.log(`[Analyseman] Ingelogd als ${client.user.tag}`);

  // Slash commands GUILD-scoped (direct zichtbaar)
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
    const guildId = process.env.SERVER_ID;
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: commands }
    );
    console.log('[Analyseman] Slash commands GUILD-SCOPED geregistreerd voor', guildId);
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

// ====== SLASH INTERACTIONS ======
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  // Alleen in input-kanaal
  if (i.channelId !== INPUT_CHANNEL_ID && i.commandName === 'trade') {
    try { await i.reply({ content: '❌ Gebruik dit in het 🖊️-input kanaal.', ephemeral: true }); } catch {}
    return;
  }

  if (i.commandName === 'trade') {
    try { await i.deferReply({ ephemeral: true }); } catch {}
    const symbol   = i.options.getString('symbol').toUpperCase();
    const side     = i.options.getString('side').toUpperCase();
    const leverage = i.options.getInteger('leverage') || null;
    const entry    = i.options.getNumber('entry');
    const exit     = i.options.getNumber('exit');
    const pnl      = i.options.getNumber('pnl');

    try {
      await handleTradePost({
        guild: i.guild,
        channelId: i.channelId,
        user: i.user,
        member: i.member,
        symbol, side, leverage,
        entry, exit, pnl
      });
      await i.editReply('✅ Trade geregistreerd.');
    } catch (e) {
      console.error(e);
      try { await i.editReply('❌ Fout bij registreren.'); } catch {}
    }
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

// ====== PREFIX COMMAND (!trade) ======
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== INPUT_CHANNEL_ID) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  if (cmd !== 'trade') return;

  // Toegestane vormen:
  // !trade BTC LONG 25x 60000 61200  (leverage optioneel, 'x' mag)
  // !trade BTC LONG 25 60000 61200
  // !trade BTC LONG 60000 61200      (zonder leverage)
  // !trade BTC SHORT 25 60000 59000 12.5  (pnl optioneel, anders berekend)

  if (args.length < 3) {
    return message.reply('Gebruik: `!trade SYMBOL SIDE [LEVERAGE] ENTRY EXIT [PNL%]` (bv. `!trade BTC LONG 25x 60000 61200`)');
  }

  const symbol = args.shift().toUpperCase();
  const side = args.shift().toUpperCase();

  // detecteer leverage (met of zonder x) of direct entry
  let leverage = null, entry = null, exit = null, pnl = null;

  // volgende token
  let t1 = args.shift();
  if (!t1) return message.reply('Ontbrekende waarden. Gebruik: `!trade SYMBOL SIDE [LEVERAGE] ENTRY EXIT [PNL%]`.');

  const levMatch = String(t1).toLowerCase().endsWith('x') ? t1.slice(0, -1) : null;
  const maybeLev = levMatch != null ? levMatch : t1;

  if (!isNaN(Number(maybeLev)) && args.length >= 2) {
    // t1 is leverage
    leverage = parseInt(maybeLev, 10);
    entry = normalizeNumber(args.shift());
    exit  = normalizeNumber(args.shift());
  } else {
    // t1 is entry
    entry = normalizeNumber(t1);
    exit  = normalizeNumber(args.shift());
  }

  // Optionele pnl
  if (args.length) {
    pnl = normalizeNumber(args.shift());
  }

  if (!symbol || !['LONG','SHORT'].includes(side) || entry == null || exit == null) {
    return message.reply('Ongeldige input. Gebruik: `!trade SYMBOL SIDE [LEVERAGE] ENTRY EXIT [PNL%]`');
  }

  try {
    await handleTradePost({
      guild: message.guild,
      channelId: message.channel.id,
      user: message.author,
      member: message.member,
      symbol, side, leverage, entry, exit, pnl
    });
    // geen extra reply nodig: bot stuurt al bevestiging in input
  } catch (e) {
    console.error(e);
    message.reply('❌ Fout bij registreren.');
  }
});

// ====== START ======
client.login(process.env.DISCORD_TOKEN);

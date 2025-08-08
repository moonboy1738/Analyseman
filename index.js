// index.js
// Analyseman – complete bot
// Node 18+, discord.js v14

const cron = require('node-cron');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

// ====== CONFIG ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
if (!DISCORD_TOKEN) throw new Error('Set DISCORD_TOKEN env var');

const PREFIX = '!';
const TZ = 'Europe/Amsterdam';

// JOUW KANALEN
const INPUT_CHANNEL_ID     = '1397658460211908801'; // 🖊️∣-input
const TRADE_LOG_CHANNEL_ID = '1395887706755829770'; // 📝∣-trade-log
const LEADERBOARD_CHANNEL_ID = '1395887166890184845'; // 🥇∣-leaderboard

// ====== CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ====== UTIL ======
const numVal = (s) => {
  if (s == null) return null;
  const clean = String(s).trim()
    .replace(/[€$]/g,'')
    .replace(/(?<=\d)[._](?=\d{3}\b)/g,'') // 1.000 / 1_000 → 1000
    .replace(',', '.');
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
};
const isLev = (t) => /^-?\d{1,3}x?$/i.test(String(t)); // 5..500, optioneel x
const parseLev = (t) => {
  const m = String(t).toLowerCase().replace(/x$/,'');
  const n = Number(m);
  return Number.isInteger(n) ? n : null;
};
const isPercent = (t) => /%$/.test(String(t));
const fixedMoney = (n) => {
  if (n == null) return '';
  // wat jij in screenshots hebt: kleine coins 2 decimalen ook OK
  // we doen: >= 1 → 2 dec; anders → 4 dec
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
};

// ====== POSTING: INPUT -> TRADE LOG ======
async function handleTradePost({ guild, user, member, symbol, side, leverage, entry, exit, pnl }) {
  // bereken PnL indien nodig
  if (pnl == null && entry != null && exit != null) {
    const change = (exit - entry) / entry;
    pnl = (side === 'SHORT' ? -change : change) * 100;
  }
  if (!Number.isFinite(pnl)) throw new Error('PNL missing/invalid');

  const displayName = member?.displayName || user?.username || 'Onbekend';
  const sign = pnl >= 0 ? '+' : '';
  const levText = leverage ? ` ${leverage}x` : '';

  // 1) bevestiging in input-kanaal
  const inputCh = await client.channels.fetch(INPUT_CHANNEL_ID);
  await inputCh.send(
    `Trade geregistreerd: **${symbol} ${side}**${levText} → **${sign}${pnl.toFixed(2)}%**`
  );

  // 2) format in trade-log EXACT zoals je wil
  const logCh = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  const lines = [
    `${displayName} — ${sign}${pnl.toFixed(2)}%`,
    `${symbol} ${side}${levText}`,
    `Entry: $${fixedMoney(entry)}`,
    `Exit: $${fixedMoney(exit)}`,
  ].join('\n');

  await logCh.send(lines);
}

// ====== LEADERBOARD PARSING (van #trade-log) ======
async function fetchAllMessages(channel, days = null) {
  const out = [];
  let lastId;
  const cutoff = days ? Date.now() - days*24*60*60*1000 : null;
  while (true) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const batch = await channel.messages.fetch(opts);
    if (batch.size === 0) break;
    for (const msg of batch.values()) {
      if (cutoff && msg.createdTimestamp < cutoff) return out;
      out.push(msg);
    }
    lastId = batch.last().id;
  }
  return out;
}

// We parsen alléén posts die wij zelf naar #trade-log hebben gestuurd, exact ons format:
function parseTradeLogMessage(msg) {
  if (msg.author.id !== client.user.id) return null;

  const lines = msg.content.split('\n').map(s => s.trim());
  if (lines.length < 2) return null;

  // Lijn 1: "<Trader> — +12.34%"
  const m1 = lines[0].match(/^(.+?)\s+—\s*([+\-]?\d+(?:\.\d+)?)%$/);
  if (!m1) return null;
  const trader = m1[1].trim();
  const pnl = Number(m1[2]);

  // Lijn 2: "SYMBOL SIDE [LEVx]"
  const m2 = lines[1].match(/^([A-Z0-9.\-]{2,15})\s+(LONG|SHORT)(?:\s+(\d{1,3})x)?$/i);
  const symbol = m2 ? m2[1].toUpperCase() : null;
  const side = m2 ? m2[2].toUpperCase() : null;
  const lev = m2 && m2[3] ? Number(m2[3]) : null;

  return {
    id: msg.id,
    channelId: msg.channelId,
    guildId: msg.guild?.id || '0',
    trader,
    pnl,
    symbol, side, lev,
    ts: msg.createdTimestamp,
  };
}

function linkOf(t) {
  return `https://discord.com/channels/${t.guildId}/${t.channelId}/${t.id}`;
}

async function buildLeaderboard({ days = null, topN = 25, wins = true }) {
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  const msgs = await fetchAllMessages(ch, days);
  const trades = msgs.map(parseTradeLogMessage).filter(Boolean);

  if (trades.length === 0) {
    return new EmbedBuilder()
      .setColor(wins ? 0x00ff88 : 0xff2255)
      .setTitle(wins
        ? (days ? `Top ${topN} ${days}-daagse winsten` : `Top ${topN} All-Time winsten`)
        : (days ? `Slechtste ${topN} ${days}-daagse` : `Slechtste ${topN} All-Time`)
      )
      .setDescription('_No trades found._')
      .setTimestamp();
  }

  trades.sort((a,b) => wins ? (b.pnl - a.pnl) : (a.pnl - b.pnl));
  const slice = trades.slice(0, topN);

  const rows = slice.map((t,i) => {
    const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`;
    const sign = t.pnl >= 0 ? '🟢' : '🔴';
    const extra = [
      t.symbol ? `**${t.symbol}**` : null,
      t.side ? t.side : null,
      t.lev ? `${t.lev}x` : null,
      `by **${t.trader}**`
    ].filter(Boolean).join(' · ');
    return `${medal} ${sign} **${t.pnl.toFixed(2)}%** — ${extra} — [Trade](${linkOf(t)})`;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(wins ? 0x00ff88 : 0xff2255)
    .setTitle(wins
      ? (days ? `Top ${topN} ${days}-daagse winsten` : `Top ${topN} All-Time winsten`)
      : (days ? `Slechtste ${topN} ${days}-daagse` : `Slechtste ${topN} All-Time`)
    )
    .setDescription(rows.slice(0, 4000))
    .setFooter({ text: wins
      ? (days ? '[ANALYSEMAN-DAILY]' : '[ANALYSEMAN-ALLTIME-WIN]')
      : (days ? '[ANALYSEMAN-DAILY-LOSS]' : '[ANALYSEMAN-ALLTIME-LOSS]')
    })
    .setTimestamp();
}

async function buildTotals({ days = null, topN = 25 }) {
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  const msgs = await fetchAllMessages(ch, days);
  const trades = msgs.map(parseTradeLogMessage).filter(Boolean);

  const byTrader = new Map();
  for (const t of trades) {
    byTrader.set(t.trader, (byTrader.get(t.trader)||0) + t.pnl);
  }
  const list = [...byTrader.entries()]
    .sort((a,b) => b[1]-a[1])
    .slice(0, topN);

  const rows = list.map(([name,total], i) => {
    const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`;
    const sign = total >= 0 ? '🟢' : '🔴';
    return `${medal} ${sign} **${total.toFixed(2)}%** — **${name}**`;
  }).join('\n') || '_No trades found._';

  return new EmbedBuilder()
    .setColor(0x3399ff)
    .setTitle(days ? `Trader Totals (laatste ${days} dagen)` : 'Trader Totals (All-Time)')
    .setDescription(rows.slice(0, 4000))
    .setFooter({ text: days ? '[ANALYSEMAN-TOTALS-7D]' : '[ANALYSEMAN-TOTALS-ALL]' })
    .setTimestamp();
}

// ====== SCHEDULED POSTS ======
async function postAndPin(embed, tagFooterText) {
  const lbCh = await client.channels.fetch(LEADERBOARD_CHANNEL_ID);
  // Verwijder oude pin met zelfde footer-tag
  const pins = await lbCh.messages.fetchPinned().catch(()=>null);
  const old = pins?.find(p => p.embeds[0]?.footer?.text === tagFooterText);
  if (old) await old.unpin().catch(()=>{});
  const sent = await lbCh.send({ embeds: [embed] });
  await sent.pin().catch(()=>{});
}

// Daily 09:00 → Top 10 van de week (7d)
async function runDailyTop10() {
  const e = await buildLeaderboard({ days: 7, topN: 10, wins: true });
  await postAndPin(e, '[ANALYSEMAN-DAILY]');
}

// Zondag 20:00 → All-Time Top 25 wins, Worst 25, en Totals
async function runAllTimePacks() {
  const win = await buildLeaderboard({ days: null, topN: 25, wins: true });
  const los = await buildLeaderboard({ days: null, topN: 25, wins: false });
  const tot = await buildTotals({ days: null, topN: 25 });
  await postAndPin(win, '[ANALYSEMAN-ALLTIME-WIN]');
  await postAndPin(los, '[ANALYSEMAN-ALLTIME-LOSS]');
  await postAndPin(tot, '[ANALYSEMAN-TOTALS-ALL]');
}

// ====== SLASH COMMANDS ======
const slashDefs = [
  new SlashCommandBuilder()
    .setName('lb_daily')
    .setDescription('Post Top 10 van de week (nu)'),
  new SlashCommandBuilder()
    .setName('lb_alltime')
    .setDescription('Post All-Time Top 25 wins + worst 25 + totals (nu)'),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: slashDefs }
  );
}

// ====== PREFIX COMMAND (!trade add ...) ======
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== INPUT_CHANNEL_ID) return;
  if (!message.content.startsWith(PREFIX)) return;

  const raw = message.content.slice(PREFIX.length).trim();
  const parts = raw.split(/\s+/);
  const cmd = (parts.shift() || '').toLowerCase();
  if (cmd !== 'trade') return;

  if ((parts[0] || '').toLowerCase() === 'add') parts.shift();

  const symbol = (parts.shift() || '').toUpperCase();
  const side   = (parts.shift() || '').toUpperCase();

  if (!symbol || !['LONG','SHORT'].includes(side)) {
    return message.reply('Gebruik: `!trade add SYMBOL LONG|SHORT ENTRY EXIT [LEVERAGE] [PNL%]` (bv. `!trade add PENG LONG 0.03674 0.03755 30`)');
  }

  // leverage overal toegestaan
  let leverage = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isLev(parts[i])) {
      leverage = parseLev(parts[i]);
      parts.splice(i,1);
      break;
    }
  }

  // expliciete PNL% toegestaan
  let pnl = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isPercent(parts[i])) {
      const v = Number(String(parts[i]).replace('%','').replace(',', '.'));
      if (Number.isFinite(v)) pnl = v;
      parts.splice(i,1);
      break;
    }
  }

  // pak de eerste twee cijfers die overblijven: entry/exit
  const nums = [];
  for (const t of parts) {
    const n = numVal(t);
    if (n != null) nums.push(n);
  }
  if (nums.length < 2) {
    return message.reply('Ontbrekende prijzen. Gebruik: `!trade add SYMBOL LONG|SHORT ENTRY EXIT [LEVERAGE] [PNL%]`');
  }
  const entry = nums[0];
  const exit  = nums[1];

  try {
    await handleTradePost({
      guild: message.guild,
      user: message.author,
      member: message.member,
      symbol, side, leverage, entry, exit, pnl
    });
  } catch (e) {
    console.error(e);
    message.reply('❌ Fout bij registreren.');
  }
});

// ====== SLASH HANDLER ======
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  if (i.commandName === 'lb_daily') {
    await i.deferReply({ ephemeral: true });
    try { await runDailyTop10(); await i.editReply('✅ Daily Top 10 gepost.'); }
    catch (e) { console.error(e); await i.editReply('❌ Fout bij Daily.'); }
  }

  if (i.commandName === 'lb_alltime') {
    await i.deferReply({ ephemeral: true });
    try { await runAllTimePacks(); await i.editReply('✅ All-Time pakket gepost.'); }
    catch (e) { console.error(e); await i.editReply('❌ Fout bij All-Time.'); }
  }
});

// ====== READY ======
client.once('ready', async () => {
  console.log(`[Analyseman] Ingelogd als ${client.user.tag}`);

  // Slash commands registreren
  try {
    await registerCommands();
    console.log('[Analyseman] Slash: /lb_daily, /lb_alltime');
  } catch (e) {
    console.error('[Analyseman] Slash deploy error:', e);
  }

  // CRON: 09:00 elke dag → Top 10 week
  cron.schedule('0 9 * * *', async () => {
    try { await runDailyTop10(); console.log('[Cron] Daily top10 done'); }
    catch (e) { console.error('[Cron] Daily error', e); }
  }, { timezone: TZ });

  // CRON: zondag 20:00 → all-time pakket
  cron.schedule('0 20 * * 0', async () => {
    try { await runAllTimePacks(); console.log('[Cron] Weekly all-time done'); }
    catch (e) { console.error('[Cron] Weekly error', e); }
  }, { timezone: TZ });

  console.log('[Analyseman] Cron jobs ready in TZ:', TZ);
});

// ====== START ======
client.login(DISCORD_TOKEN);

const cron = require('node-cron');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

// ====== ENV / KANALEN ======
const TOKEN = process.env.DISCORD_TOKEN;
const SERVER_ID = process.env.SERVER_ID;
const INPUT_ID = process.env.INPUT_CHANNEL;          // 🖊️∣-input
const TRADE_LOG_ID = process.env.TRADE_LOG_CHANNEL;  // 📝∣-trade-log
const LEADERBOARD_ID = process.env.LEADERBOARD_CHANNEL; // 🥇∣-leaderboard
const TZ = process.env.TZ || 'Europe/Amsterdam';

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
function cleanSpaces(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}
function normalizeNumber(raw) {
  if (raw == null) return null;
  const s = String(raw)
    .trim()
    .replace(/[€$]/g, '')
    .replace(/,/g, '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function fmtUSD(n) {
  if (n == null || !Number.isFinite(n)) return '$0.00';
  const v = Number(n);
  let dp = 2;
  if (Math.abs(v) < 0.1) dp = 5;   // sub-$0.10 -> 5 decimals
  return `$${v.toFixed(dp)}`;
}
function computePnlPercent(side, entry, exit) {
  if (!['LONG','SHORT'].includes(side)) return null;
  if (![entry, exit].every(Number.isFinite)) return null;
  const raw = ((exit - entry) / entry) * 100;        // GEEN leverage in PnL% (zoals afgesproken)
  return side === 'SHORT' ? -raw : raw;
}
function signPct(p) {
  if (!Number.isFinite(p)) return '0.00%';
  const s = p >= 0 ? '+' : '';
  return `${s}${p.toFixed(2)}%`;
}
function timesSymbol(x) {
  return `${x}×`;
}

// We posten naar trade-log in vast tekstformaat (later gebruiken we dat voor parsing)
function renderTradeMessageRow({ username, pnl, symbol, side, lev, entry, exit }) {
  return [
    `${username} ${signPct(pnl)}`,
    `${symbol.toUpperCase()} ${side} ${timesSymbol(lev)}`,
    `Entry: ${fmtUSD(entry)}`,
    `Exit:  ${fmtUSD(exit)}`
  ].join('\n');
}

// Parse een door ons geposte trade-log message terug naar data
const TRADE_PARSE = {
  first: /^(.+?)\s+([+\-]?\d+(?:\.\d+)?)%$/, // "username +2.20%"
  second: /^([A-Z0-9]{2,15})\s+(LONG|SHORT)\s+(\d+)×$/, // "PENG LONG 30×"
  entry: /^Entry:\s+\$([0-9]+(?:\.[0-9]+)?)$/,
  exit:  /^Exit:\s+\$([0-9]+(?:\.[0-9]+)?)$/
};
function tryParsePostedTrade(message) {
  const lines = message.content.split('\n').map(l => l.trim());
  if (lines.length < 4) return null;

  const m1 = lines[0].match(TRADE_PARSE.first);
  const m2 = lines[1].match(TRADE_PARSE.second);
  const m3 = lines[2].match(TRADE_PARSE.entry);
  const m4 = lines[3].match(TRADE_PARSE.exit);
  if (!m1 || !m2 || !m3 || !m4) return null;

  const username = m1[1];
  const pnl = parseFloat(m1[2]);
  const symbol = m2[1];
  const side = m2[2];
  const lev = parseInt(m2[3], 10);
  const entry = parseFloat(m3[1]);
  const exit = parseFloat(m4[1]);

  return {
    id: message.id,
    link: `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`,
    username, pnl, symbol, side, lev, entry, exit,
    ts: message.createdTimestamp
  };
}

// Alles (geschiedenis) fetchen uit een kanaal, optioneel cutoff (dagen)
async function fetchAllMessages(channel, days = null) {
  let out = [];
  let lastId;
  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
    if (batch.size === 0) break;
    for (const msg of batch.values()) {
      if (cutoff && msg.createdTimestamp < cutoff) return out;
      out.push(msg);
    }
    lastId = batch.last().id;
  }
  return out;
}

// ====== COMMAND: !trade add ======
async function handleTradeAdd(message, args) {
  // Verwacht: SYMBOL SIDE ENTRY EXIT LEVERAGE
  // vb: !trade add PENG Long 0.03674 0.03755 30
  if (args.length < 5) {
    await message.reply("Ongeldige input. Gebruik: `!trade add SYMBOL SIDE ENTRY EXIT LEVERAGE` (bv. `!trade add PENG Long 0.03674 0.03755 30`).");
    return;
  }
  const [rawSymbol, rawSide, rawEntry, rawExit, rawLev] = args;

  const symbol = cleanSpaces(rawSymbol).toUpperCase();
  const side = cleanSpaces(rawSide).toUpperCase();
  const entry = normalizeNumber(rawEntry);
  const exit  = normalizeNumber(rawExit);
  const lev   = parseInt(rawLev, 10);

  if (!/^[A-Z0-9]{2,15}$/.test(symbol)) return message.reply("Symbool ongeldig.");
  if (!['LONG','SHORT'].includes(side)) return message.reply("Side ongeldig. Gebruik LONG of SHORT.");
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return message.reply("Entry/Exit ongeldig.");
  if (!Number.isInteger(lev) || lev <= 0) return message.reply("Leverage ongeldig (geheel getal > 0).");

  const pnl = computePnlPercent(side, entry, exit);

  // username = echte accountnaam (niet nickname)
  const username = message.author?.username || 'Onbekend';

  // Naar trade-log posten in vast formaat
  const tradeLog = await client.channels.fetch(TRADE_LOG_ID);
  const txt = renderTradeMessageRow({ username, pnl, symbol, side, lev, entry, exit });
  await tradeLog.send(txt);

  // Feedback in input
  await message.reply(`Trade geregistreerd: ${symbol} ${side} ${lev}× → ${signPct(pnl)}\nEntry: ${fmtUSD(entry)} / Exit: ${fmtUSD(exit)}\n[Trade](${tradeLog.url || ''})`);
}

// ====== LEADERBOARD BOUWERS ======
function buildTableEmbed({ title, rows, color = 0x00ff88, footer }) {
  const desc = rows.length ? rows.join('\n') : '_No trades found._';
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(desc.slice(0, 3900))
    .setFooter({ text: footer })
    .setTimestamp();
}

function fmtRow(rank, t) {
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
  const side = t.side === 'LONG' ? 'LONG' : 'SHORT';
  return `${medal} ${signPct(t.pnl)} — ${t.symbol} ${side} ${t.lev}× — by **${t.username}** — [Trade](${t.link})`;
}

async function getParsedTrades(days = null) {
  const ch = await client.channels.fetch(TRADE_LOG_ID);
  const msgs = await fetchAllMessages(ch, days);
  const parsed = msgs
    .map(m => tryParsePostedTrade(m))
    .filter(Boolean)
    .filter(t => Number.isFinite(t.pnl));
  return parsed;
}

async function postAndPin(embed, tagText) {
  const lb = await client.channels.fetch(LEADERBOARD_ID);
  const pins = await lb.messages.fetchPinned().catch(() => null);
  const old = pins?.find(m => m.embeds[0]?.footer?.text === tagText);
  if (old) await old.unpin().catch(() => {});
  const sent = await lb.send({ embeds: [embed] });
  await sent.pin().catch(() => {});
}

// TOP N wins of losses
async function postTop({ title, days, topN, wins }) {
  const trades = await getParsedTrades(days);
  if (!trades.length) {
    const emb = buildTableEmbed({
      title,
      rows: [],
      color: wins ? 0x00ff88 : 0xff4444,
      footer: wins ? (days ? '[ANALYSEMAN-DAILY-WIN]' : '[ANALYSEMAN-ALLTIME-WIN]')
                   : (days ? '[ANALYSEMAN-DAILY-LOSS]' : '[ANALYSEMAN-ALLTIME-LOSS]'),
    });
    await postAndPin(emb, emb.data.footer.text);
    return;
  }
  const sorted = trades.sort((a, b) => wins ? (b.pnl - a.pnl) : (a.pnl - b.pnl));
  const pick = sorted.slice(0, topN);
  const rows = pick.map((t, i) => fmtRow(i + 1, t));
  const emb = buildTableEmbed({
    title,
    rows,
    color: wins ? 0x00ff88 : 0xff4444,
    footer: wins ? (days ? '[ANALYSEMAN-DAILY-WIN]' : '[ANALYSEMAN-ALLTIME-WIN]')
                 : (days ? '[ANALYSEMAN-DAILY-LOSS]' : '[ANALYSEMAN-ALLTIME-LOSS]'),
  });
  await postAndPin(emb, emb.data.footer.text);
}

// TRADER TOTALS (som PnL% per user)
async function postTotalsAllTime() {
  const trades = await getParsedTrades(null);
  const map = new Map();
  for (const t of trades) {
    const key = t.username;
    const cur = map.get(key) || { user: key, sum: 0, n: 0 };
    cur.sum += t.pnl;
    cur.n += 1;
    map.set(key, cur);
  }
  const list = [...map.values()].sort((a, b) => b.sum - a.sum);
  const rows = list.slice(0, 50).map((r, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    return `${medal} **${r.user}** — ${signPct(r.sum)} (${r.n} trades)`;
  });
  const emb = buildTableEmbed({
    title: 'Trader Totals (All-Time)',
    rows,
    color: 0x3399ff,
    footer: '[ANALYSEMAN-TOTALS]'
  });
  await postAndPin(emb, emb.data.footer.text);
}

// ====== SCHEDULES ======
async function runDailyWeeklyTop10() {
  await postTop({
    title: 'Top 10 van de week (laatste 7 dagen) — Winsten',
    days: 7, topN: 10, wins: true
  });
}
async function runAllTime50() {
  await postTop({ title: 'Top 25 All-Time winsten', days: null, topN: 25, wins: true });
  await postTop({ title: 'Top 25 All-Time verliezen', days: null, topN: 25, wins: false });
  await postTotalsAllTime();
}

// ====== MESSAGE HANDLER ======
client.on('messageCreate', async (message) => {
  try {
    // negeer DM / bots
    if (!message.guildId || message.author.bot) return;

    // Alleen input-kanaal voor de add-command
    if (message.channelId === INPUT_ID) {
      const txt = message.content.trim();

      // !trade add ...
      if (/^!trade\s+add\b/i.test(txt)) {
        const args = txt.split(/\s+/).slice(2); // na "!trade add"
        await handleTradeAdd(message, args);
        return;
      }

      // Handmatige triggers (optioneel)
      if (/^!lb\s+weekly$/i.test(txt)) {
        await runDailyWeeklyTop10();
        await message.reply('Weekly top 10 is gepost & gepind.');
        return;
      }
      if (/^!lb\s+alltime$/i.test(txt)) {
        await runAllTime50();
        await message.reply('All-Time Top 25 win/loss + Totals zijn gepost & gepind.');
        return;
      }
      if (/^!totals$/i.test(txt)) {
        await postTotalsAllTime();
        await message.reply('Trader Totals (All-Time) gepost & gepind.');
        return;
      }
    }
  } catch (err) {
    console.error('messageCreate error:', err);
  }
});

// ====== READY / PERMS / CRON ======
client.once('ready', async () => {
  console.log(`[Analyseman] Ingelogd als ${client.user.tag}`);

  // Perms check
  const guild = await client.guilds.fetch(SERVER_ID);
  const me = await guild.members.fetch(client.user.id);

  const channels = {
    input: await client.channels.fetch(INPUT_ID),
    tlog: await client.channels.fetch(TRADE_LOG_ID),
    lb: await client.channels.fetch(LEADERBOARD_ID),
  };
  const need = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ManageMessages,
  ];
  const okInput = need.every(p => channels.input.permissionsFor(me)?.has(p));
  const okTlog  = need.every(p => channels.tlog.permissionsFor(me)?.has(p));
  const okLB    = need.every(p => channels.lb.permissionsFor(me)?.has(p));
  console.log(`[Analyseman] Perms OK? input=${okInput} trade-log=${okTlog} leaderboard=${okLB}`);

  // Schedules
  // Dagelijks 09:00: Top 10 weekly (7 dagen)
  cron.schedule('0 9 * * *', async () => {
    console.log('[Analyseman] 09:00 cron → weekly top10');
    try { await runDailyWeeklyTop10(); } catch (e) { console.error('cron weekly err', e); }
  }, { timezone: TZ });

  // Zondag 20:00: All-time win/loss top25 + totals
  cron.schedule('0 20 * * 0', async () => {
    console.log('[Analyseman] Zondag 20:00 cron → all-time + totals');
    try { await runAllTime50(); } catch (e) { console.error('cron alltime err', e); }
  }, { timezone: TZ });

  console.log('[Analyseman] Cron jobs set in', TZ);
});

client.login(TOKEN);

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, Colors
} from 'discord.js';
import cron from 'node-cron';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(tz);

const {
  DISCORD_TOKEN,
  SERVER_ID,
  INPUT_CHANNEL,
  TRADE_LOG_CHANNEL,
  LEADERBOARD_CHANNEL,
  TZ = 'Europe/Amsterdam'
} = process.env;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ---------- helpers ----------
const cap = s => (s || '').toUpperCase();
const sideNorm = s => s?.toLowerCase() === 'short' ? 'SHORT' : 'LONG';
const fmtMoney = n => `$${Number(n).toFixed(4).replace(/\.?0+$/,'')}`;
const fmtPct = n => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const medal = i => (['🥇','🥈','🥉'][i] || `${i+1}.`);
const isNumeric = v => !isNaN(parseFloat(v)) && isFinite(v);

// PnL incl. leverage
function calcPnlPct(entry, exit, side, lev) {
  const e = Number(entry), x = Number(exit), L = Number(lev || 1);
  if (!isNumeric(e) || !isNumeric(x) || e === 0) return null;
  const raw = side === 'SHORT' ? ((e - x) / e) : ((x - e) / e);
  return raw * L * 100;
}

// parse de '!trade add' regel
function parseTradeCommand(content) {
  // !trade add PENG Long 0.03674 0.03755 30
  const rx = /^!trade\s+add\s+([A-Za-z0-9-]+)\s+(long|short)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s*$/i;
  const m = content.trim().match(rx);
  if (!m) return null;
  return {
    symbol: cap(m[1]),
    side: sideNorm(m[2]),
    entry: m[3],
    exit: m[4],
    lev: Number(m[5])
  };
}

// Bouw bevestigingstekst voor INPUT
function inputConfirmLine({symbol, side, lev, pnl}) {
  return `Trade geregistreerd: **${symbol}** ${side} ${lev}× → \`${fmtPct(pnl)}\``;
}

// Maak embed voor TRADE LOG
function buildTradeEmbed(username, {symbol, side, lev, entry, exit, pnl}) {
  const color = pnl >= 0 ? Colors.Green : Colors.Red;
  return new EmbedBuilder()
    .setColor(color)
    .setDescription(
`**${username}** \`${fmtPct(pnl)}\`
${cap(symbol)} ${side} ${lev}×
Entry: ${fmtMoney(entry)}
Exit:  ${fmtMoney(exit)}`
    )
    .setFooter({ text: '[ANALYSEMAN-TRADE]' })
    .setTimestamp(new Date());
}

// --------- parser voor trade-log historiek (pakt ook oude en nieuwe posts) ---------
function extractTradeFromMessage(msg) {
  // Alleen berichten van de bot zelf tellen
  if (msg.author?.id !== client.user?.id) return null;

  // 1) Embeds – huidige format
  if (msg.embeds?.length) {
    const d = msg.embeds[0].description || '';
    // **username** `+12.34%`
    const m1 = d.match(/\*\*(.+?)\*\*[^`]*`([+\-]?\d+(?:\.\d+)?)%`/);
    const m2 = d.match(/\n([A-Z0-9-]+)\s+(LONG|SHORT)\s+(\d+)×/i);
    const m3 = d.match(/Entry:\s*\$?([\d.]+)\s*\nExit:\s*\$?([\d.]+)/i);
    if (m1 && m2 && m3) {
      const user = m1[1].trim();
      const pnl = parseFloat(m1[2]);
      const symbol = m2[1].toUpperCase();
      const side = m2[2].toUpperCase();
      const lev = parseInt(m2[3], 10);
      const entry = parseFloat(m3[1]);
      const exit = parseFloat(m3[2]);
      return { user, pnl, symbol, side, lev, entry, exit, url: msg.url, ts: msg.createdTimestamp };
    }
  }

  // 2) Heel oud/tekst – fallback (zoek percentage)
  const t = msg.content || '';
  const mU = t.match(/\*\*(.+?)\*\.*?\`?([+\-]?\d+(?:\.\d+)?)%/i);
  const mS = t.match(/([A-Z0-9-]+)\s+(LONG|SHORT)\s+(\d+)×/i);
  if (mU && mS) {
    const user = mU[1].trim();
    const pnl = parseFloat(mU[2]);
    const symbol = mS[1].toUpperCase();
    const side = mS[2].toUpperCase();
    const lev = parseInt(mS[3], 10);
    return { user, pnl, symbol, side, lev, url: msg.url, ts: msg.createdTimestamp };
  }

  return null;
}

async function fetchAllTradesFromLog() {
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL);
  let lastId;
  const rows = [];
  while (true) {
    const batch = await ch.messages.fetch({ limit: 100, before: lastId }).catch(() => null);
    if (!batch?.size) break;
    const list = [...batch.values()];
    for (const m of list) {
      const r = extractTradeFromMessage(m);
      if (r) rows.push(r);
    }
    lastId = list[list.length - 1].id;
    if (batch.size < 100) break;
  }
  return rows;
}

function buildLeaderboardEmbed({ title, items, color, footerTag }) {
  const lines = items.map((t, i) => {
    const medalTxt = medal(i);
    return `${medalTxt} \`${fmtPct(t.pnl)}\` ${t.symbol} ${t.side} — by ${t.user} — [Trade](${t.url})`;
  });
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(lines.join('\n') || 'Geen trades gevonden')
    .setFooter({ text: footerTag })
    .setTimestamp(new Date());
}

async function postAllTime() {
  const rows = await fetchAllTradesFromLog();
  if (!rows.length) throw new Error('Geen data in trade-log');

  const wins = rows.filter(r => r.pnl > 0).sort((a,b)=>b.pnl-a.pnl).slice(0,25);
  const loss = rows.filter(r => r.pnl < 0).sort((a,b)=>a.pnl-b.pnl).slice(0,25);

  const lbCh = await client.channels.fetch(LEADERBOARD_CHANNEL);

  const e1 = buildLeaderboardEmbed({
    title: 'Top 25 All-Time winsten',
    items: wins,
    color: Colors.Green,
    footerTag: '[ANALYSEMAN-ALLTIME-WIN]'
  });

  const e2 = buildLeaderboardEmbed({
    title: 'Top 25 All-Time verliezen',
    items: loss,
    color: Colors.Red,
    footerTag: '[ANALYSEMAN-ALLTIME-LOSS]'
  });

  const m1 = await lbCh.send({ embeds: [e1] });
  const m2 = await lbCh.send({ embeds: [e2] });
  await m1.pin().catch(()=>{});
  await m2.pin().catch(()=>{});
}

async function postWeeklyTop() {
  const rows = await fetchAllTradesFromLog();
  const since = dayjs().tz(TZ).subtract(7, 'day').valueOf();
  const wins7 = rows.filter(r => r.ts >= since && r.pnl > 0)
                    .sort((a,b)=>b.pnl-a.pnl).slice(0,10);
  const lbCh = await client.channels.fetch(LEADERBOARD_CHANNEL);
  const e = buildLeaderboardEmbed({
    title: 'Top 10 (laatste 7 dagen)',
    items: wins7,
    color: Colors.Blurple,
    footerTag: '[ANALYSEMAN-WEEKLY]'
  });
  const m = await lbCh.send({ embeds: [e] });
  await m.pin().catch(()=>{});
}

async function postTotals() {
  const rows = await fetchAllTradesFromLog();
  const map = new Map();
  for (const r of rows) {
    map.set(r.user, (map.get(r.user) || 0) + r.pnl);
  }
  const items = [...map.entries()]
    .map(([user, sum]) => ({ user, sum }))
    .sort((a,b)=>b.sum-a.sum);

  const lines = items.map((x,i)=> `${i+1}. **${x.user}** \`${fmtPct(x.sum)}\``).join('\n') || 'Geen trades gevonden';

  const e = new EmbedBuilder()
    .setColor(Colors.Gold)
    .setTitle('Trader Totals (All-Time)')
    .setDescription(lines)
    .setFooter({ text: '[ANALYSEMAN-TOTALS]' })
    .setTimestamp(new Date());

  const lbCh = await client.channels.fetch(LEADERBOARD_CHANNEL);
  const m = await lbCh.send({ embeds: [e] });
  await m.pin().catch(()=>{});
}

// ---------- events ----------
client.on('ready', async () => {
  console.log(`Ingelogd als ${client.user.tag}`);

  // Schedulers
  // Dagelijks 09:00
  cron.schedule('0 9 * * *', () => postWeeklyTop().catch(()=>{}), { timezone: TZ });

  // Zondag 20:00
  cron.schedule('0 20 * * 0', async () => {
    try {
      await postAllTime();
      await postTotals();
    } catch (e) { console.error(e); }
  }, { timezone: TZ });
});

client.on('interactionCreate', async (itx) => {
  if (!itx.isChatInputCommand()) return;

  try {
    if (itx.commandName === 'lb_alltime') {
      await itx.deferReply({ ephemeral: true });
      await postAllTime();
      await itx.editReply('All-time Top 25 gepost & gepind.');
    }
    if (itx.commandName === 'lb_daily') {
      await itx.deferReply({ ephemeral: true });
      await postWeeklyTop();
      await itx.editReply('Top 10 (laatste 7 dagen) gepost & gepind.');
    }
    if (itx.commandName === 'totals') {
      await itx.deferReply({ ephemeral: true });
      await postTotals();
      await itx.editReply('Trader totals gepost & gepind.');
    }
  } catch (err) {
    console.error(err);
    try { await itx.editReply('Er ging iets mis.'); } catch {}
  }
});

client.on('messageCreate', async (msg) => {
  if (msg.guild?.id !== SERVER_ID) return;

  // Alleen prefix-command in INPUT channel
  if (msg.channelId === INPUT_CHANNEL && msg.content?.startsWith('!trade')) {
    const parsed = parseTradeCommand(msg.content);
    if (!parsed) {
      await msg.reply('Ongeldige input. Gebruik: `!trade add SYMBOL SIDE ENTRY EXIT LEVERAGE`');
      return;
    }

    const { symbol, side, entry, exit, lev } = parsed;
    const pnl = calcPnlPct(entry, exit, side, lev);
    if (pnl === null) {
      await msg.reply('Kon PnL niet berekenen. Check getallen.');
      return;
    }

    // Bevestiging in INPUT (zonder Entry/Exit regels)
    const line = inputConfirmLine({ symbol, side, lev, pnl });
    await msg.reply(line);

    // Post in TRADE LOG (met naam + Entry/Exit)
    const username = msg.member?.displayName || msg.author?.username || 'Onbekend';
    const embed = buildTradeEmbed(username, { symbol, side, lev, entry, exit, pnl });
    const tradeCh = await client.channels.fetch(TRADE_LOG_CHANNEL);
    await tradeCh.send({ embeds: [embed] });
  }
});

client.login(DISCORD_TOKEN);

// index.js
import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes, SlashCommandBuilder } from 'discord.js';
import cron from 'node-cron';

const {
  DISCORD_TOKEN,
  SERVER_ID,
  INPUT_CHANNEL,
  TRADE_LOG_CHANNEL,
  LEADERBOARD_CHANNEL,
} = process.env;

if (!DISCORD_TOKEN || !SERVER_ID || !INPUT_CHANNEL || !TRADE_LOG_CHANNEL || !LEADERBOARD_CHANNEL) {
  console.error('Missing required ENV vars. Set DISCORD_TOKEN, SERVER_ID, INPUT_CHANNEL, TRADE_LOG_CHANNEL, LEADERBOARD_CHANNEL, TZ');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ---------- helpers ----------
const fmtPct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const bold = (s) => `**${s}**`;
const cap = (s) => s.toUpperCase();

function getDisplayUserName(user, member) {
  // Jij wilt de *echte* gebruikersnaam zoals in de oude posts (niet verkort, geen nickname)
  // Dus: user.username
  return user?.username || member?.user?.username || 'Onbekend';
}

function parseSide(raw) {
  const s = raw.toLowerCase();
  if (s.startsWith('l')) return 'LONG';
  if (s.startsWith('s')) return 'SHORT';
  return raw.toUpperCase();
}

// PnL met leverage: ((exit - entry)/entry) * 100 * lev, LONG/SHORT gecorrigeerd
function calcPnlPct(entry, exit, lev, side) {
  const base = ((exit - entry) / entry) * 100;
  const gross = base * (isNaN(lev) ? 1 : Number(lev));
  if (side === 'SHORT') return -gross; // short is omgekeerd
  return gross;
}

// Bouw trade-log bericht in jouw exact gewenste stijl
function buildTradeLogText({ username, pnlPct, symbol, side, lev, entry, exit }) {
  return [
    `${bold(username)} ${fmtPct(pnlPct)}`,
    `${cap(symbol)} ${side} ${lev}×`,
    `Entry: $${Number(entry).toFixed(4)}`,
    `Exit:  $${Number(exit).toFixed(4)}`
  ].join('\n');
}

// Bevestiging in #input exact zoals jij wil
function buildInputAckLine({ symbol, side, lev, pnlPct }) {
  return `Trade geregistreerd: ${bold(cap(symbol))} ${side} ${lev}× → ${fmtPct(pnlPct)}`;
}

// --------- persist / parse uit #trade-log ----------

// We parseren jouw bestaande posts (oude én nieuwe).
// Ondersteunde vormen:
//  1) "**username** +12.34%" op 1e regel, 2e regel "SYMBOL LONG 30×", 3e/4e Entry/Exit
//  2) Eerdere variaties met spaties/strepen worden ook geprobeerd.
const RE_LINE1 = /^\*\*(.+?)\*\*\s+([+\-]?\d+(?:\.\d+)?)%/i;
const RE_LINE2 = /^([A-Z0-9]+)\s+(LONG|SHORT)\s+(\d+)×/i;
const RE_FLEX_UN = /^\*\*(.+?)\*\*.*$/i; // fallback username vang
const RE_PCT_ANY = /([+\-]?\d+(?:\.\d+)?)%/;

function extractTradeFromMessage(msg) {
  const lines = msg.content.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  let username, pnlPct, symbol, side, lev;

  // lijn 1
  let m1 = RE_LINE1.exec(lines[0]);
  if (m1) {
    username = m1[1].trim();
    pnlPct = Number(m1[2]);
  } else {
    // fallback: zoek username en percentage los
    const um = RE_FLEX_UN.exec(lines[0]);
    const pm = RE_PCT_ANY.exec(lines[0]);
    if (!um || !pm) return null;
    username = um[1].trim();
    pnlPct = Number(pm[1]);
  }

  // lijn 2
  let m2 = RE_LINE2.exec(lines[1]);
  if (!m2) return null;
  symbol = m2[1].toUpperCase();
  side = m2[2].toUpperCase();
  lev = Number(m2[3]);

  return {
    username,
    pnlPct,
    symbol,
    side,
    lev,
    ts: msg.createdTimestamp || Date.now()
  };
}

async function fetchAllTradesFromLog(channel) {
  const results = [];
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    for (const [,m] of batch) {
      const t = extractTradeFromMessage(m);
      if (t) results.push(t);
    }
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return results;
}

// ---------- Leaderboard builders ----------

function topNByPnl(trades, n, dir = 'desc') {
  const sorted = trades
    .slice()
    .sort((a,b)=> dir==='desc' ? b.pnlPct - a.pnlPct : a.pnlPct - b.pnlPct)
    .slice(0, n);
  return sorted;
}

function fmtListBlock(title, rows) {
  if (rows.length === 0) return `${bold(title)}\nGeen trades gevonden`;
  const body = rows.map((t,i)=>{
    const rank = String(i+1).padStart(2,' ');
    return `${rank}. ${fmtPct(t.pnlPct)}  ${bold(t.symbol)}  ${t.side}  —  door ${t.username}`;
  }).join('\n');
  return `${bold(title)}\n${body}`;
}

function computeTotals(trades) {
  // Sommeer PnL per user (gemakkelijk: optellen, jij wilde all-time netto % als optelsom)
  // NB: Leverage-PnL is al “per trade” berekend. We sommeren die percentages.
  const map = new Map();
  for (const t of trades) {
    map.set(t.username, (map.get(t.username)||0) + t.pnlPct);
  }
  const rows = [...map.entries()]
    .map(([username, total])=>({username, total}))
    .sort((a,b)=> b.total - a.total);
  return rows;
}

function fmtTotalsBlock(title, rows, top = 25) {
  const list = rows.slice(0, top);
  if (list.length === 0) return `${bold(title)}\nGeen trades gevonden`;
  const body = list.map((r,i)=> {
    const rank = String(i+1).padStart(2,' ');
    return `${rank}. ${bold(r.username)} — ${fmtPct(r.total)}`;
  }).join('\n');
  return `${bold(title)}\n${body}`;
}

// ---------- Slash commands ----------
const commands = [
  new SlashCommandBuilder().setName('lb_alltime')
    .setDescription('Post all-time Top 25 wins & losses + pin'),
  new SlashCommandBuilder().setName('lb_weekly')
    .setDescription('Post Top 10 van de laatste 7 dagen + pin'),
  new SlashCommandBuilder().setName('lb_totals')
    .setDescription('Post all-time nettototals per trader + pin')
].map(c=>c.toJSON());

async function registerSlash() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands((await client.application.fetch()).id, SERVER_ID), { body: commands });
}

// ---------- CORE: handle trade input ----------

async function handleTradeInput(message, parts) {
  // !trade add PENG Long 0.03674 0.03755 30
  if (parts.length < 7) {
    await message.reply("Ongeldige input. Gebruik: `!trade add SYMBOL SIDE ENTRY EXIT LEVERAGE`");
    return;
  }
  const symbol = parts[2].toUpperCase();
  const side = parseSide(parts[3]);
  const entry = Number(parts[4]);
  const exit = Number(parts[5]);
  const lev = Number(parts[6]);

  if ([entry, exit, lev].some(n=>isNaN(n))) {
    await message.reply("Ongeldige getallen. Gebruik: `!trade add SYMBOL SIDE ENTRY EXIT LEVERAGE`");
    return;
  }

  const pnlPct = calcPnlPct(entry, exit, lev, side);
  const guild = message.guild || await client.guilds.fetch(SERVER_ID);
  const member = await guild.members.fetch(message.author.id).catch(()=>null);
  const username = getDisplayUserName(message.author, member);

  // 1) bevestiging in #input (één regel, zoals jij wil)
  await message.channel.send(
    buildInputAckLine({ symbol, side, lev, pnlPct })
  );

  // 2) post in #trade-log in jouw layout
  const tradeLog = await client.channels.fetch(TRADE_LOG_CHANNEL);
  const text = buildTradeLogText({ username, pnlPct, symbol, side, lev, entry, exit });
  await tradeLog.send(text);
}

// ---------- Command listeners ----------

client.on('messageCreate', async (message) => {
  // Alleen in input-channel, en alleen prefix !
  if (message.author.bot) return;
  if (message.channelId !== INPUT_CHANNEL) return;

  const content = message.content.trim();
  if (!content.startsWith('!')) return;

  const parts = content.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '!trade' && parts[1]?.toLowerCase() === 'add') {
    await handleTradeInput(message, parts);
  }
});

// ---------- Slash interactions ----------

async function runAllTimeLeaderboard() {
  const log = await client.channels.fetch(TRADE_LOG_CHANNEL);
  const leaderboard = await client.channels.fetch(LEADERBOARD_CHANNEL);
  const trades = await fetchAllTradesFromLog(log);

  const topWins = topNByPnl(trades, 25, 'desc');
  const topLoss = topNByPnl(trades, 25, 'asc');

  const txt =
    fmtListBlock('Top 25 All-Time winsten', topWins) + '\n\n' +
    fmtListBlock('Top 25 All-Time verliezen', topLoss);

  const msg = await leaderboard.send(txt);
  // pin de 2 blokken samen (1 bericht)
  try { await msg.pin(); } catch {}
}

async function runWeeklyTop10() {
  const log = await client.channels.fetch(TRADE_LOG_CHANNEL);
  const leaderboard = await client.channels.fetch(LEADERBOARD_CHANNEL);
  const trades = await fetchAllTradesFromLog(log);

  const weekAgo = Date.now() - 7*24*60*60*1000;
  const last7d = trades.filter(t => t.ts >= weekAgo);
  const top10 = topNByPnl(last7d, 10, 'desc');

  const txt = fmtListBlock('Top 10 van de week (laatste 7 dagen)', top10);
  const msg = await leaderboard.send(txt);
  try { await msg.pin(); } catch {}
}

async function runTotals() {
  const log = await client.channels.fetch(TRADE_LOG_CHANNEL);
  const leaderboard = await client.channels.fetch(LEADERBOARD_CHANNEL);
  const trades = await fetchAllTradesFromLog(log);

  const totals = computeTotals(trades);
  const txt = fmtTotalsBlock('Trader Totals (All-Time)', totals, 50);

  const msg = await leaderboard.send(txt);
  try { await msg.pin(); } catch {}
}

client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    await i.deferReply({ ephemeral: true });
    if (i.commandName === 'lb_alltime') {
      await runAllTimeLeaderboard();
      await i.editReply('All-time Top 25 gepost & gepind.');
    } else if (i.commandName === 'lb_weekly') {
      await runWeeklyTop10();
      await i.editReply('Weekly Top 10 gepost & gepind.');
    } else if (i.commandName === 'lb_totals') {
      await runTotals();
      await i.editReply('Totals (all-time) gepost & gepind.');
    }
  } catch (e) {
    console.error(e);
    if (i.deferred || i.replied) {
      await i.editReply('Er ging iets mis.');
    }
  }
});

// ---------- Cron ----------
function scheduleJobs() {
  // Dagelijks 09:00 lokale tijd (TZ via ENV)
  cron.schedule('0 9 * * *', () => runWeeklyTop10(), { timezone: process.env.TZ || 'Europe/Amsterdam' });

  // Zondag 20:00
  cron.schedule('0 20 * * 0', async () => {
    await runAllTimeLeaderboard();
    await runTotals();
  }, { timezone: process.env.TZ || 'Europe/Amsterdam' });
}

client.once('ready', async () => {
  console.log(`[Analyesman] Ingelogd als ${client.user.tag}`);
  try { await registerSlash(); } catch (e) { console.error('Slash reg failed', e); }
  scheduleJobs();
});

client.login(DISCORD_TOKEN);

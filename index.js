// index.js
import 'dotenv/config';
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
} from 'discord.js';
import cron from 'node-cron';

const {
  DISCORD_TOKEN,
  GUILD_ID,
  INPUT_CHANNEL,
  TRADE_LOG_CHANNEL,
  LEADERBOARD_CHANNEL,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !INPUT_CHANNEL || !TRADE_LOG_CHANNEL || !LEADERBOARD_CHANNEL) {
  console.error('Missing env vars. Set DISCORD_TOKEN, GUILD_ID, INPUT_CHANNEL, TRADE_LOG_CHANNEL, LEADERBOARD_CHANNEL.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ---------- Helpers ----------
const cap = (s) => s.toUpperCase();
const fmtPct = (n) =>
  `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; // tekst; Discord maakt zelf het "pill"-badgeje bij inline code niet, dus we zetten de pill op username-regel in trade-log zoals jouw voorbeeld

const bold = (s) => `**${s}**`;

function calcPnl(entry, exit, side, lev) {
  const base = ((exit - entry) / entry) * 100;
  const signed = side === 'short' ? -base : base;
  return signed * lev;
}

function normalizeNum(s) {
  // punt als decimaal, comma weghalen
  return parseFloat(String(s).replace(',', '.'));
}

function niceMoney(val) {
  // voor coins als $0.04 wil je twee decimalen of 5 als < 1 cent
  const n = Number(val);
  if (Number.isNaN(n)) return `$${val}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.1) return `$${n.toFixed(3)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(5)}`;
}

function authorText(member) {
  // exact username (zoals in je voorbeelden)
  return member?.user?.username ?? 'Onbekend';
}

// ----------- INPUT: !trade add -----------
const TRADE_CMD = /^!trade\s+add\s+([A-Za-z0-9:_-]+)\s+(long|short)\s+([\d.,]+)\s+([\d.,]+)\s+(\d+)/i;
// !trade add PENG Long 0.03674 0.03755 30

client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channelId !== INPUT_CHANNEL) return;

    const m = msg.content.match(TRADE_CMD);
    if (!m) return; // laat andere chat met rust

    const [, rawSym, rawSide, rawEntry, rawExit, rawLev] = m;
    const symbol = cap(rawSym);
    const side = rawSide.toLowerCase(); // 'long'|'short'
    const entry = normalizeNum(rawEntry);
    const exit = normalizeNum(rawExit);
    const lev = parseInt(rawLev, 10);

    if ([entry, exit].some(Number.isNaN) || Number.isNaN(lev)) {
      await msg.reply('Ongeldige input. Gebruik: `!trade SYMBOL SIDE ENTRY EXIT LEVERAGE` (bv. `!trade PENG long 0.03674 0.03755 30`)');
      return;
    }

    const pnl = calcPnl(entry, exit, side, lev);
    const userTxt = authorText(msg.member);

    // 1) Bevestiging in #input EXACT zoals jij wilt (zonder "door …", zonder Entry/Exit)
    // Trade geregistreerd: **INJ** Long 25× → -20.57%
    await msg.channel.send(
      `Trade geregistreerd: ${bold(symbol)} ${side.toUpperCase()} ${lev}× → ${fmtPct(pnl)}`
    );

    // 2) Post naar #trade-log in jouw oude layout
    const tradeLog = await client.channels.fetch(TRADE_LOG_CHANNEL);
    const lines = [
      `${userTxt} ${fmtPct(pnl)}`,
      `${symbol} ${side.toUpperCase()} ${lev}×`,
      `Entry: ${niceMoney(entry)}`,
      `Exit: ${niceMoney(exit)}`,
    ].join('\n');

    await tradeLog.send(lines);

  } catch (err) {
    console.error('messageCreate error:', err);
  }
});

// ----------- Slash commands (leaderboards + totals) -----------
const commands = [
  {
    name: 'lb_alltime',
    description: 'Top 25 winsten/verliezen All-Time uit alle trades in #trade-log',
  },
  {
    name: 'lb_weekly',
    description: 'Top 10 laatste 7 dagen uit #trade-log',
  },
  {
    name: 'totals',
    description: 'Totaal +/−% per trader uit alle data in #trade-log',
  },
];

// registreer slash commands
client.once('ready', async () => {
  console.log(`Ingelogd als ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands,
    });
    console.log('Slash commands geregistreerd.');
  } catch (err) {
    console.error('Slash reg error', err);
  }

  // CRONs — Europe/Amsterdam via process.env.TZ
  // Dagelijks 09:00 — Weekly Top 10 (afgelopen 7 dagen)
  cron.schedule('0 9 * * *', async () => {
    try {
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL);
      const { topW, topL } = await computeLeaderboard({ daysBack: 7, limit: 10 });
      await postLeaderboard(ch, 'Top 10 (laatste 7 dagen) winsten', topW);
      await postLeaderboard(ch, 'Top 10 (laatste 7 dagen) verliezen', topL);
    } catch (e) {
      console.error('cron daily error:', e);
    }
  });

  // Wekelijks zondag 20:00 — All-time Top 25 win/loss + totals
  cron.schedule('0 20 * * 0', async () => {
    try {
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL);
      const { topW, topL } = await computeLeaderboard({ daysBack: 0, limit: 25 });
      await postLeaderboard(ch, 'Top 25 All-Time winsten', topW);
      await postLeaderboard(ch, 'Top 25 All-Time verliezen', topL);

      const totals = await computeTotals(); // all-time totals per trader
      await postTotals(ch, 'Trader Totals (All-Time)', totals);
    } catch (e) {
      console.error('cron weekly error:', e);
    }
  });
});

// interaction handler
client.on('interactionCreate', async (i) => {
  if (!i.isChatInputCommand()) return;

  try {
    await i.deferReply(); // voorkomt “application did not respond”

    if (i.commandName === 'lb_alltime') {
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL);
      const { topW, topL } = await computeLeaderboard({ daysBack: 0, limit: 25 });
      await postLeaderboard(ch, 'Top 25 All-Time winsten', topW);
      await postLeaderboard(ch, 'Top 25 All-Time verliezen', topL);
      await i.editReply('All-time Top 25 gepost & gepind.');
      return;
    }

    if (i.commandName === 'lb_weekly') {
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL);
      const { topW, topL } = await computeLeaderboard({ daysBack: 7, limit: 10 });
      await postLeaderboard(ch, 'Top 10 (laatste 7 dagen) winsten', topW);
      await postLeaderboard(ch, 'Top 10 (laatste 7 dagen) verliezen', topL);
      await i.editReply('Weekly Top 10 gepost.');
      return;
    }

    if (i.commandName === 'totals') {
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL);
      const totals = await computeTotals();
      await postTotals(ch, 'Trader Totals (All-Time)', totals);
      await i.editReply('Totals gepost.');
      return;
    }
  } catch (err) {
    console.error('interaction error:', err);
    try {
      await i.editReply('Er ging iets mis.');
    } catch {}
  }
});

// --------- Parser voor #trade-log – ondersteunt OUDE & NIEUWE layout ---------
/*
Ondersteunde vormen (jouw screenshots):

OUD:
moonboy1738 +66.14%
PENG LONG 30×
Entry: $0.0367
Exit:  $0.0376

OUD (negatief):
analyseman -26.52%
PENG Long 35×
Entry: $0.04
Exit:  $0.04

NIEUW (embed-achtig in input) verwerken we NIET hier; we schrijven altijd naar trade-log in bovenstaand 4-regels-plain-text format,
dus alle historische + nieuwe data blijven parsebaar.
*/

const HEADER_RE = /^(.+?)\s+([+\-]\d{1,3}(?:\.\d{1,2})?)%$/i; // "username +66.14%"
const LINE2_RE = /^([A-Z0-9:_-]+)\s+(LONG|SHORT)\s+(\d+)×$/i;
const ENTRY_RE = /^Entry:\s*\$?([\d.,]+)/i;
const EXIT_RE  = /^Exit:\s*\$?\s*([\d.,]+)/i;

async function fetchAllTradesFromLog({ daysBack = 0 } = {}) {
  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL);
  const out = [];
  let before; let keep = true;
  const cutoff = daysBack > 0 ? Date.now() - daysBack * 24 * 3600 * 1000 : 0;

  while (keep) {
    const batch = await ch.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;

    for (const [, m] of batch) {
      before = m.id;

      if (cutoff && m.createdTimestamp < cutoff) { keep = false; break; }

      if (m.author?.bot !== true) continue; // wij posten deze regels
      const lines = m.content?.split('\n').map(s => s.trim()).filter(Boolean) ?? [];
      if (lines.length < 4) continue;

      const h = lines[0].match(HEADER_RE);
      const l2 = lines[1].match(LINE2_RE);
      const e = lines[2].match(ENTRY_RE);
      const x = lines[3].match(EXIT_RE);

      if (!h || !l2 || !e || !x) continue;

      const username = h[1];
      const pnlFromHeader = parseFloat(h[2]); // kan afwijken door afronding; we herberekenen
      const symbol = cap(l2[1]);
      const side = l2[2].toLowerCase();
      const lev = parseInt(l2[3], 10);
      const entry = normalizeNum(e[1]);
      const exit  = normalizeNum(x[1]);
      if ([entry, exit, lev].some(v => Number.isNaN(v))) continue;

      const pnl = calcPnl(entry, exit, side, lev);

      out.push({
        id: m.id,
        ts: m.createdTimestamp,
        username,
        symbol,
        side,
        lev,
        entry,
        exit,
        pnl,
      });
    }
  }
  return out;
}

// ---------- Leaderboards & Totals ----------
async function computeLeaderboard({ daysBack = 0, limit = 25 }) {
  const trades = await fetchAllTradesFromLog({ daysBack });

  const wins = [...trades].sort((a, b) => b.pnl - a.pnl).slice(0, limit);
  const losses = [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, limit);

  return {
    topW: wins,
    topL: losses,
  };
}

async function computeTotals() {
  const trades = await fetchAllTradesFromLog({ daysBack: 0 });
  const map = new Map(); // username -> sum pnl
  for (const t of trades) {
    map.set(t.username, (map.get(t.username) ?? 0) + t.pnl);
  }
  // sort desc
  const rows = [...map.entries()]
    .map(([user, total]) => ({ user, total }))
    .sort((a, b) => b.total - a.total);
  return rows;
}

async function postLeaderboard(channel, title, list) {
  if (!list.length) {
    await channel.send(`${title}\nGeen trades gevonden`);
    return;
  }
  // compact monospace tabel (zoals je vorige nette versie)
  const lines = [];
  lines.push(`${title}`);
  lines.push('```');
  lines.push('Rank  PnL%     Sym  Side   Lev  Trader');
  lines.push('----- -------- ---- ------ ---- ----------------');
  list.forEach((t, i) => {
    const rank = String(i + 1).padStart(2, ' ');
    const pnl = (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(2).padStart(7, ' ');
    const sym = (t.symbol ?? '').padEnd(4, ' ');
    const side = t.side.toUpperCase().padEnd(6, ' ');
    const lev = String(t.lev).padStart(4, ' ');
    lines.push(`${rank}.  ${pnl}   ${sym} ${side} ${lev}  ${t.username}`);
  });
  lines.push('```');

  const msg = await channel.send(lines.join('\n'));
  // pinnen als het een all-time block is
  if (/All-Time/.test(title)) {
    try { await msg.pin(); } catch {}
  }
}

async function postTotals(channel, title, totalsRows) {
  if (!totalsRows.length) {
    await channel.send(`${title}\nGeen data`);
    return;
  }
  const lines = [];
  lines.push(title);
  lines.push('```');
  lines.push('Rank  Total%    Trader');
  lines.push('----- --------- ----------------');
  totalsRows.forEach((r, i) => {
    const rank = String(i + 1).padStart(2, ' ');
    const total = (r.total >= 0 ? '+' : '') + r.total.toFixed(2).padStart(7, ' ');
    lines.push(`${rank}.  ${total}   ${r.user}`);
  });
  lines.push('```');
  const msg = await channel.send(lines.join('\n'));
  try { await msg.pin(); } catch {}
}

// ------------- Start -------------
client.login(DISCORD_TOKEN);

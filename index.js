import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials,
  PermissionsBitField
} from 'discord.js';
import cron from 'node-cron';

const {
  DISCORD_TOKEN,
  SERVER_ID,
  INPUT_CHANNEL,
  TRADE_LOG_CHANNEL,
  LEADERBOARD_CHANNEL,
} = process.env;

const PREFIX = '!'; // blijft ! voor input
const TZ = process.env.TZ || 'Europe/Amsterdam';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ---------- Helpers ----------
function toNum(x) {
  if (typeof x === 'number') return x;
  return parseFloat(String(x).replace(',', '.'));
}
function money(n) {
  // laat 5 decimals toe (zoals jouw screenshots), trim trailing zeros
  return `$${Number(n).toFixed(5).replace(/(\.\d*?[1-9])0+$/,'$1').replace(/\.0+$/,'')}`;
}
function fmtPct(n) {
  const sign = n > 0 ? '+' : (n < 0 ? '' : '');
  return `${sign}${n.toFixed(2)}%`;
}
function normalizeSide(s) {
  const x = String(s).toUpperCase();
  return x === 'LONG' || x === 'SHORT' ? x : 'LONG';
}
function parseAddArgs(args) {
  // !trade add SYMBOL SIDE ENTRY EXIT LEVERAGE
  // alles verplicht zoals jij gebruikt
  if (args.length < 6) return null;
  const [cmd, sub, sym, sideRaw, entryRaw, exitRaw, levRaw] = args;
  if (cmd !== '!trade' || sub.toLowerCase() !== 'add') return null;
  return {
    symbol: sym.toUpperCase(),
    side: normalizeSide(sideRaw),
    entry: toNum(entryRaw),
    exit: toNum(exitRaw),
    leverage: Math.max(1, Math.round(toNum(levRaw)))
  };
}
function calcPnlPct(entry, exit, side, lev) {
  const base = side === 'LONG'
    ? (exit - entry) / entry
    : (entry - exit) / entry;
  return base * lev * 100;
}

async function sendInputConfirmation(channel, { userName, symbol, side, entry, exit, leverage }) {
  const pnl = calcPnlPct(entry, exit, side, leverage);
  const lines = [
    `**Trade geregistreerd:** **${symbol}** ${side} ${leverage}× → **${fmtPct(pnl)}**`,
    `— door **${userName}**`,
    `Entry: ${money(entry)} / Exit: ${money(exit)}`
  ];
  await channel.send(lines.join('\n'));
}

async function postTradeLog(channel, { userName, pnlPct, symbol, side, leverage, entry, exit }) {
  // Exact jouw layout:
  // **moonboy1738** +2.20%
  // PENG LONG 30×
  // Entry: $0.03674
  // Exit:  $0.03755
  const lines = [
    `**${userName}** ${fmtPct(pnlPct)}`,
    `${symbol} ${side} ${leverage}×`,
    `Entry: ${money(entry)}`,
    `Exit:  ${money(exit)}`
  ];
  await channel.send(lines.join('\n'));
}

// Parse bestaande trade-log berichten -> [{user, pnlPct, symbol, side, lev, ts}]
const TRADE_RE = new RegExp(
  String.raw`^\*\*(?<user>.+?)\*\*\s+(?<pct>[+\-]?\d+(?:\.\d+)?)%\s*\n` + // **user** +2.20%
  String.raw`(?<sym>[A-Z0-9]+)\s+(?<side>LONG|SHORT)\s+(?<lev>\d+)×\s*\n` +
  String.raw`Entry:\s*\$(?<entry>\d+(?:\.\d+)?)\s*\n` +
  String.raw`Exit:\s*\$(?<exit>\d+(?:\.\d+)?)\s*$`,
  'm'
);

async function fetchAllTrades(tradeLogChannel) {
  let before;
  const all = [];
  while (true) {
    const batch = await tradeLogChannel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    for (const [, msg] of batch) {
      const text = msg.content;
      const m = text.match(TRADE_RE);
      if (m && m.groups) {
        const pnl = toNum(m.groups.pct);
        all.push({
          ts: msg.createdTimestamp,
          user: m.groups.user.trim(),
          pnlPct: pnl,
          symbol: m.groups.sym.toUpperCase(),
          side: m.groups.side.toUpperCase(),
          lev: parseInt(m.groups.lev, 10) || 1,
          entry: toNum(m.groups.entry),
          exit: toNum(m.groups.exit),
          link: msg.url
        });
      }
    }
    before = batch.last()?.id;
    if (!before) break;
    // hard stop om niet eindeloos te lopen (pas aan indien nodig):
    if (all.length > 10000) break;
  }
  return all.reverse(); // oud -> nieuw
}

function topN(arr, n, selector = (x) => x) {
  return [...arr].sort((a,b)=> selector(b)-selector(a)).slice(0,n);
}
function bottomN(arr, n, selector = (x) => x) {
  return [...arr].sort((a,b)=> selector(a)-selector(b)).slice(0,n);
}

function asListBlock(rows, title) {
  // lijst zoals je voorbeeld (compact, leesbaar)
  const body = rows.map((r,i)=>{
    const rank = (i+1).toString().padStart(2,' ');
    const pct  = fmtPct(r.pnlPct).padStart(8,' ');
    return `${rank}. ${pct}  ${r.symbol} ${r.side} — door ${r.user}`;
  }).join('\n');
  return `**${title}**\n\`\`\`\n${body || 'Geen trades gevonden'}\n\`\`\``;
}

async function postAllTime(leaderboardChannel, tradeLogChannel) {
  const trades = await fetchAllTrades(tradeLogChannel);
  const wins = topN(trades.filter(t=>t.pnlPct>0), 25, t=>t.pnlPct);
  const losses = bottomN(trades.filter(t=>t.pnlPct<0), 25, t=>t.pnlPct);

  const msg1 = await leaderboardChannel.send(asListBlock(wins, 'Top 25 All-Time winsten'));
  const msg2 = await leaderboardChannel.send(asListBlock(losses, 'Top 25 All-Time verliezen'));

  // pin de nieuwste (verwijder oude pins van de bot voor overzicht)
  try {
    const pins = await leaderboardChannel.messages.fetchPinned();
    for (const [,m] of pins) {
      if (m.author.id === client.user.id) await m.unpin().catch(()=>{});
    }
    await msg1.pin().catch(()=>{});
    await msg2.pin().catch(()=>{});
  } catch {}
}

async function postWeeklyTop(leaderboardChannel, tradeLogChannel) {
  const trades = await fetchAllTrades(tradeLogChannel);
  const weekAgo = Date.now() - 7*24*60*60*1000;
  const weekly = trades.filter(t=>t.ts>=weekAgo);
  const best = topN(weekly.filter(t=>t.pnlPct>0), 10, t=>t.pnlPct);
  await leaderboardChannel.send(asListBlock(best, 'Top 10 Weekly (laatste 7 dagen)'));
}

async function postTotals(leaderboardChannel, tradeLogChannel) {
  const trades = await fetchAllTrades(tradeLogChannel);
  const byUser = new Map();
  for (const t of trades) {
    byUser.set(t.user, (byUser.get(t.user)||0) + t.pnlPct);
  }
  const rows = [...byUser.entries()]
    .map(([user,total])=>({user, total}))
    .sort((a,b)=> b.total - a.total)
    .slice(0,25);

  const body = rows.map((r,i)=>{
    const rank = (i+1).toString().padStart(2,' ');
    const pct  = fmtPct(r.total).padStart(9,' ');
    return `${rank}. ${pct}  ${r.user}`;
  }).join('\n');
  const text = `**Trader Totals (All-Time)**\n\`\`\`\n${body || 'Geen trades gevonden'}\n\`\`\``;
  const msg = await leaderboardChannel.send(text);
  try { await msg.pin(); } catch {}
}

// ---------- Boot ----------
client.once('ready', async () => {
  console.log(`Ingelogd als ${client.user.tag}`);
  const guild = await client.guilds.fetch(SERVER_ID);
  const inputCh = await guild.channels.fetch(INPUT_CHANNEL);
  const tradeCh = await guild.channels.fetch(TRADE_LOG_CHANNEL);
  const lbCh = await guild.channels.fetch(LEADERBOARD_CHANNEL);

  // CRON
  // Dagelijks 09:00 → Top 10 Weekly
  cron.schedule('0 9 * * *', async () => {
    await postWeeklyTop(lbCh, tradeCh);
  }, { timezone: TZ });

  // Zondag 20:00 → All-time + Totals
  cron.schedule('0 20 * * 0', async () => {
    await postAllTime(lbCh, tradeCh);
    await postTotals(lbCh, tradeCh);
  }, { timezone: TZ });
});

// ---------- Prefix: !trade add ----------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channelId !== INPUT_CHANNEL) return;
    if (!message.content.startsWith(PREFIX)) return;

    const parts = message.content.trim().split(/\s+/);
    const parsed = parseAddArgs(parts);
    if (!parsed) return; // geen error-spam

    const symbol = parsed.symbol;
    const side   = parsed.side;
    const entry  = parsed.entry;
    const exit   = parsed.exit;
    const lev    = parsed.leverage;

    const pnlPct = calcPnlPct(entry, exit, side, lev);
    const userName = message.author.username; // exact username (bv. moonboy1738)

    // bevestiging in #-input (jouw gewenste regel)
    const inputCh = message.channel;
    await sendInputConfirmation(inputCh, { userName, symbol, side, entry, exit, leverage: lev });

    // trade-log post
    const tradeCh = await client.channels.fetch(TRADE_LOG_CHANNEL);
    await postTradeLog(tradeCh, {
      userName, pnlPct, symbol, side, leverage: lev, entry, exit
    });

  } catch (err) {
    console.error('!trade handler error:', err);
  }
});

// ---------- Slash commands (handmatig triggeren) ----------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await interaction.deferReply({ ephemeral: false });

    const guild = await client.guilds.fetch(SERVER_ID);
    const tradeCh = await guild.channels.fetch(TRADE_LOG_CHANNEL);
    const lbCh = await guild.channels.fetch(LEADERBOARD_CHANNEL);

    if (interaction.commandName === 'lb_alltime') {
      await postAllTime(lbCh, tradeCh);
      await interaction.editReply('All-time Top 25 gepost & gepind.');
      return;
    }
    if (interaction.commandName === 'lb_weekly') {
      await postWeeklyTop(lbCh, tradeCh);
      await interaction.editReply('Top 10 Weekly gepost.');
      return;
    }
    if (interaction.commandName === 'totals') {
      await postTotals(lbCh, tradeCh);
      await interaction.editReply('Trader Totals gepost.');
      return;
    }

    await interaction.editReply('Onbekend commando.');
  } catch (err) {
    console.error('Slash handler error:', err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('Er ging iets mis bij dit commando.');
    } else {
      await interaction.reply({ content: 'Er ging iets mis bij dit commando.', ephemeral: true });
    }
  }
});

client.login(DISCORD_TOKEN);

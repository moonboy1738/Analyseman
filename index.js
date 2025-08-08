import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';
import cron from 'node-cron';

// ---------- ENV ----------
const {
  DISCORD_TOKEN,
  SERVER_ID,
  INPUT_CHANNEL,
  TRADE_LOG_CHANNEL,
  LEADERBOARD_CHANNEL,
  TZ = 'Europe/Amsterdam'
} = process.env;

// ---------- CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ---------- UTILS ----------
const fmt2 = (n) => Number(n).toFixed(4).replace(/\.?0+$/,''); // 4 dp, trim zeros
const fmtMoney = (n) => `$${Number(n).toFixed(4).replace(/\.?0+$/,'')}`;
const signPct = (n) => (n > 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`);
const chip = (text) => `\`${text}\``; // inline-code = “vierkante” chip
const bold = (s) => `**${s}**`;
const nowTs = () => new Date();

// pick beste zichtbare naam (zoals jij wil: servernaam > username)
const visibleName = (member, user) => (member?.displayName ?? user?.username ?? 'Onbekend');

// PnL berekening met leverage
function calcPnl(side, entry, exit, lev) {
  const e = Number(entry), x = Number(exit), L = Number(lev || 1);
  if (!e || !x || !L) return null;
  const base = side.toLowerCase() === 'long'
    ? ((x - e) / e) * 100
    : ((e - x) / e) * 100;
  return base * L;
}

// embed voor TRADE LOG (zoals in je screenshots)
function tradeEmbed({ username, symbol, side, lev, entry, exit, pnl }) {
  const nameLine = `${bold(username)} ${chip(signPct(pnl))}`;
  const body = `${bold(`${symbol.toUpperCase()} ${side.toUpperCase()} ${lev}×`)}\n` +
               `Entry: ${fmtMoney(entry)}\n` +
               `Exit: ${fmtMoney(exit)}`;
  return new EmbedBuilder()
    .setColor(pnl >= 0 ? 0x41b06e : 0xd74242)
    .setAuthor({ name: nameLine })
    .setDescription(body)
    .setFooter({ text: `[ANALYSEMAN-TRADE] by:${username}` })
    .setTimestamp(nowTs());
}

// bevestiging in INPUT kanaal (geen entry/exit regels, exact jouw zin)
function confirmLine({ symbol, side, lev, pnl, username }) {
  return `Trade geregistreerd: ${bold(symbol.toUpperCase())} ${side} ${bold(`${lev}×`)} → ${chip(signPct(pnl))} — door ${bold(username)}`;
}

// link naar specifieke trade message
const tradeLink = (guildId, channelId, messageId) =>
  `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

// parse voor *oude en nieuwe* embeds in trade-log
function parseTradeFromEmbed(msg) {
  if (!msg.embeds?.length) return null;
  const e = msg.embeds[0];

  // username proberen uit footer/author/description
  let username = null;
  if (e.footer?.text?.startsWith('[ANALYSEMAN-TRADE] by:')) {
    username = e.footer.text.split('by:')[1]?.trim();
  }
  if (!username && e.author?.name) {
    // bv "moonboy1738 `+66.14%`" of "moonboy1738 -26.52%"
    username = e.author.name.replace(/`[^`]+`/g,'').replace(/[-+]\d+(\.\d+)?%/g,'').trim();
  }
  if (!username && e.description?.includes('— door')) {
    const m = e.description.match(/— door\s+([^\s*`]+)/i);
    if (m) username = m[1].trim();
  }
  if (!username) username = 'Onbekend';

  // symbol/side/lev uit de **...** regel
  let symbol=null, side=null, lev=1;
  if (e.description) {
    const m = e.description.match(/\*\*([A-Z0-9]+)\s+(LONG|SHORT)\s+(\d+)×\*\*/i);
    if (m) {
      symbol = m[1].toUpperCase();
      side = m[2].toLowerCase();
      lev = Number(m[3]);
    }
  }

  // Entry/Exit
  let entry=null, exit=null;
  if (e.description) {
    const em = e.description.match(/Entry:\s*\$?([0-9.]+)/i);
    const xm = e.description.match(/Exit:\s*\$?([0-9.]+)/i);
    if (em) entry = Number(em[1]);
    if (xm) exit = Number(xm[1]);
  }

  // PnL uit author chip of title of author text
  let pnl=null;
  const pick = `${e.author?.name ?? ''} ${e.title ?? ''} ${e.description ?? ''}`;
  const pm = pick.match(/([+-]?\d+(?:\.\d+)?)%/);
  if (pm) pnl = Number(pm[1]);

  // Als pnl ontbreekt, bereken opnieuw wanneer mogelijk
  if ((pnl === null || Number.isNaN(pnl)) && entry && exit && side) {
    pnl = calcPnl(side, entry, exit, lev);
  }

  if (!symbol || !side || pnl === null) return null;

  return {
    id: msg.id,
    createdAt: msg.createdTimestamp ?? Date.now(),
    username, symbol, side, lev, entry, exit, pnl
  };
}

// alle trades uit #trade-log (volledige historie)
async function fetchAllTrades(tradeLogChannel) {
  const trades = [];
  let lastId = undefined;

  while (true) {
    const batch = await tradeLogChannel.messages.fetch({ limit: 100, before: lastId });
    if (batch.size === 0) break;
    for (const [, m] of batch) {
      const t = parseTradeFromEmbed(m);
      if (t) trades.push(t);
    }
    lastId = batch.last()?.id;
    // safety: niet oneindig
    if (!lastId) break;
  }
  return trades.sort((a,b) => a.createdAt - b.createdAt);
}

// leaderboard render helpers
function renderList(title, items, guildId) {
  const lines = items.map((t, i) =>
    `${String(i+1).padStart(2,' ')}. ${signPct(t.pnl).padStart(7,' ')}  ${t.symbol} ${t.side.toUpperCase()} — door ${t.username} — [Trade](${tradeLink(guildId, TRADE_LOG_CHANNEL, t.id)})`
  );
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(title)
    .setDescription(lines.length ? lines.join('\n') : 'Geen trades gevonden')
    .setFooter({ text: '[ANALYSEMAN-LB]' })
    .setTimestamp(nowTs());
}

function renderTotals(totalsMap) {
  const arr = [...totalsMap.entries()]
    .map(([user, sum]) => ({ user, sum }))
    .sort((a,b) => b.sum - a.sum);
  const lines = arr.map((r, i) =>
    `${String(i+1).padStart(2,' ')}. ${signPct(r.sum).padStart(8,' ')}  — ${r.user}`
  );
  return new EmbedBuilder()
    .setColor(0x3a7bd5)
    .setTitle('Trader Totals (All-Time)')
    .setDescription(lines.length ? lines.join('\n') : 'Geen trades gevonden')
    .setFooter({ text: '[ANALYSEMAN-TOTALS]' })
    .setTimestamp(nowTs());
}

// helpers: pin verversen (oude eigen pins ontpinnen)
async function replacePinnedMessage(channel, tagText, newMsg) {
  try {
    const pins = await channel.messages.fetchPinned();
    const mine = pins.filter(m =>
      m.author?.id === client.user.id &&
      (m.embeds?.[0]?.footer?.text?.includes(tagText) || m.content?.includes(tagText))
    );
    for (const [, m] of mine) {
      try { await m.unpin(); } catch {}
    }
    await newMsg.pin();
  } catch {}
}

// ---------- SLASH COMMANDS ----------
const commands = [
  new SlashCommandBuilder()
    .setName('lb_alltime')
    .setDescription('Top 25 all-time winsten & verliezen (gepinnd).'),
  new SlashCommandBuilder()
    .setName('lb_weekly')
    .setDescription('Top 10 trades uit laatste 7 dagen.'),
  new SlashCommandBuilder()
    .setName('totals')
    .setDescription('Som van alle PnL% per trader (all-time).')
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, SERVER_ID), { body: commands });
  console.log('Slash commands geregistreerd.');
}

// ---------- RUNTIME ----------
client.once('ready', async () => {
  console.log(`Ingelogd als ${client.user.tag}`);
  try { await registerCommands(); } catch (e) { console.error('Cmd register error', e); }

  // CRON: 09:00 dagelijks — weekly top 10 (laatste 7 dagen)
  cron.schedule('0 9 * * *', async () => {
    try {
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL);
      const log = await client.channels.fetch(TRADE_LOG_CHANNEL);
      const trades = await fetchAllTrades(log);
      const cutoff = Date.now() - 7*24*60*60*1000;
      const weekly = trades.filter(t => t.createdAt >= cutoff).sort((a,b) => b.pnl - a.pnl).slice(0,10);
      const embed = renderList('Top 10 (laatste 7 dagen)', weekly, SERVER_ID);
      await ch.send({ embeds: [embed] });
    } catch (e) { console.error('CRON weekly error', e); }
  }, { timezone: TZ });

  // CRON: zondag 20:00 — all-time top 25 & totals (gepinnd)
  cron.schedule('0 20 * * 0', async () => {
    try {
      const ch = await client.channels.fetch(LEADERBOARD_CHANNEL);
      const log = await client.channels.fetch(TRADE_LOG_CHANNEL);
      const trades = await fetchAllTrades(log);

      const wins = [...trades].sort((a,b) => b.pnl - a.pnl).slice(0,25);
      const loss = [...trades].sort((a,b) => a.pnl - b.pnl).slice(0,25);
      const e1 = renderList('Top 25 All-Time winsten', wins, SERVER_ID).setFooter({ text: '[ANALYSEMAN-ALLTIME-WIN]' });
      const e2 = renderList('Top 25 All-Time verliezen', loss, SERVER_ID).setFooter({ text: '[ANALYSEMAN-ALLTIME-LOSS]' });

      const m1 = await ch.send({ embeds: [e1] });
      const m2 = await ch.send({ embeds: [e2] });
      await replacePinnedMessage(ch, '[ANALYSEMAN-ALLTIME-WIN]', m1);
      await replacePinnedMessage(ch, '[ANALYSEMAN-ALLTIME-LOSS]', m2);

      // totals
      const totals = new Map();
      for (const t of trades) totals.set(t.username, (totals.get(t.username) ?? 0) + t.pnl);
      const e3 = renderTotals(totals).setFooter({ text: '[ANALYSEMAN-TOTALS]' });
      const m3 = await ch.send({ embeds: [e3] });
      await replacePinnedMessage(ch, '[ANALYSEMAN-TOTALS]', m3);

    } catch (e) { console.error('CRON alltime/totals error', e); }
  }, { timezone: TZ });
});

// MESSAGE COMMAND: !trade add SYMBOL Side Entry Exit [Leverage]
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.id !== INPUT_CHANNEL) return;

    const content = message.content.trim();
    const re = /^!trade\s+add\s+([a-z0-9$]+)\s+(long|short)\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)\s+([0-9]+)$/i;
    const m = content.match(re);
    if (!m) return;

    const [, symRaw, sideRaw, entryRaw, exitRaw, levRaw] = m;
    const symbol = symRaw.toUpperCase();
    const side = sideRaw.toLowerCase();
    const entry = Number(entryRaw);
    const exit  = Number(exitRaw);
    const lev   = Number(levRaw);

    const member = await message.guild.members.fetch(message.author.id).catch(() => null);
    const username = visibleName(member, message.author);

    const pnl = calcPnl(side, entry, exit, lev);
    if (pnl === null || Number.isNaN(pnl)) {
      await message.reply(`Ongeldige input. Gebruik: \`!trade add SYMBOL SIDE ENTRY EXIT LEVERAGE\``);
      return;
    }

    // post in TRADE LOG
    const tradeLog = await client.channels.fetch(TRADE_LOG_CHANNEL);
    const embed = tradeEmbed({ username, symbol, side, lev, entry, exit, pnl });
    await tradeLog.send({ embeds: [embed] });

    // bevestig in INPUT (exact zinnetje, zonder Entry/Exit)
    await message.reply(confirmLine({ symbol, side, lev, pnl, username }));
  } catch (e) {
    console.error('messageCreate error', e);
  }
});

// SLASH COMMAND HANDLING
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    await interaction.deferReply(); // voorkomt “application did not respond”

    const lb = await client.channels.fetch(LEADERBOARD_CHANNEL);
    const log = await client.channels.fetch(TRADE_LOG_CHANNEL);
    const trades = await fetchAllTrades(log);

    if (interaction.commandName === 'lb_alltime') {
      const wins = [...trades].sort((a,b) => b.pnl - a.pnl).slice(0,25);
      const loss = [...trades].sort((a,b) => a.pnl - b.pnl).slice(0,25);

      const e1 = renderList('Top 25 All-Time winsten', wins, interaction.guildId).setFooter({ text: '[ANALYSEMAN-ALLTIME-WIN]' });
      const e2 = renderList('Top 25 All-Time verliezen', loss, interaction.guildId).setFooter({ text: '[ANALYSEMAN-ALLTIME-LOSS]' });

      const m1 = await lb.send({ embeds: [e1] });
      const m2 = await lb.send({ embeds: [e2] });
      await replacePinnedMessage(lb, '[ANALYSEMAN-ALLTIME-WIN]', m1);
      await replacePinnedMessage(lb, '[ANALYSEMAN-ALLTIME-LOSS]', m2);

      await interaction.editReply('All-time Top 25 gepost & gepind.');
      return;
    }

    if (interaction.commandName === 'lb_weekly') {
      const cutoff = Date.now() - 7*24*60*60*1000;
      const weekly = trades.filter(t => t.createdAt >= cutoff).sort((a,b) => b.pnl - a.pnl).slice(0,10);
      const e = renderList('Top 10 (laatste 7 dagen)', weekly, interaction.guildId);
      await lb.send({ embeds: [e] });
      await interaction.editReply('Weekly Top 10 gepost.');
      return;
    }

    if (interaction.commandName === 'totals') {
      const totals = new Map();
      for (const t of trades) totals.set(t.username, (totals.get(t.username) ?? 0) + t.pnl);
      const e = renderTotals(totals).setFooter({ text: '[ANALYSEMAN-TOTALS]' });
      const m = await lb.send({ embeds: [e] });
      await replacePinnedMessage(lb, '[ANALYSEMAN-TOTALS]', m);
      await interaction.editReply('Trader totals gepost.');
      return;
    }

    await interaction.editReply('Onbekende command.');
  } catch (e) {
    console.error('interaction error', e);
    try {
      await interaction.editReply('Er ging iets mis.');
    } catch {}
  }
});

client.login(DISCORD_TOKEN);

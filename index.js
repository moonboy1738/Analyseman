import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import pkg from 'pg';
import cron from 'node-cron';

const { Pool } = pkg;

// ENV uit Heroku
const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const INPUT_CHANNEL_ID = process.env.INPUT_CHANNEL_ID;
const TRADE_LOG_CHANNEL_ID = process.env.TRADE_LOG_CHANNEL_ID;
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;

// DB (optioneel maar alvast klaar)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('amazonaws.com')
    ? { rejectUnauthorized: false }
    : false
});

async function initDb() {
  if (!process.env.DATABASE_URL) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('Long','Short')),
      entry NUMERIC NOT NULL,
      exit NUMERIC NOT NULL,
      leverage INTEGER NOT NULL,
      pnl NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// Helpers
function calcPnl(side, entry, exit, lev){
  const e = Number(entry), x = Number(exit), L = Number(lev);
  const base = side.toLowerCase()==='short' ? (e - x)/e : (x - e)/e;
  return base * L * 100;
}
const pctBadge = (p) => `\`${p.toFixed(2)}%\``;       // grijze “pill” zoals in je voorbeeld
const multSign = (n) => `${n}\u00D7`;                 // 35×
const money2   = (v) => `$${Number(v).toFixed(2)}`;   // $0.04

async function postTradeLog({author, symbol, side, entry, exit, lev, pnl}) {
  const badge = pctBadge(pnl).replace(/`/g,''); // in de titel zonder backticks
  const desc = [
    `**${symbol.toUpperCase()} ${side} ${multSign(lev)}**`,
    `Entry: ${money2(entry)}`,
    `Exit: ${money2(exit)}`
  ].join('\n');

  const embed = new EmbedBuilder()
    .setAuthor({ name: author })
    .setTitle(badge)
    .setDescription(desc);

  const ch = await client.channels.fetch(TRADE_LOG_CHANNEL_ID);
  await ch.send({ embeds: [embed] });
}

async function handleTradeMsg(message, parts) {
  // parts: ["!trade","add","PENG","Long","0.03674","0.03755","30"]
  if (parts.length < 7 || parts[1].toLowerCase() !== 'add') return;

  const symbol = parts[2];
  const side = /^s/i.test(parts[3]) ? 'Short' : 'Long';
  const entry = Number(parts[4]);
  const exit  = Number(parts[5]);
  const lev   = parseInt(parts[6], 10);

  if ([entry, exit, lev].some(v => Number.isNaN(v))) {
    await message.reply('Formaat: `!trade add <SYM> <Long|Short> <entry> <exit> <leverage>`');
    return;
  }

  const pnl = calcPnl(side, entry, exit, lev);

  // Antwoord in 🖊️｜input — EXACT zoals je voorbeeld 1
  const inputEmbed = new EmbedBuilder()
    .setDescription(`**Trade geregistreerd:** **${symbol.toUpperCase()} ${side} ${multSign(lev)}** → ${pctBadge(pnl)}`);

  await message.channel.send({ embeds: [inputEmbed] });

  // Opslaan
  try {
    if (process.env.DATABASE_URL) {
      await pool.query(
        `INSERT INTO trades (user_id, username, symbol, side, entry, exit, leverage, pnl)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [message.author.id, message.author.username, symbol.toUpperCase(), side, entry, exit, lev, pnl]
      );
    }
  } catch (e) {
    console.error('DB insert error', e);
  }

  // Post naar 📝｜trade-log — layout zoals je voorbeeld 2
  await postTradeLog({
    author: message.author.username,
    symbol, side, entry, exit, lev, pnl
  });
}

// Listeners
client.on('ready', async () => {
  await initDb();
  console.log(`Logged in as ${client.user.tag}`);
});

// Klassiek !trade commando (alleen in INPUT_CHANNEL_ID)
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== INPUT_CHANNEL_ID) return;
  if (!message.content.toLowerCase().startsWith('!trade')) return;

  const parts = message.content.trim().split(/\s+/);
  try { await handleTradeMsg(message, parts); }
  catch (e) { console.error('handleTrade error', e); }
});

// (optioneel) cron placeholders voor leaderboards
cron.schedule('0 20 * * 0', async () => {
  // TODO: leaderboard post naar LEADERBOARD_CHANNEL_ID
});
cron.schedule('0 9 * * *', async () => {
  // TODO: weekly top 10 post naar LEADERBOARD_CHANNEL_ID
});

client.login(TOKEN);

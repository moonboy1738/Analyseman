// ===== Analyseman — FINAL FINAL =====
// Trader uit alle embed-delen, PnL uit alle embed-delen, unicode minus, Entry/Exit fallback,
// nooit entries droppen op naam → altijd Top 50, strakke 1-regel output.

const cron = require('node-cron');
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  REST, Routes, SlashCommandBuilder, PermissionFlagsBits
} = require('discord.js');

const TRADE_LOG_ID = process.env.TRADE_LOG_CHANNEL || '1395887706755829770';
const LEADERBOARD_ID = process.env.LEADERBOARD_CHANNEL || '1395887166890184845';
const TZ = process.env.TZ || 'Europe/Amsterdam';
const GUILD_ID = process.env.GUILD_ID || process.env.SERVER_ID || null;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

// ---------- utils ----------
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const pad=(n,len)=>String(n).padStart(len,'0');

function normalizeNumber(raw){
  if(raw==null) return null;
  const s = String(raw)
    .replace(/\s+/g,'')
    .replace(/[’‘‚]/g,"'")
    .replace(/[€$]/g,'')
    .replace(/(?<=\d)[._](?=\d{3}\b)/g,'') // 1.000 -> 1000
    .replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function expandK(n){
  if(typeof n!=='string') return n;
  const m = n.match(/^([+\-\u2212\u2013]?\d+(?:[.,]\d+)?)[kK]$/);
  if(!m) return n;
  const base = normalizeNumber(m[1]);
  return base!=null ? String(base*1000) : n;
}
function computePnlPercent({side,entry,exit}){
  if(![entry,exit].every(Number.isFinite)) return null;
  const ch = (exit-entry)/entry;
  const dir = side?.toUpperCase()==='SHORT' ? -ch : ch;
  return dir*100;
}

// Gather ALL text from the message & embeds
function extractAllTextParts(msg){
  const parts = [];
  if (msg.content) parts.push(msg.content);
  for (const e of msg.embeds || []) {
    if (e.author?.name) parts.push(e.author.name);
    if (e.title) parts.push(e.title);
    if (e.description) parts.push(e.description);
    if (Array.isArray(e.fields)) {
      for (const f of e.fields) {
        if (f?.name) parts.push(f.name);
        if (f?.value) parts.push(f.value);
      }
    }
    if (e.footer?.text) parts.push(e.footer.text);
  }
  return parts
    .filter(Boolean)
    .map(t=>t.replace(/```[\s\S]*?```/g,' ')
             .replace(/`/g,' ')
             .replace(/\*\*/g,' ')
             .replace(/<:[A-Za-z0-9_]+:\d+>/g,' ')
             .replace(/\n+/g,' ')
             .trim())
    .join(' ');
}

// ---------- strong field extractors ----------
// Pull Entry/Exit specifically from any part (fields, desc, etc.)
function findEntryExit(allText){
  // Try "Entry: $123" / "Exit: 123.45" (case-insensitive)
  const eM = allText.match(/\bentry\b\s*[:\-]?\s*([+\-\u2212\u2013]?\$?[\d.,kK]+)/i);
  const xM = allText.match(/\b(exit|close|sluit)\b\s*[:\-]?\s*([+\-\u2212\u2013]?\$?[\d.,kK]+)/i);
  const entry = eM ? normalizeNumber(expandK(eM[1])) : null;
  const exit  = xM ? normalizeNumber(expandK(xM[2])) : null;
  return { entry, exit };
}

function findSide(allText){
  const m = allText.match(/\b(LONG|SHORT)\b/i);
  return m ? m[1].toUpperCase() : null;
}
function findLev(allText){
  const m = allText.match(/(\d+(?:[.,]\d+)?)\s*x\b/i);
  return m ? normalizeNumber(m[1]) : null;
}
function findSymbol(allText){
  // BTC, ETH, SOL, BTCUSDT, ETH/USD, etc.
  const m = allText.match(/\b([A-Z]{2,12})(?:-?PERP|USDT|USD|USDC)?\b/) || allText.match(/\b([A-Z]{2,12})\/[A-Z]{2,6}\b/);
  if (!m) return null;
  return (m[1]||m[0]).toUpperCase().replace(/[^A-Z]/g,'').replace(/(USDT|USD|USDC)$/,'');
}

// Try to find a single percentage anywhere (supports +, -, −, –)
function findAnyPercent(allText){
  const matches = [...allText.matchAll(/([+\-\u2212\u2013]?[\d.,]+)\s*%/g)]
    .map(m=>normalizeNumber(m[1]))
    .filter(Number.isFinite);
  // If there are many, don't trust it; return null and use compute or labeled paths
  if (matches.length===1) return matches[0];
  return null;
}

// Prefer PnL from labels or embed author if present
function findLabeledPnl(msg){
  // check author name for % first
  for (const e of msg.embeds || []) {
    const n = e?.author?.name;
    if (n){
      const m = n.match(/([+\-\u2212\u2013]?[\d.,]+)\s*%/);
      if (m) {
        const v = normalizeNumber(m[1]);
        if (Number.isFinite(v) && Math.abs(v)<=5000) return v;
      }
    }
  }
  // labeled words near %
  const t = extractAllTextParts(msg);
  const m = t.match(/\b(pnl|p&l|roi|return)\b[^%+\-\u2212\u2013]*([+\-\u2212\u2013]?[\d.,]+)\s*%/i);
  if (m){
    const v = normalizeNumber(m[2]);
    if (Number.isFinite(v) && Math.abs(v)<=5000) return v;
  }
  return null;
}

// detect Trader name from multiple places
async function detectTraderName(msg){
  // 1) first mention → displayName
  const mUser = msg.mentions?.users?.first();
  if (mUser) {
    const mem = await msg.guild.members.fetch(mUser.id).catch(()=>null);
    return mem?.displayName || mUser.globalName || mUser.username || 'Onbekend';
  }

  // 2) embed author name (might be "mellabr −100.08%")
  for (const e of msg.embeds || []) {
    const n = e?.author?.name;
    if (n){
      const m = n.match(/^(.+?)\s+[+\-\u2212\u2013]?[\d.,]+\s*%/);
      if (m) return m[1].trim();
      if (!n.includes('%')) return n.trim();
    }
  }

  // 3) embed footer
  for (const e of msg.embeds || []) {
    const f = e?.footer?.text;
    if (f && f.length>=2 && f.length<=64) return f.trim();
  }

  const t = extractAllTextParts(msg);

  // 4) "by <name>" / "door <name>"
  const by = t.match(/\b(by|door)\s+([A-Za-z0-9_.\- ]{2,32})\b/i);
  if (by) return by[2].trim();

  // 5) mention id present in text
  const idm = t.match(/<@!?(\d+)>/);
  if (idm) {
    const u = await msg.guild.members.fetch(idm[1]).catch(()=>null);
    if (u) return u.displayName || u.user?.globalName || u.user?.username || 'Onbekend';
  }

  // 6) plain @name token
  const at = t.match(/@([A-Za-z0-9_.\-]{2,32})/);
  if (at) return at[1];

  // 7) fallback: human author
  if (!msg.author?.bot) {
    const m = await msg.guild.members.fetch(msg.author.id).catch(()=>null);
    return m?.displayName || msg.author.globalName || msg.author.username || 'Onbekend';
  }
  return 'Onbekend';
}

// ---------- fetch all messages ----------
async function fetchAllMessages(channel, days=null){
  const out=[]; let lastId; const cutoff = days ? Date.now()-days*86400000 : null;
  while(true){
    const opts={limit:100}; if(lastId) opts.before=lastId;
    const batch=await channel.messages.fetch(opts);
    if(batch.size===0) break;
    for(const m of batch.values()){
      if(cutoff && m.createdTimestamp<cutoff) return out;
      out.push(m);
    }
    lastId=batch.last().id;
    await sleep(250);
  }
  return out;
}

// ---------- parse trade ----------
async function parseTrade(msg){
  const allText = extractAllTextParts(msg);
  if (!allText) return null;

  const side = findSide(allText);
  const { entry, exit } = findEntryExit(allText);
  const lev = findLev(allText);
  const symbol = findSymbol(allText);

  // PnL priority: labeled → author → single % → compute → (else null)
  let pnl = findLabeledPnl(msg);
  if (pnl==null) {
    const one = findAnyPercent(allText);
    if (one!=null) pnl = one;
  }
  if (pnl==null) {
    const comp = computePnlPercent({ side, entry, exit });
    if (comp!=null) pnl = comp;
  }
  if (pnl==null || !Number.isFinite(pnl)) return null;
  pnl = clamp(pnl, -5000, 5000);

  const trader = await detectTraderName(msg);
  const guildId = msg.guild?.id || '000000000000000000';
  const link = `https://discord.com/channels/${guildId}/${msg.channelId}/${msg.id}`;
  return { pnl, side, entry, exit, lev, symbol, trader, link, ts: msg.createdTimestamp };
}

// ---------- formatting ----------
function medal(i){ return i===0?'🥇':i===1?'🥈':i===2?'🥉':`${pad(i+1,2)}.`; }
function line(i,t){
  const pnl = `${t.pnl>=0?'+':''}${t.pnl.toFixed(2)}%`;
  const sym = t.symbol || '—';
  const side = t.side || '—';
  const lev = t.lev ? `${t.lev}x` : '—';
  const who = t.trader || 'Onbekend';
  return `${medal(i)}  ${pnl}  ${sym}  ${side}  ${lev}  by ${who} — [Trade](${t.link})`;
}

async function buildLeaderboard(days=7, topN=10, wins=true){
  const ch = await client.channels.fetch(TRADE_LOG_ID);
  const msgs = await fetchAllMessages(ch, days);

  const trades=[];
  for(const m of msgs){
    const t = await parseTrade(m);
    if (t) trades.push(t);
  }

  const sorted = trades.sort((a,b)=> wins ? b.pnl-a.pnl : a.pnl-b.pnl);
  const top = sorted.slice(0, topN);
  const desc = top.length ? top.map((t,i)=>line(i,t)).join('\n').slice(0,3900) : '_Geen geldige trades gevonden._';

  return new EmbedBuilder()
    .setColor(wins?0x2ecc71:0xe74c3c)
    .setTitle(wins ? `Top ${topN} ${days?`${days}-daagse`:'All-Time'} winsten`
                   : `Top ${topN} ${days?`${days}-daagse`:'All-Time'} verliezen`)
    .setDescription(desc)
    .setFooter({ text: wins ? (days ? '[ANALYSEMAN-DAILY]' : '[ANALYSEMAN-ALLTIME-WIN]') : (days ? '[ANALYSEMAN-DAILY-LOSS]' : '[ANALYSEMAN-ALLTIME-LOSS]') })
    .setTimestamp();
}

async function postAndPin(embed, tag){
  const lb = await client.channels.fetch(LEADERBOARD_ID);
  const pins = await lb.messages.fetchPinned();
  const old = pins.find(p=>p.embeds[0]?.footer?.text===tag);
  if (old) await old.unpin().catch(()=>{});
  const sent = await lb.send({ embeds: [embed] });
  await sent.pin().catch(()=>{});
}

// ---------- jobs ----------
async function runWeeklyTop10(){ const e=await buildLeaderboard(7,10,true); await postAndPin(e,'[ANALYSEMAN-DAILY]'); }
async function runAllTimeTop50(){
  const w=await buildLeaderboard(null,50,true);
  const l=await buildLeaderboard(null,50,false);
  await postAndPin(w,'[ANALYSEMAN-ALLTIME-WIN]');
  await postAndPin(l,'[ANALYSEMAN-ALLTIME-LOSS]');
}

// ---------- ready ----------
client.once('ready', async ()=>{
  console.log(`[Analyseman] Ingelogd als ${client.user.tag}`);

  const tradeLog = await client.channels.fetch(TRADE_LOG_ID);
  const leaderboard = await client.channels.fetch(LEADERBOARD_ID);
  const me = await leaderboard.guild.members.fetch(client.user.id);

  const need=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ManageMessages];
  const okTrade = need.every(p=>tradeLog.permissionsFor(me)?.has(p));
  const okLB = need.every(p=>leaderboard.permissionsFor(me)?.has(p));
  console.log(`[Analyseman] Perms trade-log OK: ${okTrade}, leaderboard OK: ${okLB}`);

  cron.schedule('0 9 * * *', async ()=>{
    try { await runWeeklyTop10(); } catch(e){ console.error('Daily job error:', e); }
  }, { timezone: TZ });

  cron.schedule('0 20 * * 0', async ()=>{
    try { await runAllTimeTop50(); } catch(e){ console.error('Weekly job error:', e); }
  }, { timezone: TZ });

  try{
    const cmds = [
      new SlashCommandBuilder().setName('lb_daily').setDescription('Post de Top 10 van de week (nu)'),
      new SlashCommandBuilder().setName('lb_alltime').setDescription('Post de Top 50 all-time wins & losses (nu)')
    ].map(c=>c.toJSON());
    const rest = new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: cmds });
      console.log('[Analyseman] Slash commands geregistreerd voor guild:', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
      console.warn('[Analyseman] Geen GUILD_ID, commands global (kan ~1u duren).');
    }
  } catch(e){ console.error('[Analyseman] Slash cmd deploy error:', e); }
});

// ---------- interactions ----------
client.on('interactionCreate', async (i)=>{
  if(!i.isChatInputCommand()) return;

  if(i.commandName==='lb_daily'){
    await i.deferReply({ephemeral:true});
    i.editReply('⏳ Week leaderboard wordt berekend…');
    try { await runWeeklyTop10(); await i.editReply('✅ Week Top 10 gepost & gepind.'); }
    catch(e){ console.error(e); await i.editReply('❌ Fout bij posten van Week Top 10.'); }
  }

  if(i.commandName==='lb_alltime'){
    await i.deferReply({ephemeral:true});
    i.editReply('⏳ All-time leaderboards worden berekend… (kan even duren)');
    try { await runAllTimeTop50(); await i.editReply('✅ All-time Top 50 wins & losses gepost & gepind.'); }
    catch(e){ console.error(e); await i.editReply('❌ Fout bij posten van All-time Top 50.'); }
  }
});

client.login(process.env.DISCORD_TOKEN);

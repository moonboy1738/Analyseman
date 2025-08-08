// ===== Analyseman — trader uit content/mentions/embeds + strakke lijst =====
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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ---------- utils ----------
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const pad=(n,len)=>String(n).padStart(len,'0');

function normalizeNumber(raw){
  if(raw==null) return null;
  const s=String(raw)
    .replace(/\s+/g,'').replace(/[’‘‚]/g,"'")
    .replace(/[€$]/g,'').replace(/(?<=\d)[._](?=\d{3}\b)/g,'')
    .replace(',', '.');
  const n=parseFloat(s); return Number.isFinite(n)?n:null;
}
function expandK(n){
  if(typeof n!=='string') return n;
  const m=n.match(/^([\-+]?\d+(?:[.,]\d+)?)[kK]$/);
  if(!m) return n;
  const base=normalizeNumber(m[1]); return base!=null?String(base*1000):n;
}
function computePnlPercent({side,entry,exit}){
  if(![entry,exit].every(Number.isFinite)) return null;
  const ch=(exit-entry)/entry;
  const dir=side?.toUpperCase()==='SHORT'?-ch:ch;
  return dir*100;
}

// combine content + embed texts
function extractText(msg){
  let t = msg.content || '';
  for(const e of msg.embeds||[]){
    if(e.title) t += ' ' + e.title;
    if(e.description) t += ' ' + e.description;
    for(const f of e.fields||[]) if(f?.value) t += ' ' + f.value;
    if(e.footer?.text) t += ' ' + e.footer.text;
  }
  return t.replace(/```[\s\S]*?```/g,' ').replace(/`/g,' ').replace(/\*\*/g,' ')
          .replace(/<:[A-Za-z0-9_]+:\d+>/g,' ').replace(/\n+/g,' ').trim();
}

// trader name detection from mentions/content/embeds
async function detectTraderName(msg){
  // 1) first mentioned user
  const mUser = msg.mentions?.users?.first();
  if (mUser) {
    try {
      const member = await msg.guild.members.fetch(mUser.id).catch(()=>null);
      return member?.displayName || mUser.globalName || mUser.username || 'Onbekend';
    } catch { /* ignore */ }
  }
  const raw = extractText(msg);

  // 2) explicit "by <name>" / "door <name>"
  const by = raw.match(/\b(by|door)\s+([A-Za-z0-9_.\- ]{2,32})\b/i);
  if (by) return by[2].trim();

  // 3) mention id in raw text like <@123...>
  const idm = raw.match(/<@!?(\d+)>/);
  if (idm) {
    try {
      const u = await msg.guild.members.fetch(idm[1]).catch(()=>null);
      return u?.displayName || u?.user?.globalName || u?.user?.username || 'Onbekend';
    } catch { /* ignore */ }
  }

  // 4) fallback: something like @MoonBoy / @moon_boy
  const at = raw.match(/@([A-Za-z0-9_.\-]{2,32})/);
  if (at) return at[1];

  // last resort: if author is NOT a bot, use it
  if (!msg.author?.bot) {
    const m = await msg.guild.members.fetch(msg.author.id).catch(()=>null);
    return m?.displayName || msg.author.globalName || msg.author.username || 'Onbekend';
  }
  return 'Onbekend';
}

// ---------- message fetcher ----------
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

// ---------- extraction ----------
function extractPnl(raw, side, entry, exit){
  // prefer labels
  const labeled = raw.match(/\b(pnl|p&l|roi|return)\b[^%\-+]*([-+]?[\d.,]+)\s*%/i);
  if (labeled) {
    const v = normalizeNumber(labeled[2]);
    if (Number.isFinite(v) && Math.abs(v)<=2000) return v;
  }
  if (side && entry!=null && exit!=null) {
    const v = computePnlPercent({side,entry,exit});
    if (Number.isFinite(v) && Math.abs(v)<=2000) return v;
  }
  const all = [...raw.matchAll(/([-+]?[\d.,]+)\s*%/g)]
    .map(m=>normalizeNumber(m[1])).filter(Number.isFinite);
  if (all.length===1 && Math.abs(all[0])<=2000) return all[0];
  return null;
}

function parseTradeStruct(raw){
  const side = raw.match(/\b(LONG|SHORT)\b/i)?.[1]?.toUpperCase() || null;
  // symbol
  let symbol=null;
  const sym = raw.match(/\b([A-Z]{2,12})(?:-?PERP|USDT|USD|USDC)?\b/) || raw.match(/\b([A-Z]{2,12})\/[A-Z]{2,6}\b/);
  if (sym) {
    symbol = (sym[1]||sym[0]).toUpperCase().replace(/[^A-Z]/g,'').replace(/(USDT|USD|USDC)$/,'');
  }
  const entry = normalizeNumber(expandK(raw.match(/\b(entry|ingang|open|in)\b[:\s-]*([\-+]?[\d.,kK]+)/i)?.[2]));
  const exit  = normalizeNumber(expandK(raw.match(/\b(exit|close|out|sluit)\b[:\s-]*([\-+]?[\d.,kK]+)/i)?.[2]));
  const lev   = normalizeNumber(raw.match(/(\d+(?:[.,]\d+)?)\s*x\b/i)?.[1]);
  let pnl = extractPnl(raw, side, entry, exit);
  if (pnl==null) return null;
  pnl = clamp(pnl,-2000,2000);
  return { side, symbol, entry, exit, lev, pnl };
}

async function parseTrade(msg){
  const raw = extractText(msg);
  if (!raw) return null;

  const t = parseTradeStruct(raw);
  if (!t) return null;

  const trader = await detectTraderName(msg);
  const guildId = msg.guild?.id || '000000000000000000';
  const link = `https://discord.com/channels/${guildId}/${msg.channelId}/${msg.id}`;
  return { ...t, trader, link, ts: msg.createdTimestamp };
}

// ---------- formatting ----------
function line(i,t){
  const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`${pad(i+1,2)}.`;
  const pnl = `${t.pnl>=0?'+':''}${t.pnl.toFixed(2)}%`;
  const sym = t.symbol || '—';
  const side = t.side || '—';
  const lev = t.lev ? `${t.lev}x` : '—';
  return `${medal}  ${pnl}  ${sym}  ${side}  ${lev}  by ${t.trader} — [Trade](${t.link})`;
}

async function buildLeaderboard(days=7, topN=10, wins=true){
  const ch = await client.channels.fetch(TRADE_LOG_ID);
  const msgs = await fetchAllMessages(ch, days);
  const trades = [];
  for (const m of msgs) {
    const t = await parseTrade(m); if (t) trades.push(t);
  }
  const sorted = trades.sort((a,b)=> wins ? b.pnl-a.pnl : a.pnl-b.pnl);
  const top = sorted.slice(0, topN);
  const desc = top.length ? top.map((t,i)=>line(i,t)).join('\n').slice(0,3900) : '_Geen geldige trades gevonden in de periode._';

  const embed = new EmbedBuilder()
    .setColor(wins?0x2ecc71:0xe74c3c)
    .setTitle(wins
      ? `Top ${topN} ${days?`${days}-daagse`:'All-Time'} winsten`
      : `Top ${topN} ${days?`${days}-daagse`:'All-Time'} verliezen`
    )
    .setDescription(desc)
    .setFooter({ text: wins ? (days ? '[ANALYSEMAN-DAILY]' : '[ANALYSEMAN-ALLTIME-WIN]') : (days ? '[ANALYSEMAN-DAILY-LOSS]' : '[ANALYSEMAN-ALLTIME-LOSS]') })
    .setTimestamp();
  return embed;
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
  const need = [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages,
  ];
  const okTrade = need.every(p=>tradeLog.permissionsFor(me)?.has(p));
  const okLB = need.every(p=>leaderboard.permissionsFor(me)?.has(p));
  console.log(`[Analyseman] Perms trade-log OK: ${okTrade}, leaderboard OK: ${okLB}`);

  cron.schedule('0 9 * * *', async ()=>{
    console.log('[Analyseman] Trigger: daily weekly top10 (09:00 Europe/Amsterdam)');
    try { await runWeeklyTop10(); console.log('[Analyseman] Daily top10 posted.'); }
    catch(e){ console.error('[Analyseman] Daily job error:', e); }
  }, { timezone: TZ });

  cron.schedule('0 20 * * 0', async ()=>{
    console.log('[Analyseman] Trigger: all-time top50 (zondag 20:00 Europe/Amsterdam)');
    try { await runAllTimeTop50(); console.log('[Analyseman] All-time top50 posted.'); }
    catch(e){ console.error('[Analyseman] Weekly job error:', e); }
  }, { timezone: TZ });

  // register slash commands (guild = instant)
  try{
    const cmds = [
      new SlashCommandBuilder().setName('lb_daily').setDescription('Post de Top 10 van de week (nu)'),
      new SlashCommandBuilder().setName('lb_alltime').setDescription('Post de Top 50 all-time wins & losses (nu)')
    ].map(c=>c.toJSON());
    const rest = new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
    if (GUILD_ID){
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: cmds });
      console.log('[Analyseman] Slash commands geregistreerd voor guild:', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
      console.warn('[Analyseman] Geen GUILD_ID/SERVER_ID, commands GLOBAL (kan ~1u duren).');
    }
  } catch(e){ console.error('[Analyseman] Slash cmd deploy error:', e); }
});

client.on('interactionCreate', async (i)=>{
  if(!i.isChatInputCommand()) return;

  if(i.commandName==='lb_daily'){
    await i.deferReply({ephemeral:true}); i.editReply('⏳ Week leaderboard wordt berekend…');
    try { await runWeeklyTop10(); await i.editReply('✅ Week Top 10 gepost & gepind.'); }
    catch(e){ console.error(e); await i.editReply('❌ Fout bij posten van Week Top 10.'); }
  }

  if(i.commandName==='lb_alltime'){
    await i.deferReply({ephemeral:true}); i.editReply('⏳ All-time leaderboards worden berekend…');
    try { await runAllTimeTop50(); await i.editReply('✅ All-time Top 50 wins & losses gepost & gepind.'); }
    catch(e){ console.error(e); await i.editReply('❌ Fout bij posten van All-time Top 50.'); }
  }
});

client.login(process.env.DISCORD_TOKEN);

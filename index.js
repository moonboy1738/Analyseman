// ===== Analyseman — Leaderboards (Top 25 all-time, Top 10 weekly) =====
const cron = require('node-cron');
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  REST, Routes, SlashCommandBuilder, PermissionFlagsBits
} = require('discord.js');

// === ENV / fallback ===
const TRADE_LOG_ID   = process.env.TRADE_LOG_CHANNEL   || '1395887706755829770';
const LEADERBOARD_ID = process.env.LEADERBOARD_CHANNEL || '1395887166890184845';
const TZ             = process.env.TZ || 'Europe/Amsterdam';
const GUILD_ID       = process.env.GUILD_ID || process.env.SERVER_ID || null;

const WEEKLY_TOPN    = 10;
const ALLTIME_TOPN   = 25;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

// ---------- small utils ----------
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const pad=(n,l)=>String(n).padStart(l,'0');

function normalizeNumber(raw){
  if(raw==null) return null;
  const s=String(raw)
    .replace(/\s+/g,'')
    .replace(/[’‘‚]/g,"'")
    .replace(/[€$]/g,'')
    .replace(/(?<=\d)[._](?=\d{3}\b)/g,'')
    .replace(',', '.');
  const n=parseFloat(s);
  return Number.isFinite(n)?n:null;
}
function expandK(n){
  if(typeof n!=='string') return n;
  const m=n.match(/^([+\-\u2212\u2013]?\d+(?:[.,]\d+)?)[kK]$/);
  if(!m) return n;
  const base=normalizeNumber(m[1]);
  return base!=null?String(base*1000):n;
}
function computePnlPercent({side,entry,exit}){
  if(![entry,exit].every(Number.isFinite)) return null;
  const ch=(exit-entry)/entry;
  const dir=side?.toUpperCase()==='SHORT'?-ch:ch;
  return dir*100;
}

// ---------- collect text from a message/embeds ----------
function gatherParts(msg){
  const parts=[];
  if(msg.content) parts.push(msg.content);
  for(const e of msg.embeds||[]){
    if(e.author?.name) parts.push(e.author.name);
    if(e.title) parts.push(e.title);
    if(e.description) parts.push(e.description);
    for(const f of e.fields||[]){
      if(f?.name) parts.push(f.name);
      if(f?.value) parts.push(f.value);
    }
    if(e.footer?.text) parts.push(e.footer.text);
  }
  return parts.filter(Boolean).map(t=>t
    .replace(/```[\s\S]*?```/g,' ')
    .replace(/`/g,' ')
    .replace(/\*\*/g,' ')
    .replace(/<:[A-Za-z0-9_]+:\d+>/g,' ')
    .replace(/\n+/g,' ')
    .trim());
}
function extractAllText(msg){ return gatherParts(msg).join(' '); }

// ---------- field finders ----------
function findEntryExit(text){
  const eM=text.match(/\bentry\b\s*[:\-]?\s*([+\-\u2212\u2013]?\$?[\d.,kK]+)/i);
  const xM=text.match(/\b(exit|close|sluit)\b\s*[:\-]?\s*([+\-\u2212\u2013]?\$?[\d.,kK]+)/i);
  return {
    entry: eM ? normalizeNumber(expandK(eM[1])) : null,
    exit : xM ? normalizeNumber(expandK(xM[2])) : null
  };
}
function findSide(text){
  const m=text.match(/\b(LONG|SHORT)\b/i);
  return m ? m[1].toUpperCase() : null;
}
function findLev(text){
  const m=text.match(/(\d+(?:[.,]\d+)?)\s*x\b/i);
  return m ? normalizeNumber(m[1]) : null;
}
function findSymbol(text){
  const m = text.match(/\b([A-Z]{2,12})(?:-?PERP|USDT|USD|USDC)?\b/) || text.match(/\b([A-Z]{2,12})\/[A-Z]{2,6}\b/);
  if(!m) return null;
  return (m[1]||m[0]).toUpperCase().replace(/[^A-Z]/g,'').replace(/(USDT|USD|USDC)$/,'');
}

// ---------- PnL extraction ----------
function findAnyPercent(text){
  const list=[...text.matchAll(/([+\-\u2212\u2013]?[\d.,]+)\s*%/g)]
    .map(m=>normalizeNumber(m[1])).filter(Number.isFinite);
  return list.length===1 ? list[0] : null;
}
function findLabeledPnl(msg){
  // author
  for(const e of msg.embeds||[]){
    const n=e?.author?.name;
    if(n){
      const m=n.match(/([+\-\u2212\u2013]?[\d.,]+)\s*%/);
      if(m){ const v=normalizeNumber(m[1]); if(Number.isFinite(v)&&Math.abs(v)<=5000) return v; }
    }
  }
  const parts=gatherParts(msg);
  // "pnl/p&l/roi" labels
  for(const p of parts){
    const m=p.match(/\b(pnl|p&l|roi|return)\b[^%+\-\u2212\u2013]*([+\-\u2212\u2013]?[\d.,]+)\s*%/i);
    if(m){ const v=normalizeNumber(m[2]); if(Number.isFinite(v)&&Math.abs(v)<=5000) return v; }
  }
  // any single percent in a part
  for(const p of parts){
    const list=[...p.matchAll(/([+\-\u2212\u2013]?[\d.,]+)\s*%/g)].map(m=>normalizeNumber(m[1])).filter(Number.isFinite);
    if(list.length===1 && Math.abs(list[0])<=5000) return list[0];
  }
  return null;
}

// ---------- Trader detection ----------
function tidyName(s){ return s.replace(/[*_|~`><]/g,'').trim(); }
function firstWord(line){
  const m=line.match(/^([A-Za-z0-9_.\-]{2,32})\b/);
  return m ? m[1] : null;
}
async function detectTraderName(msg){
  // 0) eerste regel van description (badge bovenaan)
  for(const e of msg.embeds||[]){
    if(e?.description){
      const firstLine=e.description.split('\n')[0].trim();
      const name = firstWord(tidyName(firstLine));
      if(name) return name;
    }
  }
  // EXTRA: globale badge "naam  −100.08%" in de samengestelde tekst
  {
    const t = extractAllText(msg);
    const mm = t.match(/^([A-Za-z0-9_.\-]{2,32})\s+[+\-\u2212\u2013]?[\d.,]+\s*%/);
    if (mm) return tidyName(mm[1]);
  }
  // 1) user mention
  const mUser=msg.mentions?.users?.first();
  if(mUser){ const mem=await msg.guild.members.fetch(mUser.id).catch(()=>null);
    return mem?.displayName || mUser.globalName || mUser.username || 'Onbekend';
  }
  // 2) embed author
  for(const e of msg.embeds||[]){
    const n=e?.author?.name;
    if(n){
      const m=n.match(/^(.+?)\s+[+\-\u2212\u2013]?[\d.,]+\s*%/);
      if(m) return tidyName(m[1]);
      if(!n.includes('%')) return tidyName(n);
    }
  }
  // 3) footer
  for(const e of msg.embeds||[]){
    const f=e?.footer?.text;
    if(f && f.length>=2 && f.length<=64) return tidyName(f);
  }
  // 4) "by/door NAME"
  const text=extractAllText(msg);
  const by=text.match(/\b(by|door)\s+([A-Za-z0-9_.\- ]{2,32})\b/i);
  if(by) return tidyName(by[2]);
  // 5) raw mention id
  const idm=text.match(/<@!?(\d+)>/);
  if(idm){
    const u=await msg.guild.members.fetch(idm[1]).catch(()=>null);
    if(u) return u.displayName || u.user?.globalName || u.user?.username || 'Onbekend';
  }
  // 6) @token
  const at=text.match(/@([A-Za-z0-9_.\-]{2,32})/);
  if(at) return tidyName(at[1]);
  // 7) non-bot author fallback
  if(!msg.author?.bot){
    const m=await msg.guild.members.fetch(msg.author.id).catch(()=>null);
    return m?.displayName || msg.author.globalName || msg.author.username || 'Onbekend';
  }
  return 'Onbekend';
}

// ---------- fetch all messages (streamed) ----------
async function fetchAllMessages(channel, days=null){
  const out=[]; let lastId; const cutoff=days?Date.now()-days*86400000:null;
  while(true){
    const opts={limit:100}; if(lastId) opts.before=lastId;
    const batch=await channel.messages.fetch(opts);
    if(batch.size===0) break;
    for(const m of batch.values()){
      if(cutoff && m.createdTimestamp<cutoff) return out;
      out.push(m);
    }
    lastId=batch.last().id;
    // even ademen om rate limits te ontwijken
    await sleep(200);
  }
  return out;
}

// ---------- parse → trade object ----------
async function parseTrade(msg){
  const text = extractAllText(msg);
  if(!text) return null;

  const side = findSide(text);
  const {entry, exit} = findEntryExit(text);
  const lev = findLev(text);
  const symbol = findSymbol(text);

  let pnl = findLabeledPnl(msg);
  if(pnl==null){
    const any=findAnyPercent(text);
    if(any!=null) pnl=any;
  }
  if(pnl==null){
    const calc=computePnlPercent({side,entry,exit});
    if(calc!=null) pnl=calc;
  }
  if(pnl==null || !Number.isFinite(pnl)) return null;
  pnl = clamp(pnl,-5000,5000);

  const trader = await detectTraderName(msg);
  const guildId = msg.guild?.id || '000000000000000000';
  const link = `https://discord.com/channels/${guildId}/${msg.channelId}/${msg.id}`;

  return { pnl, side, entry, exit, lev, symbol, trader, link, ts: msg.createdTimestamp };
}

// ---------- formatting & chunking ----------
function medal(i){ return i===0?'🥇':i===1?'🥈':i===2?'🥉':`${pad(i+1,2)}.`; }
function line(i,t){
  const pnl = `${t.pnl>=0?'+':''}${t.pnl.toFixed(2)}%`;
  const sym = t.symbol || '—';
  const side = t.side || '—';
  const lev = t.lev ? `${t.lev}x` : '—';
  const who = t.trader || 'Onbekend';
  return `${medal(i)}  ${pnl}  ${sym}  ${side}  ${lev}  by ${who} — [Trade](${t.link})`;
}
function chunkLines(lines, maxChars = 3800, maxRows = 25){
  const chunks=[]; let cur=[]; let len=0;
  for(const ln of lines){
    if(cur.length>=maxRows || len+ln.length+1>maxChars){
      chunks.push(cur.join('\n')); cur=[]; len=0;
    }
    cur.push(ln); len+=ln.length+1;
  }
  if(cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

async function buildLeaderboard(days=7, topN=10, wins=true){
  const ch = await client.channels.fetch(TRADE_LOG_ID);
  const msgs = await fetchAllMessages(ch, days);

  const trades=[];
  for(const m of msgs){
    const t=await parseTrade(m);
    if(t) trades.push(t);
  }

  const sorted = trades.sort((a,b)=> wins ? b.pnl-a.pnl : a.pnl-b.pnl);
  const top = sorted.slice(0, topN);

  const lines = top.map((t,i)=>line(i,t));
  const pages = chunkLines(lines);

  const titleBase = wins ? `Top ${topN} ${days?`${days}-daagse`:'All-Time'} winsten`
                         : `Top ${topN} ${days?`${days}-daagse`:'All-Time'} verliezen`;
  const footerTag = wins ? (days ? '[ANALYSEMAN-DAILY]' : '[ANALYSEMAN-ALLTIME-WIN]')
                         : (days ? '[ANALYSEMAN-DAILY-LOSS]' : '[ANALYSEMAN-ALLTIME-LOSS]');

  const embeds = pages.map((desc, idx) =>
    new EmbedBuilder()
      .setColor(wins?0x2ecc71:0xe74c3c)
      .setTitle(titleBase + (pages.length>1?`  (deel ${idx+1}/${pages.length})`:''))
      .setDescription(desc || '_Geen geldige trades gevonden._')
      .setFooter({ text: footerTag })
      .setTimestamp()
  );

  return embeds;
}

// ---------- post & pin ----------
async function postAndPin(embeds, tag){
  const lb = await client.channels.fetch(LEADERBOARD_ID);
  const pins = await lb.messages.fetchPinned();
  const old = pins.find(p=>p.embeds[0]?.footer?.text===tag);
  if (old) await old.unpin().catch(()=>{});

  let firstMsg = null;
  for (let i=0;i<embeds.length;i++){
    const sent = await lb.send({ embeds: [embeds[i]] });
    if (i===0) firstMsg = sent;
  }
  if (firstMsg) await firstMsg.pin().catch(()=>{});
}

// ---------- jobs ----------
async function runWeeklyTop10(){ 
  const embeds = await buildLeaderboard(7, WEEKLY_TOPN, true);
  await postAndPin(embeds, '[ANALYSEMAN-DAILY]');
}
async function runAllTimeTop25(){
  const wins = await buildLeaderboard(null, ALLTIME_TOPN, true);
  const loss = await buildLeaderboard(null, ALLTIME_TOPN, false);
  await postAndPin(wins, '[ANALYSEMAN-ALLTIME-WIN]');
  await postAndPin(loss, '[ANALYSEMAN-ALLTIME-LOSS]');
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

  // Daily 09:00 (Amsterdam)
  cron.schedule('0 9 * * *', async ()=>{
    try { await runWeeklyTop10(); } catch(e){ console.error('Daily job error:', e); }
  }, { timezone: TZ });

  // Sunday 20:00 (Amsterdam)
  cron.schedule('0 20 * * 0', async ()=>{
    try { await runAllTimeTop25(); } catch(e){ console.error('Weekly job error:', e); }
  }, { timezone: TZ });

  try{
    const cmds=[
      new SlashCommandBuilder().setName('lb_daily').setDescription('Post de Top 10 van de week (nu)'),
      new SlashCommandBuilder().setName('lb_alltime').setDescription('Post de Top 25 all-time wins & losses (nu)'),
    ].map(c=>c.toJSON());
    const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: cmds });
      console.log('[Analyseman] Slash commands geregistreerd voor guild:', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
      console.warn('[Analyseman] Geen GUILD_ID, commands global (kan ~1u duren).');
    }
  } catch(e){ console.error('[Analyseman] Slash cmd deploy error:', e); }
});

// ---------- non-blocking interaction handler (no timeouts) ----------
client.on('interactionCreate', async (i)=>{
  if(!i.isChatInputCommand()) return;
  try { await i.deferReply({ephemeral:true}); } catch {}

  setImmediate(async ()=>{
    try {
      if(i.commandName==='lb_daily'){
        await i.editReply('⏳ Week leaderboard wordt berekend…');
        await runWeeklyTop10();
        await i.editReply('✅ Week Top 10 gepost & gepind.');
      }
      if(i.commandName==='lb_alltime'){
        await i.editReply('⏳ All-time Top 25 (wins & losses) wordt berekend…');
        await runAllTimeTop25();
        await i.editReply('✅ All-time Top 25 gepost & gepind.');
      }
    } catch (err){
      console.error('Slash handler error:', err);
      try { await i.editReply('❌ Er ging iets mis tijdens het posten. Check de Heroku logs.'); } catch {}
    }
  });
});

client.login(process.env.DISCORD_TOKEN);

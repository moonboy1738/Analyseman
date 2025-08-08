// ===== Analyseman — embed.author fix (trader + PnL) + strak leaderboard =====
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

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const pad=(n,len)=>String(n).padStart(len,'0');

function normalizeNumber(raw){
  if(raw==null) return null;
  const s=String(raw).replace(/\s+/g,'').replace(/[’‘‚]/g,"'").replace(/[€$]/g,'')
    .replace(/(?<=\d)[._](?=\d{3}\b)/g,'').replace(',', '.');
  const n=parseFloat(s); return Number.isFinite(n)?n:null;
}
function expandK(n){ if(typeof n!=='string') return n;
  const m=n.match(/^([\-+]?\d+(?:[.,]\d+)?)[kK]$/); if(!m) return n;
  const base=normalizeNumber(m[1]); return base!=null?String(base*1000):n;
}
function computePnlPercent({side,entry,exit}){
  if(![entry,exit].every(Number.isFinite)) return null;
  const ch=(exit-entry)/entry; const dir=side?.toUpperCase()==='SHORT'?-ch:ch; return dir*100;
}

// ===== text helpers =====
function extractText(msg){
  let t = msg.content || '';
  for(const e of msg.embeds||[]){
    if(e.author?.name) t += ' ' + e.author.name;       // << belangrijk
    if(e.title) t += ' ' + e.title;
    if(e.description) t += ' ' + e.description;
    for(const f of e.fields||[]) if(f?.value) t += ' ' + f.value;
    if(e.footer?.text) t += ' ' + e.footer.text;
  }
  return t.replace(/```[\s\S]*?```/g,' ').replace(/`/g,' ').replace(/\*\*/g,' ')
          .replace(/<:[A-Za-z0-9_]+:\d+>/g,' ').replace(/\n+/g,' ').trim();
}

// haal trader uit mentions/author/”by <naam>”
async function detectTraderName(msg){
  const mUser = msg.mentions?.users?.first();
  if (mUser) {
    const mem = await msg.guild.members.fetch(mUser.id).catch(()=>null);
    return mem?.displayName || mUser.globalName || mUser.username || 'Onbekend';
  }
  // embed author name kan “mellabr –100.08%” zijn
  const embAuthor = msg.embeds?.find(e=>e?.author?.name)?.author?.name;
  if (embAuthor) {
    // pak stuk vóór de procent (naam)
    const m = embAuthor.match(/^(.+?)\s+[-+]?[\d.,]+\s*%/);
    if (m) return m[1].trim();
    // of als het “<naam>” zonder % is
    if (!embAuthor.match(/%/)) return embAuthor.trim();
  }

  const raw = extractText(msg);
  const by = raw.match(/\b(by|door)\s+([A-Za-z0-9_.\- ]{2,32})\b/i);
  if (by) return by[2].trim();

  const idm = raw.match(/<@!?(\d+)>/);
  if (idm) {
    const u = await msg.guild.members.fetch(idm[1]).catch(()=>null);
    if (u) return u.displayName || u.user?.globalName || u.user?.username || 'Onbekend';
  }
  const at = raw.match(/@([A-Za-z0-9_.\-]{2,32})/);
  if (at) return at[1];

  if (!msg.author?.bot) {
    const m = await msg.guild.members.fetch(msg.author.id).catch(()=>null);
    return m?.displayName || msg.author.globalName || msg.author.username || 'Onbekend';
  }
  return 'Onbekend';
}

// procent uit labels, embed-author, of berekenen
function extractPnl(raw, msg, side, entry, exit){
  // 0) embed.author.name heeft vaak alleen de PnL
  const aName = msg.embeds?.find(e=>e?.author?.name)?.author?.name;
  if (aName){
    const m = aName.match(/([-+]?[\d.,]+)\s*%/);
    if (m){ const v=normalizeNumber(m[1]); if (Number.isFinite(v) && Math.abs(v)<=5000) return v; }
  }
  // 1) labels in tekst
  const labeled = raw.match(/\b(pnl|p&l|roi|return)\b[^%\-+]*([-+]?[\d.,]+)\s*%/i);
  if (labeled) {
    const v = normalizeNumber(labeled[2]);
    if (Number.isFinite(v) && Math.abs(v)<=5000) return v;
  }
  // 2) compute
  if (side && entry!=null && exit!=null) {
    const v = computePnlPercent({side,entry,exit});
    if (Number.isFinite(v) && Math.abs(v)<=5000) return v;
  }
  // 3) precies één % in de combined text
  const all = [...raw.matchAll(/([-+]?[\d.,]+)\s*%/g)].map(m=>normalizeNumber(m[1])).filter(Number.isFinite);
  if (all.length===1 && Math.abs(all[0])<=5000) return all[0];
  return null;
}

// symbol/side/entry/exit/lev uit combined text
function parseStruct(raw){
  const side = raw.match(/\b(LONG|SHORT)\b/i)?.[1]?.toUpperCase() || null;
  let symbol=null;
  const sym = raw.match(/\b([A-Z]{2,12})(?:-?PERP|USDT|USD|USDC)?\b/) || raw.match(/\b([A-Z]{2,12})\/[A-Z]{2,6}\b/);
  if (sym) symbol=(sym[1]||sym[0]).toUpperCase().replace(/[^A-Z]/g,'').replace(/(USDT|USD|USDC)$/,'');
  const entry = normalizeNumber(expandK(raw.match(/\b(entry|ingang|open|in)\b[:\s-]*([\-+]?[\d.,kK]+)/i)?.[2]));
  const exit  = normalizeNumber(expandK(raw.match(/\b(exit|close|out|sluit)\b[:\s-]*([\-+]?[\d.,kK]+)/i)?.[2]));
  const lev   = normalizeNumber(raw.match(/(\d+(?:[.,]\d+)?)\s*x\b/i)?.[1]);
  return { side, symbol, entry, exit, lev };
}

async function parseTrade(msg){
  const raw = extractText(msg);
  if (!raw) return null;
  const base = parseStruct(raw);
  const pnl = extractPnl(raw, msg, base.side, base.entry, base.exit);
  if (pnl==null || !Number.isFinite(pnl)) return null;

  const trader = await detectTraderName(msg);
  const guildId = msg.guild?.id || '000000000000000000';
  const link = `https://discord.com/channels/${guildId}/${msg.channelId}/${msg.id}`;
  return { ...base, pnl: clamp(pnl,-5000,5000), trader, link, ts: msg.createdTimestamp };
}

async function fetchAllMessages(channel, days=null){
  const out=[]; let lastId; const cutoff = days ? Date.now()-days*86400000 : null;
  while(true){
    const opts={limit:100}; if(lastId) opts.before=lastId;
    const b=await channel.messages.fetch(opts); if(b.size===0) break;
    for(const m of b.values()){ if(cutoff && m.createdTimestamp<cutoff) return out; out.push(m); }
    lastId=b.last().id; await sleep(250);
  }
  return out;
}

// ------- formatting (strak, 1 regel per trade) -------
function medal(i){ return i===0?'🥇':i===1?'🥈':i===2?'🥉':`${pad(i+1,2)}.`; }
function line(i,t){
  const pnl = `${t.pnl>=0?'+':''}${t.pnl.toFixed(2)}%`;
  const sym = t.symbol || '—';
  const side = t.side || '—';
  const lev = t.lev ? `${t.lev}x` : '—';
  return `${medal(i)}  ${pnl}  ${sym}  ${side}  ${lev}  by ${t.trader} — [Trade](${t.link})`;
}

async function buildLeaderboard(days=7, topN=10, wins=true){
  const ch = await client.channels.fetch(TRADE_LOG_ID);
  const msgs = await fetchAllMessages(ch, days);
  const trades=[];
  for(const m of msgs){ const t=await parseTrade(m); if(t) trades.push(t); }
  const sorted = trades.sort((a,b)=> wins ? b.pnl-a.pnl : a.pnl-b.pnl);
  const top = sorted.slice(0, topN);
  const desc = top.length ? top.map((t,i)=>line(i,t)).join('\n').slice(0,3900) : '_Geen geldige trades gevonden._';
  return new EmbedBuilder()
    .setColor(wins?0x2ecc71:0xe74c3c)
    .setTitle(wins ? `Top ${topN} ${days?`${days}-daagse`:'All-Time'} winsten` : `Top ${topN} ${days?`${days}-daagse`:'All-Time'} verliezen`)
    .setDescription(desc)
    .setFooter({ text: wins ? (days ? '[ANALYSEMAN-DAILY]' : '[ANALYSEMAN-ALLTIME-WIN]') : (days ? '[ANALYSEMAN-DAILY-LOSS]' : '[ANALYSEMAN-ALLTIME-LOSS]') })
    .setTimestamp();
}

async function postAndPin(embed, tag){
  const lb = await client.channels.fetch(LEADERBOARD_ID);
  const pins = await lb.messages.fetchPinned();
  const old = pins.find(p=>p.embeds[0]?.footer?.text===tag);
  if (old) await old.unpin().catch(()=>{});
  const sent = await lb.send({ embeds: [embed] }); await sent.pin().catch(()=>{});
}

// jobs
async function runWeeklyTop10(){ const e=await buildLeaderboard(7,10,true); await postAndPin(e,'[ANALYSEMAN-DAILY]'); }
async function runAllTimeTop50(){ const w=await buildLeaderboard(null,50,true); const l=await buildLeaderboard(null,50,false);
  await postAndPin(w,'[ANALYSEMAN-ALLTIME-WIN]'); await postAndPin(l,'[ANALYSEMAN-ALLTIME-LOSS]'); }

// ready
client.once('ready', async ()=>{
  console.log(`[Analyseman] Ingelogd als ${client.user.tag}`);
  const tradeLog = await client.channels.fetch(TRADE_LOG_ID);
  const leaderboard = await client.channels.fetch(LEADERBOARD_ID);
  const me = await leaderboard.guild.members.fetch(client.user.id);
  const need=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ManageMessages];
  console.log('[Analyseman] Perms trade-log OK:',need.every(p=>tradeLog.permissionsFor(me)?.has(p)),
              ' leaderboard OK:',need.every(p=>leaderboard.permissionsFor(me)?.has(p)));

  cron.schedule('0 9 * * *', async ()=>{ try{ await runWeeklyTop10(); }catch(e){ console.error(e);} }, { timezone: TZ });
  cron.schedule('0 20 * * 0', async ()=>{ try{ await runAllTimeTop50(); }catch(e){ console.error(e);} }, { timezone: TZ });

  try{
    const cmds=[ new SlashCommandBuilder().setName('lb_daily').setDescription('Post de Top 10 van de week (nu)'),
                 new SlashCommandBuilder().setName('lb_alltime').setDescription('Post de Top 50 all-time wins & losses (nu)') ].map(c=>c.toJSON());
    const rest=new REST({version:'10'}).setToken(process.env.DISCORD_TOKEN);
    if(GUILD_ID){ await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: cmds }); }
    else { await rest.put(Routes.applicationCommands(client.user.id), { body: cmds }); }
  }catch(e){ console.error('[Analyseman] Slash cmd deploy error:',e); }
});

// interactions (async)
client.on('interactionCreate', async (i)=>{
  if(!i.isChatInputCommand()) return;
  if(i.commandName==='lb_daily'){ await i.deferReply({ephemeral:true}); i.editReply('⏳ Week leaderboard…');
    try{ await runWeeklyTop10(); await i.editReply('✅ Week Top 10 gepost & gepind.'); }catch(e){ console.error(e); await i.editReply('❌ Fout bij posten.'); } }
  if(i.commandName==='lb_alltime'){ await i.deferReply({ephemeral:true}); i.editReply('⏳ All-time leaderboards…');
    try{ await runAllTimeTop50(); await i.editReply('✅ All-time Top 50 wins & losses gepost & gepind.'); }catch(e){ console.error(e); await i.editReply('❌ Fout bij posten.'); } }
});

client.login(process.env.DISCORD_TOKEN);

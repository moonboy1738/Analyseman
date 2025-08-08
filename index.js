// ===== Analyseman — All-time Top 25 (wins+losses) + Weekly Top 10 (wins) =====
const cron = require('node-cron');
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  REST, Routes, SlashCommandBuilder, PermissionFlagsBits
} = require('discord.js');

// === Config (env of fallback) ===
const TRADE_LOG_ID      = process.env.TRADE_LOG_CHANNEL      || '1395887706755829770';
const LEADERBOARD_ID    = process.env.LEADERBOARD_CHANNEL    || '1395887166890184845';
const TZ                = process.env.TZ                     || 'Europe/Amsterdam';
const GUILD_ID          = process.env.GUILD_ID || process.env.SERVER_ID || null;

const WEEKLY_TOPN       = 10;  // Top 10 weekly
const ALLTIME_TOPN      = 25;  // Top 25 all-time

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

// ---------- helpers ----------
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

// ---------- text gather ----------
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

// ---------- PnL ----------
function findAnyPercent(text){
  const list=[...text.matchAll(/([+\-\u2212\u2013]?[\d.,]+)\s*%/g)]
    .map(m=>normalizeNumber(m[1])).filter(Number.isFinite);
  return list.length===1 ? list[0] : null;
}
function findLabeledPnl(msg){
  for(const e of msg.embeds||[]){
    const n=e?.author?.name;
    if(n){
      const m=n.match(/([+\-\u2212\u2013]?[\d.,]+)\s*%/);
      if(m){ const v=normalizeNumber(m[1]); if(Number.isFinite(v)&&Math.abs(v)<=5000) return v; }
    }
  }
  const parts=gatherParts(msg);
  for(const

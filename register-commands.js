import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID  = process.env.GUILD_ID;
const TOKEN     = process.env.TOKEN;

if (!CLIENT_ID || !GUILD_ID || !TOKEN) {
  console.error('❌ Missing CLIENT_ID, GUILD_ID, or TOKEN env vars');
  process.exit(1);
}

const trade = new SlashCommandBuilder()
  .setName('trade')
  .setDescription('Voeg een trade toe')
  .addStringOption(o => o.setName('actie').setDescription('add').addChoices({name:'add',value:'add'}).setRequired(true))
  .addStringOption(o => o.setName('symbool').setDescription('bv. PENG').setRequired(true))
  .addStringOption(o => o.setName('zijde').setDescription('Long of Short')
      .addChoices({name:'Long',value:'Long'},{name:'Short',value:'Short'}).setRequired(true))
  .addNumberOption(o => o.setName('entry').setDescription('entry prijs').setRequired(true))
  .addNumberOption(o => o.setName('exit').setDescription('exit prijs').setRequired(true))
  .addIntegerOption(o => o.setName('leverage').setDescription('hefboom (bijv. 35)').setRequired(true));

const lbAllTime = new SlashCommandBuilder()
  .setName('lb_alltime')
  .setDescription('Post All-Time Top 25 wins + worst 25 + totals (nu)');

const lbDaily = new SlashCommandBuilder()
  .setName('lb_daily')
  .setDescription('Post Top 10 van de week (nu)');

const commands = [trade, lbAllTime, lbDaily].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log(`🔄 Registering ${commands.length} command(s) to guild ${GUILD_ID}...`);
    const data = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log(`✅ Registered ${data.length} command(s).`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
    process.exit(1);
  }
})();

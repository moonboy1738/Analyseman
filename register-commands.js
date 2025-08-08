// Registers slash commands to your guild
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const {
  DISCORD_TOKEN,
  CLIENT_ID,      // your bot application id
  GUILD_ID        // your server id
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN / CLIENT_ID / GUILD_ID env vars');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder().setName('lb_alltime').setDescription('Post Top 25 All-Time (wins & losses)'),
  new SlashCommandBuilder().setName('lb_weekly').setDescription('Post Top 10 van de laatste 7 dagen'),
  new SlashCommandBuilder().setName('totals').setDescription('Post totale +/- PnL % per persoon (best→worst)')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

try {
  console.log('Registering slash commands...');
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log('Slash commands geregistreerd ✅');
} catch (err) {
  console.error(err);
  process.exit(1);
}

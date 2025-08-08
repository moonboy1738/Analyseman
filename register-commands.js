import { REST, Routes } from 'discord.js';
import fs from 'fs';
import path from 'path';

// Haalt variabelen rechtstreeks uit Heroku Config Vars
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const TOKEN = process.env.TOKEN;

// Controleer of alle vereiste vars aanwezig zijn
if (!CLIENT_ID || !GUILD_ID || !TOKEN) {
    console.error('❌ Missing CLIENT_ID, GUILD_ID, or TOKEN in environment variables.');
    process.exit(1);
}

// Commands inladen vanuit de /commands map (pas aan als jouw map anders heet)
const commands = [];
const commandsPath = path.join(process.cwd(), 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = await import(`file://${filePath}`);
    if (command.data && command.data.toJSON) {
        commands.push(command.data.toJSON());
    } else {
        console.warn(`⚠️ Skipped ${file} - geen geldige command structuur`);
    }
}

// REST client maken
const rest = new REST({ version: '10' }).setToken(TOKEN);

// Deployen naar Discord
(async () => {
    try {
        console.log(`🔄 Started refreshing ${commands.length} application (/) commands...`);

        const data = await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands },
        );

        console.log(`✅ Successfully reloaded ${data.length} application (/) commands.`);
        process.exit(0);
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();

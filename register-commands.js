import { REST, Routes } from 'discord.js';

const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID  = process.env.GUILD_ID;
const TOKEN     = process.env.TOKEN;

if (!CLIENT_ID || !GUILD_ID || !TOKEN) {
  console.error('❌ Missing CLIENT_ID, GUILD_ID, or TOKEN env vars');
  process.exit(1);
}

// /trade met jouw velden
const commands = [
  {
    name: 'trade',
    description: 'Voeg een trade toe',
    options: [
      { name: 'actie', description: 'add', type: 3, required: true, choices:[{name:'add', value:'add'}] },
      { name: 'symbool', description: 'bv. PENG', type: 3, required: true },
      { name: 'zijde', description: 'Long of Short', type: 3, required: true, choices:[{name:'Long',value:'Long'},{name:'Short',value:'Short'}] },
      { name: 'entry', description: 'entry prijs', type: 10, required: true },
      { name: 'exit', description: 'exit prijs', type: 10, required: true },
      { name: 'leverage', description: 'hefboom (bijv. 35)', type: 4, required: true }
    ]
  }
];

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

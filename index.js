const config = require('./config');
const client = require('./src/discord/client');
const registerEvents = require('./src/discord/events');
const { registerCommands, handleInteraction } = require('./src/discord/commands');
const brain = require('./src/agent/brain');

registerEvents(client);

client.once('clientReady', async () => {
  await registerCommands(client);
  brain.warmupLocalLLM();
});

client.on('interactionCreate', handleInteraction);

client.login(config.token);

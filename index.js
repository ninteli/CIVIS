const config = require('./config');
const versionManager = require('./src/version');
const client = require('./src/discord/client');
const registerEvents = require('./src/discord/events');
const { registerCommands, handleInteraction } = require('./src/discord/commands');
const brain = require('./src/agent/brain');

try {
  const snapshot = versionManager.syncSnapshotVersion();
  if (snapshot.changed) {
    const prevLabel = snapshot.previousVersion ? ` (precedente : v${snapshot.previousVersion})` : '';
    console.log(`[version] Modifications detectees -> nouveau snapshot : v${snapshot.version}${prevLabel}`);
  } else {
    console.log(`[version] Aucune modification detectee -> version actuelle : v${snapshot.version}`);
  }
} catch (err) {
  console.warn('[version] Impossible de mettre a jour le snapshot :', err.message);
}

registerEvents(client);

client.once('clientReady', async () => {
  await registerCommands(client);
  brain.warmupLocalLLM();
});

client.on('interactionCreate', handleInteraction);

client.login(config.token);

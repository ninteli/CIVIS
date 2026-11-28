const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { registerCommands } = require('../src/discord/commands');

describe('Enregistrement des commandes slash (commands.js)', () => {
  it('enregistre les commandes globalement une seule fois et nettoie les commandes par serveur', async () => {
    const globalCalls = [];
    const guildCalls = [];

    const mockClient = {
      application: {
        commands: {
          set: async (data) => {
            globalCalls.push(data);
          },
        },
      },
      guilds: {
        cache: new Map([
          [
            'guild-1',
            {
              name: 'Serveur 1',
              commands: {
                set: async (data) => {
                  guildCalls.push({ guild: 'guild-1', data });
                },
              },
            },
          ],
          [
            'guild-2',
            {
              name: 'Serveur 2',
              commands: {
                set: async (data) => {
                  guildCalls.push({ guild: 'guild-2', data });
                },
              },
            },
          ],
        ]),
      },
    };

    await registerCommands(mockClient);

    assert.equal(globalCalls.length, 1);
    assert.ok(Array.isArray(globalCalls[0]) && globalCalls[0].length > 0);
    const names = globalCalls[0].map((c) => c.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes('export'), 'La commande /export doit etre enregistree');
    assert.ok(names.includes('import'), 'La commande /import doit etre enregistree');

    assert.deepEqual(guildCalls, [
      { guild: 'guild-1', data: [] },
      { guild: 'guild-2', data: [] },
    ]);
  });
});

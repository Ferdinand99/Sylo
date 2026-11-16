// The Health page for the bridge: the permissions it needs in a bridged channel, and a stopped link shown
// as a problem with its reason.
import './helpers/tmpDb.js';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { purgeGuild } from '../src/db/purge.js';
import { buildHealthReport } from '../src/web/lib/permissionHealth.js';
import { keyedGuild } from '../src/platform/platformOf.js';
import { acceptLink, failLink, requestLink, useBridgeParts, dropBridgeCache } from '../src/modules/bridge.js';
import { D, F, installPlatforms, removePlatforms, useFakes } from './helpers/fakeBridge.js';

let p;
beforeEach(async () => {
  p = installPlatforms();
  useFakes();
  dropBridgeCache();
  for (const key of [D, F]) await purgeGuild(key);
  useFakes();
  await setGuildModule(D, 'bridge', { enabled: true });
  await setGuildModule(F, 'bridge', { enabled: true });
});
afterEach(() => {
  useBridgeParts();
  removePlatforms();
});

const forBridge = (guild) =>
  buildHealthReport(guild, { modules: [{ id: 'bridge', enabled: true, config: {} }] });

test('the bridge needs Manage Webhooks in a bridged channel, and Health says so', async () => {
  const dCh = p.channel(p.dGuild, { name: 'discord-chat' });
  const fCh = p.channel(p.fGuild, { name: 'fluxer-chat' });
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' });
  await acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' });
  assert.deepEqual((await forBridge(p.dGuild)).checks, [], 'nothing to report while Sylo has what it needs');

  dCh.permissionsFor = () => ({ has: (perm) => perm !== 'ManageWebhooks' });
  const report = await forBridge(p.dGuild);
  assert.equal(report.checks.length, 1);
  const [check] = report.checks;
  assert.equal(check.module, 'bridge');
  assert.equal(check.severity, 'error');
  assert.deepEqual(check.permissions, ['ManageWebhooks']);
  assert.match(check.message, /A bridged channel \(#discord-chat\): Sylo is missing Manage Webhooks/);
});

test('a link Sylo stopped is a problem with the reason and what to do, on both servers', async () => {
  const dCh = p.channel(p.dGuild, { name: 'discord-chat' });
  const fCh = p.channel(p.fGuild, { name: 'fluxer-chat' });
  const made = await requestLink({ guildKey: D, channelId: dCh.id, actor: 'A' });
  const link = await acceptLink({ guildKey: F, channelId: fCh.id, code: made.code, actor: 'B' });
  await failLink(link.id, 'permissions');
  // The dashboard hands the health check the guild with its key as `.id` (keyedGuild).
  for (const guild of [keyedGuild(p.dGuild), keyedGuild(p.fGuild)]) {
    const { checks } = await forBridge(guild);
    const stopped = checks.find((c) => c.code === 'bridge-stopped');
    assert.ok(stopped, 'a stopped bridge is listed');
    assert.equal(stopped.severity, 'error');
    assert.match(
      stopped.message,
      /The bridge of #(discord|fluxer)-chat stopped: Sylo is missing a permission/
    );
    assert.match(stopped.fix, /press Resume/);
  }
});

test('a server with the module off is not checked', async () => {
  const report = await buildHealthReport(p.dGuild, {
    modules: [{ id: 'bridge', enabled: false, config: {} }],
  });
  assert.deepEqual(report.checks, []);
});

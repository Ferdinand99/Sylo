// DASHBOARD_URL is sent to the push relay as the instance's address, and the relay only takes
// its canonical form: an uppercase host, a default port or a trailing query made every relayed
// notification fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseDashboardUrl } from '../src/config.js';

test('normaliseDashboardUrl gives the canonical form', () => {
  assert.equal(normaliseDashboardUrl('https://Sylo.Example.com:443/'), 'https://sylo.example.com');
  assert.equal(normaliseDashboardUrl('http://host:80/sylo/?x=1#y'), 'http://host/sylo');
  assert.equal(normaliseDashboardUrl('https://host:8443'), 'https://host:8443');
  assert.equal(normaliseDashboardUrl(''), null);
  assert.equal(normaliseDashboardUrl('not a url'), null);
});

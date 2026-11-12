// A guard for an SDK upgrade. Sylo gives Fluxer's MessageManager an edit() and a delete() of its own
// (src/platform/compat.js) because the SDK has none. The compat layer never replaces a method the
// SDK already has, so the day the SDK adds one, that native method would take over: its payload
// would go to Fluxer's REST API without the send bridge, which turns discord.js embeds, buttons and
// the rest into what Fluxer takes and swaps buttons for reactions. Suggestion votes and decisions
// would then stop updating on Fluxer.
//
// This file must not install the compat layer: it looks at the raw SDK class.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '@fluxerjs/core';

for (const name of ['edit', 'delete']) {
  test(`the raw Fluxer SDK MessageManager still has no ${name}() of its own`, () => {
    assert.equal(
      name in sdk.MessageManager.prototype,
      false,
      `@fluxerjs/core's MessageManager now has its own ${name}(). The compat layer (src/platform/compat.js) ` +
        `adds ${name}() only when the SDK has none, so the native method would now be used, and it would ` +
        'bypass the send bridge (prepareOutgoing and the buttons-to-reactions swap). Check what the ' +
        `native ${name}() does, then make compat.js install its own version over it (or route it through ` +
        'the fetched Message), and update this test.'
    );
  });
}

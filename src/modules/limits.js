// Every module's setting limits in one map, served to the dashboard at GET /api/v2/modules/limits
// so the forms read them instead of keeping their own copies.
//
// Each module that has a normalise…Config exports `LIMITS`, used by the normaliser itself:
//   { 'field.path': { maxLength?, min?, max?, maxItems? } }
// Nested fields use dotted paths and `[]` marks array items ('stickies[].content').
// The imports are explicit (no glob) so bundling and linting stay simple.
//
// `_embed` is a pseudo-module: the limits of one embed spec (normaliseEmbedSpec), shared by every
// module that stores an embed.
import { EMBED_LIMITS } from './welcomeChannel.js';
import { LIMITS as polls } from './polls.js';
import { LIMITS as sticky } from './sticky.js';
import { LIMITS as welcome } from './welcome.js';

export const MODULE_LIMITS = Object.freeze({
  _embed: EMBED_LIMITS,
  polls,
  sticky,
  welcome,
});

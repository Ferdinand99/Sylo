// On a Fluxer server the dashboard's help text must say `!giveaway start`, not `/giveaway
// start` (Fluxer has no slash commands). Wraps res.render for the guild's pages and rewrites
// the command references in the rendered HTML; Discord pages pass through untouched.
import { guildByKey, platformOfGuild, clientOfGuild } from '../../platform/platformOf.js';
import { rewriteSlashCommands } from '../../platform/commandText.js';
import { config } from '../../config.js';

/** @type {import('express').RequestHandler} */
export function platformCommands(req, res, next) {
  const guild = guildByKey(req.params.guildId);
  if (!guild || platformOfGuild(guild) === 'discord') return next();

  const names = new Set(clientOfGuild(guild)?.commands?.keys?.() ?? []);
  const render = res.render.bind(res);
  res.render = (view, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? undefined : options;
    render(view, opts, (err, html) => {
      if (err) return done ? done(err) : next(err);
      const out = rewriteSlashCommands(html, { prefix: config.commandPrefix, names });
      return done ? done(null, out) : res.send(out);
    });
  };
  return next();
}

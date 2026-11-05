import { useOperator } from '../useOperator.js';
import Callout from './Callout.jsx';

/**
 * "This feature is not switched on for this Sylo": shown when the bot owner has not added the keys it
 * needs. Everyone gets a plain sentence; only the bot owner also sees which environment variables to
 * set (`vars`) and where to get them (`where`).
 *
 *   <SetupCallout what="Twitch alerts" keys="Twitch API keys" vars={['TWITCH_CLIENT_ID', …]}
 *     where="a free app at dev.twitch.tv/console">You can set things up now …</SetupCallout>
 */
export default function SetupCallout({ what, keys, vars = [], where = '', singular = false, children }) {
  const operator = useOperator();
  return (
    <Callout tone="warning">
      <p>
        {what} {singular ? "isn't" : "aren't"} active on this Sylo yet; the bot owner needs to add {keys}.
        {children ? <> {children}</> : null}
      </p>
      {operator && vars.length ? (
        <p className="v2-callout-owner">
          For the bot owner: set{' '}
          {vars.map((v, i) => (
            <span key={v}>
              {i > 0 ? (i === vars.length - 1 ? ' and ' : ', ') : ''}
              <code>{v}</code>
            </span>
          ))}
          {where ? ` (${where})` : ''}.
        </p>
      ) : null}
    </Callout>
  );
}

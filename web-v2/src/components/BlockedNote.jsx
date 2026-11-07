import { useOperator } from '../useOperator.js';

/**
 * Why a module can't run: the bot lacks a gateway permission ("intent") that only whoever runs this
 * Sylo can switch on. Admins get a plain sentence; the bot owner also gets the permission names and
 * where to read how.
 */
export default function BlockedNote({ intents }) {
  const operator = useOperator();
  return operator ? (
    <>
      Needs the {intents.join(', ')} intent. Switch it on for the bot, then restart Sylo (see
      docs/self-hosting.md).
    </>
  ) : (
    <>Sylo can't run this module yet. The bot owner has to allow a permission for it first.</>
  );
}

// GET /commands — lists the slash commands the bot currently has loaded.
// The list is derived from the live command collection, so it always matches
// what is actually registered.
import { primaryClient } from '../../platform/platformOf.js';
import { Router } from 'express';
import { describeCommands } from '../lib/commandReference.js';

const router = Router();

router.get('/', (req, res) => {
  res.render('commands', { commands: describeCommands(primaryClient()?.commands) });
});

export default router;

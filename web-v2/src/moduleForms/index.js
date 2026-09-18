// Registry of module ids with a real V2 settings form. Overview links a
// module's row here when it has an entry, and to V1's own config page
// (already given by the overview API as each card's `href`) otherwise —
// every module is configurable from V2 today, just not all with a V2 page
// yet. Add an entry here (and its two backend routes in v2Api.js) whenever
// a new module gets built out.
import Afk from './Afk.jsx';
import Welcome from './Welcome.jsx';
import Birthdays from './Birthdays.jsx';
import Verification from './Verification.jsx';

export const MODULE_FORMS = {
  afk: Afk,
  welcome: Welcome,
  birthdays: Birthdays,
  verification: Verification,
};

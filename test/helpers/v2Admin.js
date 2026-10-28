// Signed in as the admin of D_GUILD, with a POST helper for the new dashboard's guild routes.
import { D_GUILD, browser, setProfiles, signIn } from './oauthApp.js';

export async function adminApi() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const api = (path, body) =>
    b.get(`/api/v2/guilds/${D_GUILD}${path}`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { b, api };
}

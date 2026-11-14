/**
 * Whether the signed-in person may use the setup wizard. It creates channels and roles and saves module
 * settings, so it is for someone who may edit this server's settings.
 *
 * Today everyone who reaches these pages does: the server lets only a server admin (Manage Server,
 * Administrator or a bot-master role) into them. This is the one place to ask when dashboard access levels
 * arrive: return whether the person's level is Edit.
 */
export function useCanSetUp() {
  return true;
}

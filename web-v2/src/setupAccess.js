import { useAccess } from './access.jsx';

/**
 * Whether the signed-in person may use the setup wizard. It creates channels and roles and saves module
 * settings, so it is for Edit access (the server refuses the apply route below that level too).
 */
export function useCanSetUp() {
  return useAccess().can('edit');
}

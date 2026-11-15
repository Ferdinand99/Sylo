// What the shop's role items make of money: the roles it sells, and which settings decide how much money
// members get. Money buys those roles, so whoever raises what members receive (a staff credit, the work pay,
// the starting balance) must be able to hand out every one of them (src/web/middleware/roleGrants.js).
import { listItems } from '../../db/economyShop.js';
import { isRoleItemType, normaliseEconomyConfig } from './economyConfig.js';

/**
 * The roles the shop sells (role and temporary-role items that are on sale).
 * @returns {Promise<string[]>}
 */
export async function soldRoleIds(guildId) {
  const ids = (await listItems(guildId))
    .filter((i) => i.enabled && isRoleItemType(i.type) && i.roleId)
    .map((i) => String(i.roleId));
  return [...new Set(ids)];
}

// Settings where a higher number means members get more, and where a lower one does.
const MORE_WHEN_HIGHER = [
  'messageMin',
  'messageMax',
  'voiceAmount',
  'dailyBase',
  'dailyStreakBonus',
  'workMin',
  'workMax',
  'startingBalance',
];
const MORE_WHEN_LOWER = ['messageCooldownSeconds', 'messageMinLength', 'workCooldownMinutes'];

/**
 * Does this save raise what members earn or start with? Switching the module on does: everything it pays
 * comes into effect. A module saved before (or switched on without ever saving settings: an empty config)
 * is compared as it works now, with the defaults.
 */
export function raisesIncome(prev, next, { switchingOn = false } = {}) {
  if (switchingOn) return true;
  const was = normaliseEconomyConfig(prev ?? {});
  const now = normaliseEconomyConfig(next ?? {});
  return (
    (!was.messageEnabled && now.messageEnabled) ||
    (!was.voiceEnabled && now.voiceEnabled) ||
    MORE_WHEN_HIGHER.some((k) => now[k] > was[k]) ||
    MORE_WHEN_LOWER.some((k) => now[k] < was[k])
  );
}

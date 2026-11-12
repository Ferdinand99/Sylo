// What the shop says after a purchase, for the commands and the web shop alike.
import { formatMoney } from '../../modules/economy.js';
import { itemLabel, shopRefusalText } from '../../modules/lib/shop.js';

/**
 * One sentence for the result of `purchase()`: what was bought and what is left, or why it did not
 * work. `config` formats amounts. The time of a temporary role is written as a <t:...> timestamp.
 */
export function purchaseText(out, config) {
  if (!out.ok) return shopRefusalText(out, config);
  const bought = `You bought **${itemLabel(out.item)}** for ${formatMoney(out.item.price, config)}.`;
  const left = ` You have ${formatMoney(out.account.cash, config)} left.`;
  if (out.item.type === 'temp_role') {
    const until = `<t:${Math.floor(out.expiresAt / 1000)}:f>`;
    return `${bought} You have the role until ${until}${out.extended ? ' (the new time was added to what you had)' : ''}.${left}`;
  }
  if (out.item.type === 'role') return `${bought} The role is yours.${left}`;
  return `${bought} Staff were told and will take care of it.${left}`;
}

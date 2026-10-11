// /privacy — expose this deployment's public privacy notice without staff access.
import { SlashCommandBuilder, MessageFlags } from 'discord.js';

const KRIPBOT_ID = '1557837851427864648';
const KRIPBOT_POLICY = 'https://github.com/kripusek/Sylo-kripbot/blob/main/docs/kripbot-privacy.md';

export const data = new SlashCommandBuilder()
  .setName('privacy')
  .setDescription('Wyświetla politykę prywatności tego bota.');

export async function execute(interaction) {
  // Fork deployments must supply their own policy rather than inherit kripbot's operator.
  const configured = process.env.PRIVACY_POLICY_URL?.trim();
  const candidate = configured || (interaction.client.user?.id === KRIPBOT_ID ? KRIPBOT_POLICY : '');
  let url;
  try {
    url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password) url = null;
  } catch {
    url = null;
  }

  return interaction.reply({
    content: url
      ? `**Polityka prywatności**\n${url.href}\n\nUżyj /mydata, aby pobrać obsługiwane dane zapisane o Tobie na tym serwerze, lub /forget, aby je usunąć. Usunięcie nie zatrzymuje przyszłego zbierania danych i nie usuwa automatycznie kopii z kanałów logów ani backupów.`
      : 'Operator tego bota nie skonfigurował jeszcze publicznego linku do polityki prywatności. Skontaktuj się z administracją serwera.',
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

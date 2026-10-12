// Bot-wide changes are kept separate from each guild's config audit history.
import { recordAudit, listAudit } from '../../db/audit.js';

const SCOPE = '__bot_personalizer__';
const labels = { username: 'Nazwa', avatar: 'Awatar', banner: 'Baner', presence: 'Status i aktywność' };

export async function beginPersonalizerAudit(req, kind, user) {
  const fields =
    kind === 'presence'
      ? ['presence']
      : [
          req.body.username && req.body.username !== user?.username ? 'username' : null,
          req.body.resetAvatar || req.body.avatarUrl ? 'avatar' : null,
          req.body.bannerUrl ? 'banner' : null,
        ].filter(Boolean);
  if (!fields.length) return null;
  const audit = {
    actor: req.session?.user?.id || 'local-admin',
    kind,
    fields,
    previousName: user?.username || '',
  };
  await recordAudit(SCOPE, {
    actor: audit.actor,
    action: `bot.${kind}.requested`,
    detail: JSON.stringify({ fields }),
  });
  return audit;
}

export async function finishPersonalizerAudit(audit, done, failed, user) {
  if (!audit) return;
  const result = {
    changed: done.map((value) => value.split(' ')[0]),
    failed: failed.map((value) => value.split(/[ (]/)[0]),
  };
  if (result.changed.includes('username')) {
    result.previousName = audit.previousName.slice(0, 32);
    result.newName = String(user?.username || '').slice(0, 32);
  }
  await recordAudit(SCOPE, {
    actor: audit.actor,
    action: `bot.${audit.kind}.finished`,
    detail: JSON.stringify(result),
  });
}

export async function personalizerHistory() {
  return (await listAudit(SCOPE, 100)).map((entry) => {
    let data = {};
    try {
      data = JSON.parse(entry.detail);
    } catch {
      /* Older entries may use plain text. */
    }
    const fields = (data.fields || data.changed || []).map((field) => labels[field] || field);
    const failed = (data.failed || []).map((field) => labels[field] || field);
    const requested = entry.action.endsWith('.requested');
    const detail = [
      fields.length ? fields.join(', ') : null,
      data.newName ? `${data.previousName} → ${data.newName}` : null,
      failed.length ? `Nie udało się: ${failed.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return { ...entry, label: requested ? 'Próba zmiany' : 'Wynik zmiany', detail };
  });
}

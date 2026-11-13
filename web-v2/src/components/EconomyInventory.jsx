import { useEffect, useState } from 'react';
import { actOnInventoryRow, getShopItems, grantShopItem } from '../api.js';
import { notify } from '../notify.js';
import Meta from './Meta.jsx';
import Time from './Time.jsx';
import { confirmDialog } from './ConfirmDialog.jsx';
import { limitOf, useModuleLimits } from './useModuleLimits.js';

const STATUS = {
  pending: 'being set up',
  active: 'active',
  revoked: 'revoked',
  refunded: 'refunded',
  expired: 'expired',
};

/**
 * One member's inventory on the Members tab: what they own, and the staff actions: give an item for
 * free, revoke one (ending a temporary role, taking a permanent role off), refund a purchase (money
 * back, and the item is revoked), and mark a custom item fulfilled. All of it goes through the same
 * server code as the commands, and every action is in the ledger.
 */
export default function EconomyInventory({ guildId, userId, inventory, onChange, currency }) {
  const limits = useModuleLimits('economy');
  const [items, setItems] = useState([]);
  const [itemId, setItemId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getShopItems(guildId)
      .then((d) => live && setItems(d.items))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [guildId]);

  async function run(fn, message) {
    setBusy(true);
    try {
      const out = await fn();
      onChange(out.inventory);
      if (out.warning) notify(out.warning);
      else if (message) notify(message, 'info');
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onGrant(e) {
    e.preventDefault();
    if (!itemId) return notify('Pick an item.');
    await run(() => grantShopItem(guildId, userId, { itemId: Number(itemId), reason }), 'Item given.');
    setReason('');
  }

  async function onEnd(row, action) {
    const refund = action === 'refund';
    const ok = await confirmDialog({
      title: `${refund ? 'Refund' : 'Revoke'} ${row.itemName}?`,
      body: refund
        ? `The member gets ${currency.emoji} ${row.pricePaid.toLocaleString('en-US')} back and the item is revoked.`
        : 'The item is taken away (a temporary role ends, a permanent role comes off). No money moves.',
      confirmLabel: refund ? 'Refund' : 'Revoke',
    });
    if (!ok) return;
    await run(
      () => actOnInventoryRow(guildId, userId, row.id, action, { reason }),
      refund ? 'Refunded.' : 'Revoked.'
    );
  }

  return (
    <>
      <h3 className="v2-group-title">Inventory</h3>
      {inventory.length === 0 ? <p className="v2-note">Nothing here yet.</p> : null}
      <div className="v2-list">
        {inventory.map((row) => {
          const live = row.status === 'active' || row.status === 'pending';
          return (
            <div className="v2-row" key={row.id}>
              {row.itemType === 'collectible' && row.imagePath ? (
                <img className="v2-thumb" src={row.imagePath} alt="" width="48" height="48" />
              ) : null}
              <div className="v2-row-main">
                <h3 className="v2-break">
                  {row.itemName}
                  {row.itemRemoved ? <span className="v2-field-hint"> — item removed</span> : null}
                </h3>
                <p className="v2-field-hint">
                  <Meta
                    items={[
                      STATUS[row.status],
                      row.source === 'grant'
                        ? 'given for free'
                        : `paid ${row.pricePaid.toLocaleString('en-US')}`,
                      row.expiresAt && (
                        <span key="u">
                          until <Time value={row.expiresAt} />
                        </span>
                      ),
                      row.itemType === 'custom' &&
                        live &&
                        (row.fulfilledAt
                          ? `fulfilled${row.fulfilledBy ? ` by ${row.fulfilledBy.name}` : ''}`
                          : 'waiting for staff'),
                      row.itemType === 'collectible' && 'collectible',
                      row.note,
                      <Time key="t" value={row.createdAt} />,
                    ]}
                  />
                </p>
              </div>
              <div className="v2-row-actions">
                {row.itemType === 'custom' && row.status === 'active' ? (
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () =>
                          actOnInventoryRow(guildId, userId, row.id, 'fulfil', {
                            fulfilled: !row.fulfilledAt,
                            note: reason,
                          }),
                        row.fulfilledAt ? 'Reopened.' : 'Marked fulfilled.'
                      )
                    }
                  >
                    {row.fulfilledAt ? 'Reopen' : 'Mark fulfilled'}
                  </button>
                ) : null}
                {live ? (
                  <button
                    type="button"
                    className="v2-btn-ghost"
                    disabled={busy}
                    onClick={() => onEnd(row, 'revoke')}
                  >
                    Revoke
                  </button>
                ) : null}
                {live && row.source === 'purchase' && row.pricePaid > 0 ? (
                  <button
                    type="button"
                    className="v2-btn-danger-ghost"
                    disabled={busy}
                    onClick={() => onEnd(row, 'refund')}
                  >
                    Refund
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <form onSubmit={onGrant}>
        <div className="v2-field-row">
          <div className="v2-field">
            <label htmlFor="inv-item">Give an item for free</label>
            <select id="inv-item" value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">— pick an item —</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          <div className="v2-field">
            <label htmlFor="inv-reason">
              Reason or note <span className="v2-field-hint">— kept in the ledger</span>
            </label>
            <input
              id="inv-reason"
              type="text"
              maxLength={limitOf(limits, 'reason').maxLength}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <button type="submit" className="v2-btn-primary" disabled={busy || !itemId}>
          Give item
        </button>
      </form>
    </>
  );
}

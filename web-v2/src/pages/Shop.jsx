import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, buyWebShopItem, getWebShop } from '../api.js';
import { useApiData } from '../useApiData.js';
import { notify } from '../notify.js';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import Meta from '../components/Meta.jsx';
import Time from '../components/Time.jsx';

const money = (n, currency) => `${currency.emoji} ${Number(n).toLocaleString('en-US')} ${currency.name}`;

/** The one answer for every visitor who may not use the page: nothing here, and no hint why. */
function Nothing() {
  return (
    <div className="v2-state v2-route-error" role="status">
      <p>Nothing here</p>
      <p className="v2-field-hint">There is nothing at this address. The link may be old or mistyped.</p>
    </div>
  );
}

function kindText(item) {
  if (item.type === 'temp_role') {
    return `A role for ${item.durationHours} hour${item.durationHours === 1 ? '' : 's'}`;
  }
  if (item.type === 'role') return 'A role';
  return 'Staff take care of it';
}

/**
 * The web shop of a server (/shop/<server>): the member's balance, the items for sale and what they
 * own, with a confirmed one-click buy. The data and the purchase are the server's: the same
 * purchase() as /buy decides everything; this page only shows the answer.
 */
export default function Shop() {
  const { guildId } = useParams();
  const { data, error, setData } = useApiData(() => getWebShop(guildId), [guildId]);
  const [busy, setBusy] = useState(null);

  if (error) {
    if (error instanceof ApiError && error.notAuthenticated) {
      return (
        <p className="v2-state">
          Your session expired — <a href="/auth/login">sign in again</a>.
        </p>
      );
    }
    // 404 (and every other refusal) reads the same.
    return <Nothing />;
  }
  if (!data) return <p className="v2-state">Loading…</p>;

  const { currency } = data;

  async function onBuy(item) {
    const ok = await confirmDialog({
      title: `Buy ${item.emoji ? `${item.emoji} ` : ''}${item.name}?`,
      body: `It costs ${money(item.price, currency)}. You have ${money(data.balance.cash, currency)} in cash.`,
      confirmLabel: `Buy for ${item.price.toLocaleString('en-US')}`,
      tone: 'default',
    });
    if (!ok) return;
    setBusy(item.id);
    try {
      const out = await buyWebShopItem(guildId, item.id);
      setData(out.view);
      notify(`You bought ${item.name}.`, 'info');
    } catch (err) {
      notify(err.message);
      // The stock or the price may have changed under us: look again.
      getWebShop(guildId)
        .then(setData)
        .catch(() => {});
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h1 className="v2-section-title">Shop of {data.guild.name}</h1>
      <p className="v2-field-hint">
        <Meta
          items={[`Cash ${money(data.balance.cash, currency)}`, `Bank ${money(data.balance.bank, currency)}`]}
        />
      </p>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Items</h2>
        {data.items.length === 0 ? <p className="v2-note">The shop is empty.</p> : null}
        <div className="v2-list">
          {data.items.map((item) => (
            <div className="v2-row" key={item.id}>
              <div className="v2-row-main">
                <h3>
                  {item.emoji ? `${item.emoji} ` : ''}
                  {item.name}
                </h3>
                {item.description ? <p>{item.description}</p> : null}
                <p className="v2-field-hint">
                  <Meta
                    items={[
                      money(item.price, currency),
                      kindText(item),
                      item.left !== null && (item.left === 0 ? 'Sold out' : `${item.left} left`),
                      item.requiredRoles.length > 0 &&
                        `Needs one of: ${item.requiredRoles.map((r) => r.name).join(', ')}`,
                      !item.canBuy && item.problem,
                    ]}
                  />
                </p>
              </div>
              <div className="v2-row-actions">
                <button
                  type="button"
                  className="v2-btn-primary"
                  disabled={!item.canBuy || busy === item.id}
                  onClick={() => onBuy(item)}
                >
                  Buy
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">What you own</h2>
        {data.inventory.length === 0 ? <p className="v2-note">Nothing yet.</p> : null}
        <div className="v2-list">
          {data.inventory.map((row) => (
            <div className="v2-row" key={row.id}>
              <div className="v2-row-main">
                <h3>{row.name}</h3>
                <p className="v2-field-hint">
                  <Meta
                    items={[
                      row.expiresAt && (
                        <span key="u">
                          Until <Time value={row.expiresAt} />
                        </span>
                      ),
                      row.type === 'custom' && (row.fulfilledAt ? 'Fulfilled' : 'Waiting for staff'),
                      <Time key="t" value={row.createdAt} />,
                    ]}
                  />
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

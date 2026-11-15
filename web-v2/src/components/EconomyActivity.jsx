import { useEffect, useState } from 'react';
import { getShopActivity, getShopItems } from '../api.js';
import LoadError from './LoadError.jsx';
import MemberPicker from './MemberPicker.jsx';
import Meta from './Meta.jsx';
import Time from './Time.jsx';
import { useCmd } from '../platformContext.jsx';

const STATUS = {
  pending: 'being set up',
  active: 'active',
  revoked: 'revoked',
  refunded: 'refunded',
  expired: 'expired',
};

/** The Activity tab: the recent purchases of the shop, filterable by member and by item. */
export default function EconomyActivity({ guildId, currency }) {
  const cmd = useCmd();
  const [userId, setUserId] = useState('');
  const [itemId, setItemId] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    getShopItems(guildId)
      .then((d) => live && setItems(d.items))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [guildId]);

  useEffect(() => {
    let live = true;
    getShopActivity(guildId, { userId, itemId, page })
      .then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
      })
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [guildId, userId, itemId, page]);

  if (error) return <LoadError error={error} what="the activity" />;
  if (!data) return <p className="v2-state">Loading…</p>;

  return (
    <div className="v2-group">
      <h2 className="v2-group-title">Purchases ({data.total.toLocaleString('en-US')})</h2>
      <div className="v2-field-row">
        <div className="v2-field">
          <label htmlFor="act-member">Member</label>
          <MemberPicker
            id="act-member"
            value={userId}
            onChange={(id) => {
              setUserId(id);
              setPage(1);
            }}
          />
        </div>
        <div className="v2-field">
          <label htmlFor="act-item">Item</label>
          <select
            id="act-item"
            value={itemId}
            onChange={(e) => {
              setItemId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All items</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {data.rows.length === 0 ? (
        <p className="v2-note">
          {userId || itemId
            ? 'No purchases match.'
            : `No purchases yet. Purchases made with ${cmd('/buy')} or in the web shop appear here.`}
        </p>
      ) : null}
      <div className="v2-list">
        {data.rows.map((row) => (
          <div className="v2-row" key={row.id}>
            <div className="v2-row-main">
              <h3 className="v2-break">
                {row.member?.name ?? row.userId} bought {row.itemName}
                {row.itemRemoved ? <span className="v2-field-hint"> — item removed</span> : null}
              </h3>
              <p className="v2-field-hint">
                <Meta
                  items={[
                    `${currency.emoji} ${row.pricePaid.toLocaleString('en-US')}`,
                    STATUS[row.status],
                    row.itemType === 'custom' &&
                      row.status === 'active' &&
                      (row.fulfilledAt ? 'fulfilled' : 'waiting for staff'),
                    <Time key="t" value={row.createdAt} />,
                  ]}
                />
              </p>
            </div>
          </div>
        ))}
      </div>
      {data.pages > 1 ? (
        <div className="v2-field-row">
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={data.page <= 1}
            onClick={() => setPage(data.page - 1)}
          >
            Previous
          </button>
          <span className="v2-field-hint">
            Page {data.page} of {data.pages}
          </span>
          <button
            type="button"
            className="v2-btn-ghost"
            disabled={data.page >= data.pages}
            onClick={() => setPage(data.page + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

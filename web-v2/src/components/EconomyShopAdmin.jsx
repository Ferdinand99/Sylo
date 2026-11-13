import { useEffect, useState } from 'react';
import {
  createShopItem,
  deleteShopItem,
  deleteShopItemImage,
  getShopItems,
  reorderShopItems,
  setShopItemEnabled,
  updateShopItem,
  uploadShopItemImage,
} from '../api.js';
import { notify } from '../notify.js';
import ChipPicker from './ChipPicker.jsx';
import LoadError from './LoadError.jsx';
import Meta from './Meta.jsx';
import { confirmDialog } from './ConfirmDialog.jsx';
import { limitOf, useModuleLimits } from './useModuleLimits.js';

const TYPE_LABELS = {
  temp_role: 'Temporary role',
  role: 'Permanent role',
  custom: 'Custom item (staff fulfil it)',
  collectible: 'Collectible (a picture, no role)',
};

// What the server accepts for a picture (it checks the file itself, not only this).
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const blankForm = (defaults = {}) => ({
  id: null,
  name: '',
  description: '',
  emoji: '',
  type: 'custom',
  roleId: '',
  durationHours: 24,
  price: 100,
  stock: '',
  perMemberLimit: '',
  requiredRoles: [],
  enabled: true,
  rarity: '',
  announce: false,
  imagePath: null,
  file: null, // a picture chosen in this form, uploaded after the item is saved
  ...defaults,
});

const toForm = (item) =>
  blankForm({
    id: item.id,
    name: item.name,
    description: item.description,
    emoji: item.emoji,
    type: item.type,
    roleId: item.roleId ?? '',
    durationHours: item.durationHours ?? 24,
    price: item.price,
    stock: item.stock ?? '',
    perMemberLimit: item.perMemberLimit ?? '',
    requiredRoles: item.requiredRoles,
    enabled: item.enabled,
    rarity: item.rarity ?? '',
    announce: Boolean(item.announce),
    imagePath: item.imagePath ?? null,
  });

/** The Shop tab of the Economy page: the items, and the form to add or change one. */
export default function EconomyShopAdmin({ guildId, currency }) {
  const limits = useModuleLimits('economy');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null); // null = no form open
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getShopItems(guildId)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [guildId]);

  if (error) return <LoadError error={error} what="the shop" />;
  if (!data) return <p className="v2-state">Loading…</p>;

  const { items, roles } = data;
  const rarities = data.rarities ?? [];
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const roleType = form && (form.type === 'temp_role' || form.type === 'role');
  const collectible = form && form.type === 'collectible';
  const money = (n) => `${currency.emoji} ${Number(n).toLocaleString('en-US')} ${currency.name}`;

  async function run(fn) {
    setBusy(true);
    try {
      const out = await fn();
      setData((d) => ({ ...d, items: out.items }));
      return out;
    } catch (err) {
      notify(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onSave(e) {
    e.preventDefault();
    const body = {
      name: form.name,
      description: form.description,
      emoji: form.emoji,
      type: form.type,
      roleId: roleType ? form.roleId : '',
      durationHours: form.durationHours,
      price: form.price,
      stock: form.stock,
      perMemberLimit: form.perMemberLimit,
      requiredRoles: form.requiredRoles,
      enabled: form.enabled,
      rarity: collectible ? form.rarity : '',
      announce: collectible ? form.announce : false,
    };
    if (collectible && form.file && form.file.size > IMAGE_MAX_BYTES) {
      notify('The picture is larger than 2 MB.');
      return;
    }
    const out = await run(() =>
      form.id ? updateShopItem(guildId, form.id, body) : createShopItem(guildId, body)
    );
    if (!out) return;
    const id = form.id ?? out.id;
    // The picture goes up once the item exists (it belongs to an item). When it is refused the item is
    // kept and the form stays open on it, so the picture can be tried again.
    if (collectible && form.file) {
      const uploaded = await run(() => uploadShopItemImage(guildId, id, form.file));
      if (!uploaded) {
        set({ id, file: null });
        return;
      }
    }
    notify(form.id ? 'Item saved.' : 'Item added.', 'info');
    setForm(null);
  }

  async function onRemoveImage() {
    const ok = await confirmDialog({
      title: 'Remove the picture?',
      body: 'The item cannot be bought until it has a picture again. Members who own it keep their copy.',
      confirmLabel: 'Remove picture',
    });
    if (!ok) return;
    const out = await run(() => deleteShopItemImage(guildId, form.id));
    if (out) set({ imagePath: null });
  }

  async function onMove(index, by) {
    const ids = items.map((i) => i.id);
    const to = index + by;
    if (to < 0 || to >= ids.length) return;
    [ids[index], ids[to]] = [ids[to], ids[index]];
    await run(() => reorderShopItems(guildId, ids));
  }

  async function onDelete(item) {
    const ok = await confirmDialog({
      title: `Delete ${item.name}?`,
      body: 'It leaves the shop. What members already own is kept: their inventory shows it as "item removed", and a role they hold stays until you revoke it or it runs out.',
      confirmLabel: 'Delete item',
    });
    if (!ok) return;
    await run(() => deleteShopItem(guildId, item.id));
  }

  return (
    <>
      <div className="v2-group">
        <h2 className="v2-group-title">Items ({items.length})</h2>
        <p className="v2-field-hint">
          Members see the items that are not paused, in this order. Buying a temporary role again while it
          runs adds the new time to what is left.
        </p>
        {items.length === 0 ? <p className="v2-note">No items yet. Add the first one below.</p> : null}
        <div className="v2-list">
          {items.map((item, index) => (
            <div className="v2-row" key={item.id}>
              {item.type === 'collectible' && item.imagePath ? (
                <img className="v2-thumb" src={item.imagePath} alt="" width="48" height="48" />
              ) : null}
              <div className="v2-row-main">
                <h3 className="v2-break">
                  {item.emoji ? `${item.emoji} ` : ''}
                  {item.name}
                  {!item.enabled ? <span className="v2-field-hint"> — paused</span> : null}
                  {item.type === 'collectible' && !item.imagePath ? (
                    <span className="v2-field-hint"> — no picture yet, it cannot be bought</span>
                  ) : null}
                </h3>
                <p className="v2-field-hint">
                  <Meta
                    items={[
                      money(item.price),
                      TYPE_LABELS[item.type],
                      item.type === 'temp_role' && `${item.durationHours} h`,
                      (item.type === 'temp_role' || item.type === 'role') &&
                        (roles.find((r) => r.id === item.roleId)?.name ?? 'role missing'),
                      item.type === 'collectible' &&
                        item.rarity &&
                        (rarities.find((r) => r.key === item.rarity)?.label ?? item.rarity),
                      item.type === 'collectible' && item.announce && 'announced',
                      item.left === null ? 'unlimited stock' : `${item.left} of ${item.stock} left`,
                      `${item.purchases} sold`,
                      `${money(item.revenue)} earned`,
                    ]}
                  />
                </p>
              </div>
              <div className="v2-row-actions">
                <button
                  type="button"
                  className="v2-btn-ghost"
                  disabled={busy || index === 0}
                  aria-label={`Move ${item.name} up`}
                  onClick={() => onMove(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="v2-btn-ghost"
                  disabled={busy || index === items.length - 1}
                  aria-label={`Move ${item.name} down`}
                  onClick={() => onMove(index, 1)}
                >
                  ↓
                </button>
                <button type="button" className="v2-btn-ghost" onClick={() => setForm(toForm(item))}>
                  Edit
                </button>
                <button
                  type="button"
                  className="v2-btn-ghost"
                  disabled={busy}
                  onClick={() => run(() => setShopItemEnabled(guildId, item.id, !item.enabled))}
                >
                  {item.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  type="button"
                  className="v2-btn-danger-ghost"
                  disabled={busy}
                  onClick={() => onDelete(item)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
        {!form ? (
          <button type="button" className="v2-btn-primary" onClick={() => setForm(blankForm())}>
            Add an item
          </button>
        ) : null}
      </div>

      {form ? (
        <form className="v2-group v2-section-gap" onSubmit={onSave}>
          <h2 className="v2-group-title">{form.id ? 'Edit item' : 'New item'}</h2>
          <div className="v2-field-row">
            <div className="v2-field">
              <label htmlFor="item-name">Name</label>
              <input
                id="item-name"
                type="text"
                required
                maxLength={limitOf(limits, 'itemName').maxLength}
                value={form.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </div>
            <div className="v2-field">
              <label htmlFor="item-emoji">
                Emoji <span className="v2-field-hint">— optional</span>
              </label>
              <input
                id="item-emoji"
                type="text"
                maxLength={limitOf(limits, 'itemEmoji').maxLength}
                value={form.emoji}
                onChange={(e) => set({ emoji: e.target.value })}
              />
            </div>
          </div>
          <div className="v2-field">
            <label htmlFor="item-description">Description</label>
            <textarea
              id="item-description"
              rows={2}
              maxLength={limitOf(limits, 'itemDescription').maxLength}
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </div>
          <div className="v2-field-row">
            <div className="v2-field">
              <label htmlFor="item-type">What it is</label>
              <select id="item-type" value={form.type} onChange={(e) => set({ type: e.target.value })}>
                {Object.entries(TYPE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            {roleType ? (
              <div className="v2-field">
                <label htmlFor="item-role">Role</label>
                <select id="item-role" value={form.roleId} onChange={(e) => set({ roleId: e.target.value })}>
                  <option value="">— pick a role —</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {form.type === 'temp_role' ? (
              <div className="v2-field">
                <label htmlFor="item-hours">For how many hours</label>
                <input
                  id="item-hours"
                  type="number"
                  min={limitOf(limits, 'itemDurationHours').min}
                  max={limitOf(limits, 'itemDurationHours').max}
                  value={form.durationHours}
                  onChange={(e) => set({ durationHours: e.target.value })}
                />
              </div>
            ) : null}
          </div>
          <div className="v2-field-row">
            <div className="v2-field">
              <label htmlFor="item-price">Price</label>
              <input
                id="item-price"
                type="number"
                min={limitOf(limits, 'itemPrice').min}
                max={limitOf(limits, 'itemPrice').max}
                value={form.price}
                onChange={(e) => set({ price: e.target.value })}
              />
            </div>
            <div className="v2-field">
              <label htmlFor="item-stock">
                Stock <span className="v2-field-hint">— empty is unlimited</span>
              </label>
              <input
                id="item-stock"
                type="number"
                min={limitOf(limits, 'itemStock').min}
                max={limitOf(limits, 'itemStock').max}
                value={form.stock}
                onChange={(e) => set({ stock: e.target.value })}
              />
            </div>
            <div className="v2-field">
              <label htmlFor="item-limit">
                Most per member <span className="v2-field-hint">— empty is no limit</span>
              </label>
              <input
                id="item-limit"
                type="number"
                min={limitOf(limits, 'itemPerMemberLimit').min}
                max={limitOf(limits, 'itemPerMemberLimit').max}
                value={form.perMemberLimit}
                onChange={(e) => set({ perMemberLimit: e.target.value })}
              />
            </div>
          </div>
          {collectible ? (
            <>
              <div className="v2-field-row">
                <div className="v2-field">
                  <label htmlFor="item-rarity">
                    Rarity <span className="v2-field-hint">— optional</span>
                  </label>
                  <select
                    id="item-rarity"
                    value={form.rarity}
                    onChange={(e) => set({ rarity: e.target.value })}
                  >
                    <option value="">— none —</option>
                    {rarities.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="v2-field">
                  <label htmlFor="item-image">Picture</label>
                  <input
                    id="item-image"
                    type="file"
                    accept={IMAGE_ACCEPT}
                    onChange={(e) => set({ file: e.target.files?.[0] ?? null })}
                  />
                </div>
              </div>
              {form.imagePath ? (
                <div className="v2-field">
                  <img
                    className="v2-thumb"
                    src={form.imagePath}
                    alt="The current picture"
                    width="96"
                    height="96"
                  />
                  <button
                    type="button"
                    className="v2-btn-danger-ghost"
                    disabled={busy}
                    onClick={onRemoveImage}
                  >
                    Remove picture
                  </button>
                </div>
              ) : null}
              <p className="v2-field-hint">
                PNG, JPEG or WebP, up to 2 MB. Sylo re-encodes it as a PNG of at most 512 by 512 pixels, so
                metadata is removed and an animation becomes its first frame. A collectible cannot be bought
                until it has a picture. Stock makes it a limited edition.
              </p>
              <div className="v2-field">
                <label className="v2-check" htmlFor="item-announce">
                  <input
                    id="item-announce"
                    type="checkbox"
                    checked={form.announce}
                    onChange={(e) => set({ announce: e.target.checked })}
                  />
                  Announce purchases
                </label>
                <p className="v2-field-hint">
                  Needs the announcement channel in the Economy settings. Only the buyer is mentioned.
                </p>
              </div>
            </>
          ) : null}
          <div className="v2-field" role="group" aria-labelledby="item-required-label">
            <label id="item-required-label">
              Required roles{' '}
              <span className="v2-field-hint">— a member needs any one of them; none means everybody</span>
            </label>
            <ChipPicker
              kind="role"
              items={roles}
              value={form.requiredRoles}
              onChange={(requiredRoles) => set({ requiredRoles })}
            />
          </div>
          <div className="v2-field">
            <label className="v2-check" htmlFor="item-enabled">
              <input
                id="item-enabled"
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              For sale (untick to pause it)
            </label>
          </div>
          <div className="v2-field-row">
            <button type="submit" className="v2-btn-primary" disabled={busy}>
              Save item
            </button>
            <button type="button" className="v2-btn-ghost" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </>
  );
}

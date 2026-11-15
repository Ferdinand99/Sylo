import { useEffect, useState } from 'react';
import { useCmd } from '../platformContext.jsx';
import { adjustEconomyMember, getEconomyMember, getEconomyMembers, resetEconomy } from '../api.js';
import { notify } from '../notify.js';
import Callout from '../components/Callout.jsx';
import EconomyActivity from '../components/EconomyActivity.jsx';
import EconomyInventory from '../components/EconomyInventory.jsx';
import EconomyShopAdmin from '../components/EconomyShopAdmin.jsx';
import ChipPicker from '../components/ChipPicker.jsx';
import HowItWorks from '../components/HowItWorks.jsx';
import LoadError from '../components/LoadError.jsx';
import Meta from '../components/Meta.jsx';
import SaveBar from '../components/SaveBar.jsx';
import TabRow from '../components/TabRow.jsx';
import SectionIndex from '../components/SectionIndex.jsx';
import CopyButton from '../components/CopyButton.jsx';
import { useOperator } from '../useOperator.js';
import EmojiPicker from '../components/EmojiPicker.jsx';
import Time from '../components/Time.jsx';
import UnitInput from '../components/UnitInput.jsx';
import { confirmDialog } from '../components/ConfirmDialog.jsx';
import { useModuleForm } from '../components/useModuleForm.js';
import { limitOf, useModuleLimits } from '../components/useModuleLimits.js';

// The Economy page has tabs: Settings; Members (the member list, with one member's balances, ledger,
// inventory and staff changes); Shop (the items); Activity (recent purchases).
const TABS = [
  ['settings', 'Settings'],
  ['members', 'Members'],
  ['shop', 'Shop'],
  ['activity', 'Activity'],
];

// The panels of one member's page.
const MEMBER_PANELS = [
  ['ledger', 'Transactions'],
  ['inventory', 'Inventory'],
];

const SORTS = [
  ['total', 'Total'],
  ['cash', 'Cash'],
  ['bank', 'Bank'],
];

const KIND_LABELS = {
  start: 'Starting balance',
  message: 'Chat',
  voice: 'Voice',
  daily: 'Daily',
  work: 'Work',
  pay_out: 'Payment sent',
  pay_in: 'Payment received',
  tax: 'Payment tax',
  rob_win: 'Robbery (won)',
  rob_loss: 'Robbery (lost)',
  rob_fine_out: 'Fine for a failed robbery',
  rob_fine_in: 'Fine received',
  deposit: 'Deposit',
  withdraw: 'Withdrawal',
  staff_add: 'Staff added',
  staff_remove: 'Staff removed',
  staff_set: 'Staff set',
  reset: 'Reset',
};

const money = (n, c) => `${c.currencyEmoji} ${Number(n).toLocaleString('en-US')} ${c.currencyName}`;
const signed = (n) => `${n > 0 ? '+' : ''}${Number(n).toLocaleString('en-US')}`;

/** A whole-number setting with its limits from the server. */
function Num({ id, label, hint, field, unit, limits, form, set }) {
  const { min, max } = limitOf(limits, field);
  return (
    <div className="v2-field">
      <label htmlFor={id}>{label}</label>
      <UnitInput
        id={id}
        unit={unit}
        min={min}
        max={max}
        value={form[field]}
        onChange={(e) => set({ [field]: Number(e.target.value) })}
      />
      {hint ? <p className="v2-field-hint">{hint}</p> : null}
    </div>
  );
}

// A public address shown as a "Copy link" and "Open" pair, not as a long printed URL.
function PageLink({ url, what }) {
  return (
    <p className="v2-page-link">
      <CopyButton text={url} what={what} />
      <a className="v2-btn-ghost v2-btn-compact" href={url} target="_blank" rel="noopener noreferrer">
        Open <span className="v2-sr-only">{what} in a new tab</span>
      </a>
    </p>
  );
}

function Check({ id, label, hint, field, form, set, link, linkWhat }) {
  return (
    <div className="v2-field">
      <label className="v2-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={Boolean(form[field])}
          onChange={(e) => set({ [field]: e.target.checked })}
        />
        {label}
      </label>
      {hint ? <p className="v2-field-hint">{hint}</p> : null}
      {link ? <PageLink url={link} what={linkWhat} /> : null}
    </div>
  );
}

function Settings({ guildId, m, limits }) {
  const { data, form, set } = m;
  const cmd = useCmd();
  const operator = useOperator();
  const props = { limits, form, set };

  async function onReset() {
    const ok = await confirmDialog({
      title: 'Reset the whole economy?',
      body: 'Every member goes back to a new start: cash to the starting balance, an empty bank, no streak and no cooldowns. The ledger keeps one "Reset" row per member showing what they had. This cannot be undone.',
      confirmLabel: 'Reset the economy',
      typeToConfirm: 'RESET',
    });
    if (!ok) return;
    try {
      const out = await resetEconomy(guildId, 'RESET');
      notify(`The economy was reset: ${out.accounts} account(s).`, 'info');
    } catch (err) {
      notify(err.message);
    }
  }

  return (
    <>
      <SectionIndex
        sections={[
          ['eco-currency', 'Currency'],
          ['eco-chat', 'Chat'],
          ['eco-voice', 'Voice'],
          ['eco-daily', 'Daily and work'],
          ['eco-bank', 'Bank and payments'],
          ['eco-rob', 'Robbing'],
          ['eco-shop', 'Shop'],
          ['eco-board', 'Leaderboard and log'],
        ]}
      />
      <form onSubmit={m.save} data-savebar>
        <div className="v2-group">
          <h2 className="v2-group-title" id="eco-currency">
            Currency
          </h2>
          <div className="v2-field-row">
            <div className="v2-field">
              <label htmlFor="currencyName">Name</label>
              <input
                id="currencyName"
                type="text"
                maxLength={limitOf(limits, 'currencyName').maxLength}
                value={form.currencyName}
                onChange={(e) => set({ currencyName: e.target.value })}
              />
              <p className="v2-field-hint">
                What members call it: coins, gold, credits. Shown after every amount.
              </p>
            </div>
            <div className="v2-field">
              <label htmlFor="currencyEmoji">Emoji</label>
              <div className="v2-field-row v2-emoji-row">
                <input
                  id="currencyEmoji"
                  type="text"
                  maxLength={limitOf(limits, 'currencyEmoji').maxLength}
                  value={form.currencyEmoji}
                  onChange={(e) => set({ currencyEmoji: e.target.value })}
                />
                <EmojiPicker onPick={(emoji) => set({ currencyEmoji: emoji })} />
              </div>
              <p className="v2-field-hint">
                Shown before every amount, like {form.currencyEmoji || '🪙'} 250{' '}
                {form.currencyName || 'coins'}. Pick one from the list (it has this server's own emojis too),
                or type your own.
              </p>
            </div>
          </div>
          <Num
            id="startingBalance"
            label="Starting balance"
            field="startingBalance"
            hint="Cash a member gets when they first show up in the economy (and after a reset)."
            {...props}
          />
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title" id="eco-chat">
            Earning from chat
          </h2>
          <Check
            id="messageEnabled"
            label="Members earn money by chatting"
            field="messageEnabled"
            form={form}
            set={set}
          />
          {form.messageEnabled ? (
            <>
              <div className="v2-field-row">
                <Num id="messageMin" label="At least" field="messageMin" {...props} />
                <Num id="messageMax" label="At most" field="messageMax" {...props} />
              </div>
              <div className="v2-field-row">
                <Num
                  id="messageCooldownSeconds"
                  label="Cooldown"
                  field="messageCooldownSeconds"
                  unit="seconds"
                  {...props}
                />
                <Num
                  id="messageMinLength"
                  label="Shortest message that counts"
                  field="messageMinLength"
                  unit="characters"
                  {...props}
                />
              </div>
              {data.messageLengthChecked === false ? (
                <Callout tone="info" title="The shortest-message rule is not applied">
                  This Sylo does not have the Message Content intent, so Discord does not tell it how long a
                  message is. Chat still pays, but every message counts whatever its length. Everything else
                  works as usual.
                </Callout>
              ) : null}
              <div className="v2-field" role="group" aria-labelledby="ignoredChannels-label">
                <label id="ignoredChannels-label">Channels that pay nothing</label>
                <ChipPicker
                  kind="channel"
                  items={data.channels}
                  value={form.ignoredChannels}
                  onChange={(ignoredChannels) => set({ ignoredChannels })}
                />
              </div>
              <div className="v2-field" role="group" aria-labelledby="ignoredRoles-label">
                <label id="ignoredRoles-label">Roles that earn nothing from chat</label>
                <ChipPicker
                  kind="role"
                  items={data.roles}
                  value={form.ignoredRoles}
                  onChange={(ignoredRoles) => set({ ignoredRoles })}
                />
              </div>
            </>
          ) : null}
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title" id="eco-voice">
            Earning from voice
          </h2>
          <Check
            id="voiceEnabled"
            label="Members earn money by being in voice"
            field="voiceEnabled"
            hint="Nothing is paid while alone in the channel, while deafened or in the AFK channel."
            form={form}
            set={set}
          />
          {form.voiceEnabled ? (
            <Num id="voiceAmount" label="Paid for every 5 minutes in voice" field="voiceAmount" {...props} />
          ) : null}
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title" id="eco-daily">
            Daily and work
          </h2>
          <div className="v2-field-row">
            <Num
              id="dailyBase"
              label="Daily reward"
              field="dailyBase"
              hint={`Paid by ${cmd('/daily')}, once every 24 hours.`}
              {...props}
            />
            <Num
              id="dailyStreakBonus"
              label="Extra for each day in a row"
              field="dailyStreakBonus"
              hint="Counted for up to 7 days. A streak breaks after 48 hours without claiming."
              {...props}
            />
          </div>
          <div className="v2-field-row">
            <Num id="workMin" label="Work pays at least" field="workMin" {...props} />
            <Num id="workMax" label="Work pays at most" field="workMax" {...props} />
          </div>
          <Num
            id="workCooldownMinutes"
            label="Work cooldown"
            field="workCooldownMinutes"
            unit="minutes"
            hint={`How long a member waits between ${cmd('/work')} uses.`}
            {...props}
          />
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title" id="eco-bank">
            Bank and payments
          </h2>
          <Check
            id="bankEnabled"
            label="The bank is on"
            field="bankEnabled"
            hint={`Members keep money safe from robbery with ${cmd('/deposit')} and take it out with ${cmd('/withdraw')}.`}
            form={form}
            set={set}
          />
          <Check
            id="payEnabled"
            label="Members can pay each other"
            field="payEnabled"
            hint={`${cmd('/pay')} sends cash to another member. At least 1.`}
            form={form}
            set={set}
          />
          {form.payEnabled ? (
            <Num
              id="payTaxPercent"
              label="Payment tax"
              field="payTaxPercent"
              unit="%"
              hint="Charged to the sender on top of the amount, rounded down, and removed from the economy. 0 means no tax."
              {...props}
            />
          ) : null}
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title" id="eco-rob">
            Robbing
          </h2>
          <Callout tone="warning" title="Robbing is off by default">
            With robbing on, members can steal cash from each other with {cmd('/rob')}, and a robbed member
            loses real money. It can feel unfair in some communities. Only cash can be stolen, never the bank,
            and the defaults protect new members, bots and anyone who was just robbed.
          </Callout>
          <Check
            id="robEnabled"
            label="Members can rob each other"
            field="robEnabled"
            form={form}
            set={set}
          />
          {form.robEnabled ? (
            <>
              <div className="v2-field-row">
                <Num
                  id="robChancePercent"
                  label="Chance to succeed"
                  field="robChancePercent"
                  unit="%"
                  {...props}
                />
                <Num
                  id="robCooldownHours"
                  label="Cooldown for the robber"
                  field="robCooldownHours"
                  unit="hours"
                  {...props}
                />
              </div>
              <div className="v2-field-row">
                <Num
                  id="robMinPercent"
                  label="Steals at least"
                  field="robMinPercent"
                  unit="% of their cash"
                  {...props}
                />
                <Num
                  id="robMaxPercent"
                  label="Steals at most"
                  field="robMaxPercent"
                  unit="% of their cash"
                  {...props}
                />
              </div>
              <div className="v2-field-row">
                <Num
                  id="robFinePercent"
                  label="Fine if caught"
                  field="robFinePercent"
                  unit="% of the robber's cash"
                  hint="Paid to the victim."
                  {...props}
                />
                <Num id="robFineMin" label="Smallest fine" field="robFineMin" {...props} />
              </div>
              <div className="v2-field-row">
                <Num
                  id="robVictimMinCash"
                  label="Victim must hold at least"
                  field="robVictimMinCash"
                  hint="In cash."
                  {...props}
                />
                <Num
                  id="robNewMemberHours"
                  label="New members are safe for"
                  field="robNewMemberHours"
                  unit="hours"
                  {...props}
                />
              </div>
              <Num
                id="robProtectionMinutes"
                label="After a successful robbery, the victim is safe for"
                field="robProtectionMinutes"
                unit="minutes"
                {...props}
              />
            </>
          ) : null}
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title" id="eco-shop">
            Shop
          </h2>
          <p className="v2-field-hint">
            Items are added on the Shop tab. Members buy with {cmd('/shop')} and {cmd('/buy')}.
          </p>
          <Check
            id="webShop"
            label="Web shop page"
            field="webShop"
            hint="Signed-in members of this server can browse and buy on a web page. Nobody else can see it. Off by default."
            link={`${window.location.origin}/shop/${guildId}`}
            linkWhat="shop link"
            form={form}
            set={set}
          />
          <div className="v2-field">
            <label htmlFor="shopChannelId">
              Channel for custom items <span className="v2-field-hint">— optional</span>
            </label>
            <select
              id="shopChannelId"
              value={form.shopChannelId}
              onChange={(e) => set({ shopChannelId: e.target.value })}
            >
              <option value="">— none —</option>
              {data.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            <p className="v2-field-hint">
              When a member buys a custom item, Sylo posts here so staff can fulfil it, then mark it fulfilled
              on the Members tab.
            </p>
          </div>
          <div className="v2-field">
            <label htmlFor="collectibleChannelId">
              Channel for collectible announcements <span className="v2-field-hint">— optional</span>
            </label>
            <select
              id="collectibleChannelId"
              value={form.collectibleChannelId}
              onChange={(e) => set({ collectibleChannelId: e.target.value })}
            >
              <option value="">— none —</option>
              {data.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            <p className="v2-field-hint">
              A collectible with &quot;Announce purchases&quot; switched on is announced here when someone
              buys it, with its picture. Only the buyer is mentioned. The picture shows when the dashboard has
              a public address
              {operator ? (
                <>
                  {' '}
                  (the bot owner sets <code>DASHBOARD_URL</code>)
                </>
              ) : null}
              .
            </p>
          </div>
          <Check
            id="collectionPublic"
            label="Members can show their collection"
            field="collectionPublic"
            hint={`On: ${cmd('/collection')} is public and a member can look at another member's collection. Off (the default): ${cmd('/collection')} shows only your own, and only you see it.`}
            form={form}
            set={set}
          />
        </div>

        <div className="v2-group">
          <h2 className="v2-group-title" id="eco-board">
            Leaderboard and log
          </h2>
          <Check
            id="publicLeaderboard"
            label="Public leaderboard page"
            field="publicLeaderboard"
            hint="Anyone with the link can see the richest members (name and total only, not the cash)."
            link={`${window.location.origin}/economy/${guildId}`}
            linkWhat="leaderboard link"
            form={form}
            set={set}
          />
          <div className="v2-field">
            <label htmlFor="logChannelId">
              Staff log channel <span className="v2-field-hint">— optional</span>
            </label>
            <select
              id="logChannelId"
              value={form.logChannelId}
              onChange={(e) => set({ logChannelId: e.target.value })}
            >
              <option value="">— none —</option>
              {data.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
            <p className="v2-field-hint">
              Where Sylo posts when staff add, remove or set money, reset a member, or reset the economy.
            </p>
          </div>
        </div>
      </form>

      <div className="v2-group v2-section-gap">
        <h2 className="v2-group-title">Danger zone</h2>
        <p className="v2-field-hint">
          Reset the whole economy: every member goes back to a new start. Use it for a fresh season.
        </p>
        <button type="button" className="v2-btn-danger" onClick={onReset}>
          Reset the whole economy…
        </button>
      </div>
    </>
  );
}

/** One member: balances, staff changes and the panels (the ledger; part B adds Inventory). */
function MemberPanel({ guildId, userId, config, onChanged }) {
  const limits = useModuleLimits('economy');
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [panel, setPanel] = useState(MEMBER_PANELS[0][0]);
  const [action, setAction] = useState('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getEconomyMember(guildId, userId)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [guildId, userId]);

  if (error) return <LoadError error={error} what="the member" />;
  if (!detail) return <p className="v2-state">Loading…</p>;

  const { account } = detail;
  const reasonLimit = limitOf(limits, 'reason').maxLength;
  const amountLimit = limitOf(limits, 'amount');
  const needsAmount = action !== 'reset-user';

  async function onApply(e) {
    e.preventDefault();
    if (action === 'reset-user') {
      const ok = await confirmDialog({
        title: `Reset ${detail.member.name}?`,
        body: 'Cash goes back to the starting balance, the bank is emptied, and the streak and cooldowns are cleared.',
        confirmLabel: 'Reset member',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const out = await adjustEconomyMember(guildId, userId, {
        action,
        amount: needsAmount ? Number(amount) : 0,
        reason,
      });
      setDetail(out);
      notify(out.summary, 'info');
      setAmount('');
      setReason('');
      onChanged();
    } catch (err) {
      notify(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="v2-group v2-section-gap">
      <h2 className="v2-group-title">{detail.member.name}</h2>
      <p className="v2-field-hint">
        <Meta
          items={[
            `Cash ${money(account.cash, config)}`,
            `Bank ${money(account.bank, config)}`,
            `Total ${money(account.total, config)}`,
            account.hasAccount ? `${account.dailyStreak} day streak` : 'No account yet',
            !detail.member.inServer && 'Not in the server',
          ]}
        />
      </p>

      <form onSubmit={onApply}>
        <div className="v2-field-row">
          <div className="v2-field">
            <label htmlFor="eco-action">Change</label>
            <select id="eco-action" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="add">Add to cash</option>
              <option value="remove">Remove (cash first, then bank)</option>
              <option value="set">Set cash to</option>
              <option value="reset-user">Reset the member</option>
            </select>
          </div>
          {needsAmount ? (
            <div className="v2-field">
              <label htmlFor="eco-amount">Amount</label>
              <input
                id="eco-amount"
                type="number"
                inputMode="numeric"
                min={action === 'set' ? amountLimit.min : 1}
                max={amountLimit.max}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          ) : null}
        </div>
        <div className="v2-field">
          <label htmlFor="eco-reason">
            Reason <span className="v2-field-hint">— optional, kept in the ledger</span>
          </label>
          <input
            id="eco-reason"
            type="text"
            maxLength={reasonLimit}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <button type="submit" className="v2-btn-primary" disabled={busy || (needsAmount && amount === '')}>
          Apply
        </button>
      </form>

      {MEMBER_PANELS.length > 1 ? (
        <TabRow role="tablist" activeKey={panel}>
          {MEMBER_PANELS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={panel === key}
              className={`v2-tab${panel === key ? ' is-active' : ''}`}
              onClick={() => setPanel(key)}
            >
              {label}
            </button>
          ))}
        </TabRow>
      ) : null}

      {panel === 'inventory' ? (
        <EconomyInventory
          guildId={guildId}
          userId={userId}
          inventory={detail.inventory ?? []}
          currency={{ emoji: config.currencyEmoji, name: config.currencyName }}
          onChange={(inventory) => {
            setDetail((d) => ({ ...d, inventory }));
            getEconomyMember(guildId, userId)
              .then(setDetail)
              .catch(() => {});
            onChanged();
          }}
        />
      ) : null}

      {panel === 'ledger' ? (
        <>
          <h3 className="v2-group-title">Latest transactions</h3>
          {detail.transactions.length === 0 ? (
            <p className="v2-note">No transactions in the last 180 days.</p>
          ) : null}
          <div className="v2-list">
            {detail.transactions.map((t) => (
              <div className="v2-row" key={t.id}>
                <div className="v2-row-main">
                  <h3>
                    {KIND_LABELS[t.kind] ?? t.kind} <span className="v2-field-hint">{signed(t.amount)}</span>
                  </h3>
                  <p className="v2-field-hint">
                    <Meta
                      items={[
                        <Time key="t" value={t.createdAt} />,
                        `cash ${t.cashAfter.toLocaleString('en-US')} · bank ${t.bankAfter.toLocaleString('en-US')} after`,
                        t.counterparty && `with ${t.counterparty.name}`,
                        t.actor && `by ${t.actor.name}`,
                        t.reason,
                      ]}
                    />
                  </p>
                </div>
              </div>
            ))}
          </div>
          {detail.transactionCount > detail.transactions.length ? (
            <p className="v2-note">
              Showing the newest {detail.transactions.length} of {detail.transactionCount}.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Every member with an account, paged and sortable, plus a name search. */
function Members({ guildId, config }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('total');
  const [dir, setDir] = useState('desc');
  const [page, setPage] = useState(1);
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () => {
        getEconomyMembers(guildId, { q, sort, dir, page })
          .then((d) => {
            if (!live) return;
            setList(d);
            setError(null);
          })
          .catch((e) => live && setError(e));
      },
      q ? 250 : 0
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [guildId, q, sort, dir, page, version]);

  if (error) return <LoadError error={error} what="the members" />;
  if (!list) return <p className="v2-state">Loading…</p>;

  return (
    <>
      <div className="v2-group">
        <h2 className="v2-group-title">Members with an account ({list.total.toLocaleString('en-US')})</h2>
        <div className="v2-field-row">
          <div className="v2-field">
            <label htmlFor="eco-search">Search</label>
            <input
              id="eco-search"
              type="search"
              placeholder="Search by member name or ID"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="v2-field">
            <label htmlFor="eco-sort">Sort by</label>
            <select
              id="eco-sort"
              value={sort}
              disabled={Boolean(q)}
              onChange={(e) => {
                setSort(e.target.value);
                setPage(1);
              }}
            >
              {SORTS.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="v2-field">
            <label htmlFor="eco-dir">Order</label>
            <select
              id="eco-dir"
              value={dir}
              disabled={Boolean(q)}
              onChange={(e) => {
                setDir(e.target.value);
                setPage(1);
              }}
            >
              <option value="desc">Highest first</option>
              <option value="asc">Lowest first</option>
            </select>
          </div>
        </div>

        {list.rows.length === 0 ? (
          <p className="v2-note">{q ? 'No member matches.' : 'Nobody has an account yet.'}</p>
        ) : null}
        <div className="v2-list">
          {list.rows.map((r) => (
            <div className="v2-row" key={r.userId}>
              <div className="v2-row-main">
                <h3 className="v2-break">
                  {r.member.name}
                  {!r.member.inServer ? <span className="v2-field-hint"> — not in the server</span> : null}
                </h3>
                <p className="v2-field-hint">
                  <Meta
                    items={[
                      `Total ${money(r.total, config)}`,
                      `cash ${r.cash.toLocaleString('en-US')}`,
                      `bank ${r.bank.toLocaleString('en-US')}`,
                      !r.hasAccount && 'no account yet',
                    ]}
                  />
                </p>
              </div>
              <div className="v2-row-actions">
                <button type="button" className="v2-btn-ghost" onClick={() => setPicked(r.userId)}>
                  Manage
                </button>
              </div>
            </div>
          ))}
        </div>

        {list.pages > 1 ? (
          <div className="v2-field-row">
            <button
              type="button"
              className="v2-btn-ghost"
              disabled={list.page <= 1}
              onClick={() => setPage(list.page - 1)}
            >
              Previous
            </button>
            <span className="v2-field-hint">
              Page {list.page} of {list.pages}
            </span>
            <button
              type="button"
              className="v2-btn-ghost"
              disabled={list.page >= list.pages}
              onClick={() => setPage(list.page + 1)}
            >
              Next
            </button>
          </div>
        ) : null}
      </div>

      {picked ? (
        <MemberPanel
          key={picked}
          guildId={guildId}
          userId={picked}
          config={config}
          onChanged={() => setVersion((v) => v + 1)}
        />
      ) : null}
    </>
  );
}

export default function Economy() {
  const cmd = useCmd();
  const limits = useModuleLimits('economy');
  const m = useModuleForm('economy');
  const [tab, setTab] = useState('settings');

  if (m.status === 'error') return <LoadError error={m.error} what="Economy settings" />;
  if (m.status === 'loading') return <p className="v2-state">Loading…</p>;

  return (
    <>
      <h1 className="v2-section-title">Economy</h1>
      <p className="v2-field-hint">
        A currency members earn by chatting and in voice, keep in cash or in a bank, send to each other and
        compete for on a leaderboard.
      </p>
      <p className="v2-field-hint">
        Commands: <code>{cmd('/balance')}</code> <code>{cmd('/daily')}</code> <code>{cmd('/work')}</code>{' '}
        <code>{cmd('/deposit')}</code> <code>{cmd('/withdraw')}</code> <code>{cmd('/pay')}</code>{' '}
        <code>{cmd('/rob')}</code> <code>{cmd('/economy-leaderboard')}</code> and, for staff with Manage
        Server, <code>{cmd('/eco')}</code>. Everything staff can do with <code>{cmd('/eco')}</code> can also
        be done on the Members tab.
      </p>
      <HowItWorks>
        <p>
          Money is whole numbers; each server has its own balances. A member holds cash (what can be stolen)
          and a bank (safe). Every change is written to a ledger that keeps the last 180 days, so staff can
          see where money came from. Nobody can hold more than 1,000,000,000 in total.
        </p>
      </HowItWorks>

      <TabRow role="tablist" activeKey={tab}>
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`v2-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </TabRow>

      {tab === 'settings' ? <Settings guildId={m.guildId} m={m} limits={limits} /> : null}
      {tab === 'members' ? <Members guildId={m.guildId} config={m.baseline} /> : null}
      {tab === 'shop' ? (
        <EconomyShopAdmin
          guildId={m.guildId}
          currency={{ emoji: m.baseline.currencyEmoji, name: m.baseline.currencyName }}
        />
      ) : null}
      {tab === 'activity' ? (
        <EconomyActivity
          guildId={m.guildId}
          currency={{ emoji: m.baseline.currencyEmoji, name: m.baseline.currencyName }}
        />
      ) : null}

      <SaveBar dirty={m.dirty} saving={m.saving} onSave={m.save} onReset={m.reset} />
    </>
  );
}

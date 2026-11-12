# Applications (beta)

Forms that members fill in, **in DM, on the web, or either**, for staff to accept or deny: staff
applications, member applications, event sign-ups, anything with questions and a decision. A
server can have up to **10 forms**; each has its own questions, requirements, channels, roles and
messages. The same flow works on Discord and Fluxer, and it uses no modals. It is free, like the
rest of Sylo.

**Dashboard:** `/v2/guilds/<id>/m/applications`.

## Needs

- **View Channel**, **Read Message History**, **Send Messages** and **Embed Links** in the channel for
  new applications (and in the accepted and denied channels, when a form has them). A staff thread
  also needs **Create Public Threads**.
- **Manage Roles**, and a Sylo role **above** every role a form gives or takes away, when the form
  changes roles. Sylo checks this before a member starts and again when they submit, and refuses
  up front instead of doing half the work.
- The **Server Members** intent (`INTENT_GUILD_MEMBERS`, on by default; see
  [privileged intents](../self-hosting.md#privileged-intents)). Without it Sylo does not see members
  leave, so a pending application cannot be denied automatically when its member leaves.
- Members must allow DMs from server members to answer in DM, and to get the messages from Sylo.
- For the web form, Sylo needs a public address (`DASHBOARD_URL`).

## Forms

Each form has:

- a **name** (60 characters) and a **description** (500), an **open** switch, and up to **25 questions**;
- a **fill mode**: **in DM or on the web** (the member chooses, the default for a new form), **DM only**,
  or **web only**. A DM-only form has no web form, and a web-only form is never asked in DM;
- a time to answer in DM (default 30 minutes);
- the [requirements](#requirements), the channels, the [roles](#roles), four [messages](#messages-to-the-applicant)
  and what happens when a member leaves.

Questions have a label, an optional help text and a **required** switch. The types are:

| Type | The member |
|---|---|
| **Text** | writes a short answer (up to 1024 characters) or a long one (up to 4000), with a shortest and a longest length |
| **Choice** | picks one of up to 10 options, or several (with at least and at most) |
| **Role** | picks from up to 10 roles. The form can give the chosen roles **never**, **when the application is submitted** or **when it is accepted** |
| **Yes / no** | answers yes or no |

The dashboard has a reorderable list of questions and a **preview** of the form as a member sees it. A form
cannot be opened before it has a question and a channel for new applications.

## How a member applies

- **`/apply start [form]`** (Fluxer: `!apply start Staff`). With one open form the name is not needed; the
  form box suggests names as you type on Discord. Discord cannot run a command that has an option and
  subcommands at once, so withdrawing is `/apply withdraw [form]`.
- **The panel message**, which staff publish in a channel from the dashboard: one button for each open form,
  or a menu when there are more than 5. Publishing again sends a new panel and deletes the old one by its
  id. On Fluxer the buttons are reactions (at most 10).
- **The web form** at `/apply/<server>/<form>` (see below).

What happens next depends on the fill mode. In DM: **Check your DMs** (private on Discord, a short notice
that Sylo deletes on Fluxer) and the questions in DM. On the web: a link. On both: two choices, **Answer in
DMs** and **Open on the web** (on Fluxer, two reactions).

### In DM

Sylo asks the questions one at a time and uses the same engine as [Introductions](introductions.md). A
member can type `skip` (only for an optional question), `keep` (to keep the answer shown as "Current:" after
**Start over**) and `cancel`. A **choice or role question is asked as numbered options**; the member answers with the numbers
(`2`, or `1,3` when several are allowed). A yes/no question takes yes or no.
Answers that do not fit are asked again. A session ends after the form's time without an answer. At the
end Sylo shows a **preview** with **Submit** and **Start over**.

While a questionnaire runs, the member's DMs to Sylo are answers. They do **not** open a
[modmail ticket](tickets.md).

### On the web

The page is in the dashboard's look and works only for **signed-in members of that server**. Anyone else
(signed out is sent to the login first; signed in but not a member, a server or form that does not
exist, a form that is off, a DM-only form, the module off) gets the same "Nothing here" page. The
answers are checked on the server with exactly the same code as in DM, with CSRF protection and a limit on
how often a person can submit. A **draft is saved in the browser only** (never on the server) and is removed when the form
is submitted. If staff change the form while it is open, the member is told and nothing is lost.

## Requirements

Checked when the member starts **and again when they submit**. Each failure gives a clear reason.

- **Required roles**: all of them, or any one.
- **Restricted roles**: turned away with any one of them, or with all of them.
- **Account age** and **time in the server** in days (optional). A time Sylo cannot find out counts as not met.
- **Cooldown after a denial** in hours (optional). It is kept when the member uses `/forget` or old
  applications are deleted, and ends by itself.
- **One pending application per form** and member. The database enforces it too.
- The form must be open and the module on.

## Submissions

A submission is stored with the questions **as they were asked** (so later edits never change old
answers), the answers, whether it came from DM or the web, who decided, the reason and when, and a short history.
It is posted as an embed in the form's channel. Long answers are split over several fields, and over more
embeds, inside Discord's limits; what does not fit is on the dashboard. The post has **Accept** and **Deny**
buttons (reactions on Fluxer). The roles you pick as **ping roles** are mentioned on a new application, and
nothing an applicant wrote can ping anyone.

- **Deciding.** A button decides at once, without a reason. To give a reason use
  **`/application accept <id> [reason]`**, **`/application deny <id> [reason]`**, or the dashboard.
  A decision is made **once**: a double click, or two staff pressing at the same moment, decide it once and
  the others are told it was already decided.
- **Who may decide.** Members with **Manage Server**, or one of the form's **manager roles**. Every way to decide
  checks this.
- **Accepted and denied channels.** When a form has them, the post is **moved** there (a new post is
  sent and the old one deleted by its id) or **copied** (the original stays and shows the result), as you choose.
- **Staff thread.** Optionally a thread on each post (Discord only; Fluxer has no threads yet).
- **Withdraw.** The applicant can withdraw a pending application with `/apply withdraw` or on the web
  page. The post stays, marked withdrawn.
- **A member who leaves** while pending: per form, keep the application, or deny it automatically with the
  reason "Left the server" (the applicant is not messaged).

## Roles

All optional, per form: a **role while waiting** (given on submit and taken off on the decision), roles **taken
away on submit**, roles **given or taken away on accept**, roles **given or taken away on deny**, and the roles a
role question gives. If a role change fails, **the decision still stands**, the post shows a warning, and the
dashboard can **retry** the roles. Nothing is applied twice, and a change that failed earlier is replaced by
the decision (a waiting role that could not be given is not given after the application was decided).

## Messages to the applicant

Four texts, sent by DM: when they **start** (before the first question), when they have **submitted**, when
**accepted** and when **denied**. They can use `{user}`, `{server}`, `{form}` and `{reason}`, all filled in one
pass. Leave one empty to send nothing. A DM that fails is noted on the application.

## The dashboard

- **Forms**: create, edit (with the preview), delete.
- **Applications**: a list filtered by form, status and member, a page for each application (answers, history, source,
  accept or deny with a reason, retry the roles, delete), and the history of one member.
- **Export**: one form, optionally one status, as **CSV or JSON**: the answers only, with the member id,
  status and date (no reviewer, reason or history). A cell that a spreadsheet would run as a formula is made text. The download
  is for staff only and is written to the audit log (who, which form, how many; never the answers).
- **Panel and settings**: publish, republish or remove the panel message, and the retention.

## Privacy

Answers are personal data. They are never written to the logs.

- **`/forget`** deletes the member's applications **and their posts** (and staff threads). If a post cannot
  be deleted, the answers are erased anyway and only the ids are kept, so the post can be deleted later. Staff
  names on other people's applications are removed. The cooldown after a denial stays until it has run out,
  so `/forget` cannot be used to skip it.
- **`/mydata`** and the dashboard's member data include the member's applications.
- **Retention.** Accepted, denied and withdrawn applications are deleted, with their posts, after a number of
  days you set (default **180**, at least **7**). Pending applications are never deleted by this.
- Removing the server's data deletes the forms, applications and cooldowns.

## On Fluxer

There are no slash commands, private replies, modals, buttons or threads. Members use `!apply start <form>`;
choices and roles are numbered options of at most 10; the panel, the choice of DM or web, the preview's **Submit** and
**Start over**, and **Accept** and **Deny** are reactions; staff use `!application accept <id> <reason>` for a reason. See
[Fluxer](../fluxer.md).

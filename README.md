# ClearSky-OMEGA — Ops Console

Internal deployment for ClearSky staff who deliver the projects clients submit
through the project intake tool. Runs at `alpha.clearskyomega.com`.

One dashboard for the whole loop: an intake arrives, a response clock starts, a
person picks it up, prices it, builds it in the editor under the client's own
tenant, delivers it back, and the commission becomes payable.

---

## What changed in v2 — read this first

**v1 read the wrong collection.** It created `intake_requests` for itself, while
the real intake at `tools.csebuilders.com/intake.html` writes to
`intake_projects`. A client could submit work the console never saw — which is
exactly what happened to the sunesol record on 2 Aug.

Three things follow, and they're the whole substance of this release:

1. **One queue.** The console reads `intake_projects`, the same records
   `intake-admin.html` works from. `ops.collection` in `config.js` if that ever
   needs to move.
2. **No second intake form.** `intake.html` is gone from this repo. "New intake"
   opens the real tool. Shipping a second form is how the queue split.
3. **Tenants are discovered, not listed.** See below.

---

## Adding a customer costs nothing here

You have concord, spatco, sunesol, nextnrg, demo, iqgen, fenecon — and you'll
keep adding. A hardcoded list would mean editing and redeploying this repo every
time, and a customer you forgot would be invisible rather than obviously missing.

So tenants resolve from three sources, in order:

| | Source | What it gives |
|---|---|---|
| 1 | `omega_orgs` collection | the registry you already have — orgId + name |
| 2 | orgIds seen on intake records | anyone who has actually submitted |
| 3 | `ops.tenantNames` in `config.js` | display-name overrides only |

Stand up a new tenant's repo, let them submit, and they appear — tagged
*discovered* in the Clients table until they're in `omega_orgs`.

`tenantNames` exists only to fix a name the domain doesn't title-case well:
`iqgen.energy` would otherwise render as "Iqgen". It is not a gate.

**`omega_orgs` is optional.** If it's empty or unreadable the console logs a
console warning and falls back to record discovery, so it degrades to "whoever
has actually submitted" rather than to nothing. Populating it is still worth
doing — it's the only source that names a tenant who hasn't submitted yet.

**ClearSky's own orgs are excluded** (`ops.internalOrgs`). Without that the
console lists itself as a customer the first time staff file a test intake.

---

## The pipeline

These are `intake_projects`' own statuses, from `clientStatus()` in your rules.
The console deliberately invents none — `intake-admin.html` reads the same
records and would show an unknown state.

```
  draft / saved     client still typing — not in the queue, not in any average
        │
    submitted   ──▶ response clock running
        │
      quoted    ──▶ priced, waiting on the client
        │
     accepted   ──▶ fee agreed, ready to build
        │
  in_production ──▶ editor project created under the CLIENT's orgId
        │
    delivered   ──▶ commission payable
```

`declined` sits outside the pipeline and keeps its response time in the
client's average — a job you answered slowly and then lost should still count.

**Self-serve intakes are hidden by default.** `purpose: 'build'` is the client
opening their own project with no fee. Real, but not our work and it never
pays, so `ops.serviceOnly: true` keeps it out of the delivery queue. Set false
to show both, and accept that the response-time average will drop on work
nobody owes a reply to.

---

## Response time: what it can and can't tell you yet

The metric is **first response** — `submittedAt` → `firstResponseAt` — the
moment a human replied, not when the work finished.

`intake_projects` has no first-response field of its own. The console writes one
the first time staff act on a record. Two consequences, both visible on the
dashboard:

- **It is not retroactive.** Intakes submitted before this shipped show "—"
  forever. The metric starts now.
- **Answered-but-unmeasured is not zero.** A record already at `quoted` or
  beyond with no stamp counts as answered — we clearly replied, we priced it —
  but its response time reads "—". Counting it as zero would flatter the average
  with work nobody measured. The dashboard shows the count of these under
  *Median first reply* so the gap is visible rather than silent.

Targets are wall-clock, not business hours:

| Priority | Target |
|---|---|
| Critical | 2 h |
| Rush | 8 h |
| Standard | 24 h |

Amber at 60% of target, red past it, and the clock keeps counting into overtime
rather than parking at 100% — a 20-minute miss and a two-day miss should not
look the same.

A standard intake landing 6pm Friday is amber by Saturday lunchtime with nobody
at fault. Once volume makes that unfair, add a business-hours calendar in
`ops-data.js` — not a longer target, which would also slacken the weekday number
that actually matters.

---

## Commission

`quote.total × rate`, earned when status reaches `ops.payableStatus`
(default `delivered`).

There is no commission rate in `intake_projects`, so it comes from
`ops.defaultCommissionRate` (5%) unless a record carries its own. `paidAt` moves
a payout from Pending to Paid and is never set automatically.

**If you'd rather pay on client sign-off than on issue**, add that status to
`omega-intake.js` and `intake-admin.html` first, then point `payableStatus` at
it. Nothing else changes. Don't add it here alone — the admin console would show
an unknown state.

### The approval chain is now closed in the rules

v1 left one person able to set a fee, mark it delivered, and mark their own
commission paid. The merged `firestore.rules` fixes that using your existing
`quote`-pinning pattern:

| Field | Who can write it |
|---|---|
| `quote.*` | administrators only (already yours) |
| `commissionRate`, `paidAt` | administrators only (**added**) |
| `firstResponseAt` | staff, **write-once**; administrators can correct |
| everything else | any active `omega_staff` rep |

Write-once on the response stamp matters: without it, the person being measured
on response time can move the number that measures them.

A rep hitting **Save commercials** will get a permission error. That's correct,
and the drawer says so before they click.

---

## Field mapping is provisional

`omega-intake.js` hasn't been read directly, so every field resolves through
`pick()` against several candidate paths — `customer.company`, `site.address`,
`admin.assignee`, `quote.total` and so on.

Where nothing matches, the drawer renders **Fields the console didn't recognise**
with the raw JSON, so a wrong guess is visible and correctable rather than
silently blank. Send `omega-intake.js`, `intake.html` and `intake-admin.html`
and the candidate lists tighten; nothing else needs to change.

---

## What's in here

| File | Shared? | Notes |
|---|---|---|
| `index.html` | **forked — this repo only** | The ops console |
| `ops-data.js` | **this repo only** | Status model, SLA maths, payouts, discovery |
| `config.js` | **this repo only** | The only file to edit |
| `editor.html` | **shared** | BESS Site Map — byte-identical |
| `projects.html` | **shared** | Project list — byte-identical |
| `omega-brand.js` | **shared** | Tenant resolution + branding — byte-identical |
| `omega-logo.png` | platform asset | ClearSky-OMEGA mark |

Checksums, verified before this repo was cut:

```
editor.html     sha256 1d022b57773f5da0…
projects.html   sha256 912ef1b17956446c…
omega-brand.js  sha256 0857cfe65e6b316c…
```

Fixes to those belong upstream and get copied down. Never patch them here.

**`index.html` is forked deliberately.** The staff dashboard has nothing in
common with the tenant portal — no marketplace, no upgrade badges, no per-org
scoping — and bolting an ops mode onto the shared page would put staff-only code
into every customer's download. The cost is real: shared-portal improvements no
longer reach this repo for free. The three genuinely shared files still behave
normally, so an editor fix still copies down like any other tenant.

---

## Where the editor fits

**Start build** creates a document in `projects` stamped with the *client's*
`orgId`, linked back via `intakeId`. Two things follow:

- The client sees the project in their own portal the moment it exists. No
  export step, no "which copy is current".
- They can watch it being built. On a fixed-price job where that's not what you
  want, hold off on **Start build** and use a scratch project under
  `clearsky-usa.com` first.

---

## Deploying

1. Push to the `alpha` Vercel project.
2. **Bump the cache buster** if you changed `config.js`: `index.html` loads it
   with no version query, so a stale copy is served until the browser gives up
   on it. `/config.js?v=N` in the `<script src>` is the fix, the same way the
   tool registry uses `omega-tools.js?v=8`.
3. Deploy the merged `firestore.rules`. Without it the console signs in and
   shows an empty queue, which looks like "no data yet".
4. Confirm your account has an active `omega_staff` doc, or is on
   `clearsky-usa.com` / `csebuilders.com` — `isOmegaStaff()` covers both.

Empty queue on day one is fine. **Load sample data** gives eight fabricated
intakes, in memory only, shaped like real `intake_projects` documents so it also
exercises the field-tolerance paths. Nothing is written; every record is flagged.

---

## Access

Restricted to `@clearsky-usa.com` and `@csebuilders.com`, checked in two places:
`OmegaBrand.resolve()` in the browser and `isStaff()`/`isOmegaStaff()` in the
rules. The browser check is the polite one; the rules are the real one.

To admit a rep on another domain, promote them in `omega_staff` — that's what
the role model is for. They'll also need adding to `allowedEmails` in the
`tenant` block of `config.js`, or the browser gate stops them before the rules
ever run.

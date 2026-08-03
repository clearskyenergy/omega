# ClearSky-OMEGA — Ops Console

Internal deployment for ClearSky staff who deliver the projects clients submit
through the intake form.

One dashboard for the whole loop: a request arrives, a response clock starts, a
person picks it up, builds it in the editor under the client's own tenant,
delivers it back, the client signs off, and the commission becomes payable.

**This is not a client tenant.** Nobody outside ClearSky should be able to sign
in, and the console deliberately reads across every tenant's data — which is
the one thing the client deployments are built to prevent. That has
consequences; see [Firestore rules](#firestore-rules) below, and read
[Before anyone gets paid from this](#before-anyone-gets-paid-from-this).

---

## What's in here

| File | Shared? | Notes |
|---|---|---|
| `index.html` | **forked — this repo only** | The ops console. Not the tenant portal page. |
| `intake.html` | **this repo only** | Project intake form (staff, optionally client-facing) |
| `ops-data.js` | **this repo only** | Status model, SLA maths, payout maths, Firestore access |
| `config.js` | **this repo only** | Staff tenant + all ops settings |
| `editor.html` | **shared** | BESS Site Map application — byte-identical |
| `projects.html` | **shared** | Project list — byte-identical |
| `omega-brand.js` | **shared** | Tenant resolution + branding — byte-identical |
| `omega-logo.png` | platform asset | ClearSky-OMEGA mark, used throughout |

The three shared files are byte-identical to the FENECON, iQGen and Concord
deployments, verified before this repo was cut:

```
editor.html     sha256 1d022b57773f5da0…
projects.html   sha256 912ef1b17956446c…
omega-brand.js  sha256 0857cfe65e6b316c…
```

Fixes to those belong upstream and get copied down. Never patch them here.

### Why `index.html` is forked, and what it costs

Every client repo ships `index.html` untouched — that's the platform's core
rule and it's the reason a new tenant is one config file. This repo breaks it,
because the staff dashboard has nothing in common with the tenant portal: no
marketplace, no upgrade badges, no per-org scoping. Bolting an ops mode onto
the shared page would have put staff-only code into every customer's download.

The cost is real and worth naming: **portal improvements no longer reach this
repo for free.** If someone changes the topbar or the auth screen in the shared
`index.html`, this console keeps the old one until somebody ports it by hand.
The three genuinely shared files above still behave normally, so an editor fix
still copies down like any other tenant — it's only the dashboard that has
forked.

If that drift becomes a problem, the alternative is to move the console to
`ops.html` and let `index.html` stay shared and redirect staff to it. That
keeps byte-identity at the cost of a redirect hop. Worth revisiting once the
console stops changing weekly.

---

## Firestore rules

**The console will sign in and show an empty queue until this is done.** That
failure looks exactly like "no data yet", so do this first.

Client tenants are locked to one `orgId` and the rules enforce it. Staff need
the opposite: read every org's requests, and write projects *into* a client's
org so finished work lands in the client's own portal with no export step.

Add to `firestore.rules`:

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ── ClearSky staff ──────────────────────────────────────────────
    // Email-domain check, not a hardcoded uid list, so a new hire works
    // the moment their Google Workspace account exists. email_verified
    // matters: without it a self-signup with a spoofed address passes.
    function isStaff() {
      return request.auth != null
          && request.auth.token.email_verified == true
          && request.auth.token.email.matches('.*@(clearsky-usa\\.com|csebuilders\\.com)');
    }

    // Your existing per-tenant helper, unchanged.
    function userOrg() {
      return request.auth.token.email.split('@')[1].lower();
    }

    // ── Intake requests ─────────────────────────────────────────────
    match /intake_requests/{id} {
      // Staff see and work the whole queue.
      allow read, update: if isStaff();

      // A client may create a request for their own org and read their own
      // back, but never edit one — status, timestamps and money are ours.
      allow create: if isStaff()
                    || (request.auth != null
                        && request.resource.data.orgId == userOrg());
      allow read:   if request.auth != null && resource.data.orgId == userOrg();

      // Nothing is deleted. A withdrawn request goes to status 'cancelled'
      // so the response time it generated stays in the record.
      allow delete: if false;
    }

    // ── Projects ────────────────────────────────────────────────────
    // Keep your existing per-org rule and add the staff clause.
    match /projects/{id} {
      allow read, write: if isStaff()
                         || (request.auth != null && resource.data.orgId == userOrg());
      allow create: if isStaff()
                    || (request.auth != null && request.resource.data.orgId == userOrg());
    }
  }
}
```

Two things to check before you deploy these:

1. **`userOrg()` above is a guess** at your existing helper. Use the one
   already in your rules file — the FENECON deployment needed it to map three
   mail domains onto one `orgId`, and a naive `split('@')[1]` would undo that.
2. **`matches()` in Firestore rules is a full-string RE2 match**, so
   `.*@clearsky-usa\.com` matches the whole address and nothing longer. Test
   it in the Rules Playground with a real staff address and an outside one
   before shipping.

---

## Getting it running

1. **Deploy** to Vercel as its own project, subdomain `ops` on
   `clearskyomega.com`. Add a CNAME `ops` in the GoDaddy zone pointing at
   whatever target Vercel issues — the hash is per-domain, so copy it from
   Vercel, not from another tenant's record.
2. **Firebase authorized domains** — Console → Authentication → Settings. Add
   both `ops.clearskyomega.com` **and** the raw `*.vercel.app` URL. Missing the
   Vercel URL is the failure where the page renders fine and Google sign-in
   errors out.
3. **Firestore rules** — the section above. Do this before you demo it.
4. **Sign in** with a `@clearsky-usa.com` or `@csebuilders.com` account. Any
   other domain is refused at `OmegaBrand.resolve()`.
5. **Empty queue?** That's expected on day one. The dashboard offers *Load
   sample data* — eight fabricated requests, in memory only, never written to
   Firestore, every one flagged so nothing sneaks into a real number. Use it to
   check the layout and the maths, then hit *Refresh* to go back to live data.

If DNS gives you `DNS_PROBE_FINISHED_NXDOMAIN` right after adding the record,
that's a cached negative response on your machine — flush with
`sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`, then turn off
Chrome's secure DNS at `chrome://settings/security`, which keeps a separate
cache the system flush doesn't touch.

---

## How the work flows

```
  intake.html            index.html (console)                    editor.html
  ───────────            ────────────────────                    ───────────
  client or staff  ──▶   New          response clock running
  submits                 │
                          ├─ Reply & acknowledge  ──▶ clock stops, email opens
                          │
                         Acknowledged
                          │
                          ├─ Start build ──▶ creates a project under the
                          │                  CLIENT's orgId  ─────────────▶ opens
                         In progress
                          │
                          ├─ Send to review
                         Internal review
                          │
                          ├─ Deliver to client ──▶ email opens, work is
                          │                        already in their portal
                         Delivered
                          │
                          ├─ Mark completed  ──▶ commission becomes payable
                         Completed
```

`On hold` and `Cancelled` sit outside the pipeline. Held cards park in the
Acknowledged column with a badge; cancelled requests drop off the board but
keep their response time in the client's average, which is the point — a
request you answered slowly and then lost should still count against you.

The board supports drag-and-drop between columns, and dropping onto a column
stamps the same timestamps the buttons do.

### Where the editor fits

**Start build** creates a document in `projects` stamped with the *client's*
`orgId`, not ClearSky's, and links it back to the request via `intakeId`. Two
things follow:

- The client sees the project in their own portal, under their own tenant, the
  moment it exists. There is no export/import step and no "which copy is
  current" problem.
- They can watch it being built. If that's not what you want on a fixed-price
  job, hold off on **Start build** until the work is far enough along, and use
  a scratch project in `/projects.html` under `clearsky-usa.com` first.

---

## Response time

The number the console is built around is **first response**: from
`submittedAt` to `firstResponseAt`, meaning the moment a human replied — not
the moment the work was done. That's the metric a client actually feels.

Targets live in `config.js` under `ops.sla`:

| Priority | Target |
|---|---|
| Critical | 2 hours |
| Rush | 8 hours |
| Standard | 24 hours |

The bar goes amber at 60% of target (`ops.warnAt`) and red past it, and keeps
counting into overtime rather than parking at 100% — a 20-minute miss and a
two-day miss should not look the same.

**These are wall-clock hours, not business hours.** A standard request landing
at 6pm Friday is amber by Saturday lunchtime with nobody at fault. Once you
have real volume and that starts reading as unfair, the fix is a business-hours
calendar in `ops-data.js` — not a longer target, which would also slacken the
weekday number that actually matters.

One deliberate exception: logging a request through `intake.html` with *"Assign
this to me and count it as answered"* ticked stamps the response immediately.
When you log a request after a phone call, the call **was** the first response,
and starting a clock on it would report a lie.

---

## Commission

Set in `config.js`:

```js
defaultCommissionRate: 0.05    // 5%, overridable per request
```

Payout is `value × rate`, and it is earned **on completion only** — when the
client signs off, not when the file is sent. Delivered-but-unsigned is the
tempting one to count and the wrong one: the client can still come back with
changes, and a rep watching a number that later drops is worse than one
watching a number that only goes up.

`paidAt` is what moves a payout from **Pending** to **Paid**. Nothing sets it
automatically — payroll does, or you do, from the request. The console should
not be the system of record for money leaving the building.

### Before anyone gets paid from this

As it stands, one person can set a request's contract value, set its commission
rate, mark it delivered, mark it completed, and mark their own commission paid.
That's the entire chain with no second pair of eyes on it. For a two-person
team that's fine and the friction of anything else isn't worth it. As soon as
there are reps who didn't build the platform, it isn't.

Three options, cheapest first:

1. **Watch it.** The Earnings → *By person* table is the report to read. No
   code, no ceremony, works until it doesn't.
2. **Lock the money fields in the rules.** Let anyone move status, but only
   named accounts write `value`, `commissionRate`, `completedAt` or `paidAt`:
   ```js
   allow update: if isStaff()
     && (request.resource.data.diff(resource.data)
           .affectedKeys()
           .hasAny(['value','commissionRate','completedAt','paidAt']) == false
         || isApprover());
   ```
   with `isApprover()` checking a short allowlist of addresses.
3. **Require the client to sign off in their own portal.** The honest version,
   and the most work: a confirm action in the tenant portal writes
   `completedAt`, so staff can't. Worth doing eventually; not worth doing now.

Whichever you pick, decide it before the first commission is paid rather than
after the first one is disputed.

---

## Opening the intake form to clients

Default is staff-only: `intake.html` requires a ClearSky sign-in and staff log
requests on a client's behalf, usually straight after a call.

To hand clients a link instead, set `ops.publicIntake: true` in `config.js` and
share `/intake.html?client=<orgId>`, e.g.
`https://ops.clearskyomega.com/intake.html?client=fenecon.com`.

**The flag alone does nothing** — the write still needs a rule permitting
unauthenticated create:

```js
match /intake_requests/{id} {
  allow create: if request.auth == null
    && request.resource.data.orgId is string
    && request.resource.data.orgId in ['fenecon.com','iqgen.energy','concordenergyusa.com']
    && request.resource.data.projectName is string
    && request.resource.data.projectName.size() < 200
    && request.resource.data.contactEmail.matches('.*@.*\\..*')
    && request.resource.data.status == 'new'
    && request.resource.data.value == 0;
}
```

Be clear-eyed about what that is: **a publicly writable collection.** The
allowlist and the size caps keep the damage bounded, and pinning `status` and
`value` stops anyone submitting a pre-completed request worth $2m. It does not
stop someone spamming the queue. Turn on **App Check** before you share the
link anywhere it could be scraped, and prefer sending the link to a named
contact over putting it on a website.

The safer middle path — and the one worth trying first — is to let clients sign
in to their own tenant and submit from there. The `create` rule for
authenticated users in the main rules block above already allows it; it just
needs a link to `intake.html` from their portal.

---

## The data

Collection: **`intake_requests`**. Full field reference is in the header
comment of `ops-data.js`; the fields that carry meaning:

| Field | Why it matters |
|---|---|
| `orgId` | The **client's** org. Scopes the CRM, and stamps the project the editor opens. |
| `submittedAt` → `firstResponseAt` | The response time. Everything on the dashboard derives from this pair. |
| `status` | Drives the board and every roll-up. See `OpsData.STATUS`. |
| `completedAt` | Makes commission payable. Nothing earlier does. |
| `paidAt` | Pending vs Paid. Set by payroll. |
| `projectId` | The linked editor project. Set by **Start build**. |
| `activity[]` | Human-readable log. **Never use `activity[].at` for maths** — Firestore refuses `serverTimestamp()` inside arrays, so those carry a client clock. The top-level `*At` fields are server-stamped and are what the numbers use. |

The queue is read with a single unfiltered `get()` and sorted client-side, the
same approach `projects.html` uses, which avoids needing a composite index. If
this ever passes a few thousand documents, filter completed work out of the
board query and page the archive separately.

---

## Tenants

`config.js` lists the known tenants for the intake form's client picker and so
a newly onboarded client shows up in the CRM with "nothing submitted yet"
instead of being invisible:

```js
tenants: [
  { orgId: 'fenecon.com',          name: 'FENECON' },
  { orgId: 'iqgen.energy',         name: 'iQGen Technologies' },
  { orgId: 'concordenergyusa.com', name: 'Concord Energy' }
]
```

This list is a convenience, not a gate. A tenant missing from it still appears
the moment it submits anything — the queue reads whatever `orgId`s actually
exist in Firestore, and falls back to the `clientName` on the request itself.
Adding a tenant here is worth doing anyway, so staff don't have to remember
that Concord's domain is `concordenergyusa.com` and not the shorter form that
belongs to an unrelated Denver oil-and-gas firm.

---

## Access

Sign-in is restricted to `@clearsky-usa.com` and `@csebuilders.com`, checked in
two places: `OmegaBrand.resolve()` in the browser, and `isStaff()` in the
Firestore rules. The browser check is the polite one; the rules are the real
one. Don't rely on the first without the second.

To admit a contractor without opening their whole domain, add the individual to
the tenant block in `config.js`:

```js
allowedEmails: ['someone@gmail.com']
```

and add the same address to `isStaff()` in the rules, or they'll sign in to an
empty console — which is the confusing failure this README opened with.

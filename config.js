/* ═══════════════════════════════════════════════════════════════════════════════
   /config.js — OMEGA OPS CONSOLE (internal)
   ClearSky-OMEGA EnergyOS · ClearSky Energy Solutions internal deployment

   This is NOT a client tenant. It is the staff-side console: the people who
   pick up project-intake submissions from every tenant, do the work, deliver
   it back, and get paid on completion.

   Two consequences follow from that, and both matter:

     1. This deployment reads ACROSS orgs. Every client tenant is locked to
        one orgId; this one is not. That requires a Firestore rules change —
        see README § "Firestore rules". Without it the console signs in fine
        and shows an empty queue, which looks like a data problem.

     2. index.html is NOT the shared portal page here. It is the ops console,
        and it is specific to this repo. editor.html, projects.html and
        omega-brand.js ARE still shared and still byte-identical to the
        tenant repos — fixes belong upstream and get copied down.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function () {


window.CLEARSKY_CONFIG = {

  /* ── Firebase ──────────────────────────────────────────────────────────────
     Same clearsky-portal project as every tenant. The console has to see the
     tenants' data, so it cannot live in its own project.

     Web credentials, public by design. The security boundary is the Firestore
     rules, not this key.                                                     */
  firebase: {
    apiKey:            'AIzaSyABoM1lgOYUnd5ZadaoTMhYmA9cHa8Tyo0',
    authDomain:        'clearsky-portal.firebaseapp.com',
    projectId:         'clearsky-portal',
    storageBucket:     'clearsky-portal.firebasestorage.app',
    messagingSenderId: '742134484347',
    appId:             '1:742134484347:web:ab0f95fd221536158481de',
    measurementId:     'G-8D92GNW555'
  },

  /* ── The staff "tenant" ────────────────────────────────────────────────────
     orgId is ClearSky's own. It scopes the things staff own themselves —
     their scratch projects in /projects.html, their team_members profile —
     while the ops queue deliberately reads across every orgId.               */
  tenant: {
    type:          'developer',
    clientName:    'ClearSky Operations',

    orgId:         'clearsky-usa.com',
    allowedDomain: 'clearsky-usa.com',

    /* The dev team signs in from csebuilders.com. Same workspace, same
       queue — orgId above is fixed regardless of which address signs in. */
    allowedDomains: ['csebuilders.com'],

    /* Contractors and new hires without a company address yet. Add the
       individual, not their whole domain. */
    // allowedEmails: [],

    logo:          '/omega-logo.png',

    /* Staff see every tool. There is no upsell path to an employee. */
    accountTier:   'Internal',
    tierLevel:     3,
    trial:         null,

    requiredTools: ['editor'],
    unlockedTools: [],          // tierLevel 3 already opens the whole catalog

    exportBrand: {
      logo:              '/omega-logo.png',
      name:              'ClearSky Energy Solutions',
      poweredBy:         'Powered by ClearSky-OMEGA',
      platformCopyright: '© 2026 ClearSky Energy Solutions LLC · ClearSky-OMEGA platform'
    }
  },

  adminDomains: ['csebuilders.com', 'clearsky-usa.com'],

  platformName: 'ClearSky-OMEGA',
  supportEmail: 'dev@clearsky-usa.com',
  upgradeEmail: 'dev@clearsky-usa.com',


  /* ═════════════════════════════════════════════════════════════════════════
     OPS CONSOLE SETTINGS
     Everything below is read by /ops-data.js and exists only on this repo.
     ═════════════════════════════════════════════════════════════════════════ */
  ops: {

    /* ── Where the queue lives ─────────────────────────────────────────────
       The SAME collection tools.csebuilders.com/intake.html writes to and
       intake-admin.html works from. There is exactly one queue.

       v1 of this console read its own `intake_requests` collection, which
       meant a client could submit a job the console never saw. Don't point
       this at a private collection again.                                   */
    collection: 'intake_projects',

    /* The real intake tool. This repo deliberately does NOT ship its own
       form — a second intake form is how the queue got split the first
       time. "New intake" opens this, with ?org= prefilled where known.      */
    intakeUrl: 'https://tools.csebuilders.com/intake.html',

    /* ── Tenants ───────────────────────────────────────────────────────────
       NOT a list. Tenants are discovered, in this order:

         1. the `omega_orgs` collection — the registry you already have
         2. orgIds seen on actual intake records
         3. the overrides below

       So adding a customer costs nothing here: stand up their repo, let them
       submit, and they appear. Redeploying this repo per customer was the
       wrong shape for a list that keeps growing.

       Use tenantNames ONLY to fix a display name — when omega_orgs has no
       entry and the domain doesn't title-case into something readable.
       "iqgen.energy" would otherwise render as "Iqgen".                     */
    tenantNames: {
      'iqgen.energy':        'iQGen Technologies',
      'concordenergyusa.com':'Concord Energy',
      'fenecon.com':         'FENECON',
      'sunesol.com':         'SunESol',
      'nextnrg.com':         'NextNRG',
      'spatco.com':          'SPATCO'
    },

    /* ClearSky's own orgs. Excluded from Clients and from every client
       metric — without this the console lists itself as a customer the
       first time a staff member files a test intake. */
    internalOrgs: ['clearsky-usa.com', 'csebuilders.com'],

    /* ── What counts as work ───────────────────────────────────────────────
       An intake carries purpose 'service' (Omega builds it, for a fee) or
       'build' (the client opens their own project, no fee). Only 'service'
       is our delivery queue. Set false to show both — the self-serve ones
       will drag the response-time average down for work nobody owes a
       reply on.                                                             */
    serviceOnly: true,

    /* ── Response-time targets ─────────────────────────────────────────────
       Measured submittedAt → firstResponseAt: when a human replied, not
       when the work finished.

       intake_projects has no first-response field of its own, so the console
       writes one the first time staff act on a record. TWO CONSEQUENCES:
       existing intakes show "—" forever (the metric is not retroactive), and
       records already past 'submitted' with no stamp read as answered but
       unmeasured rather than as zero.

       These are WALL-CLOCK hours, not business hours. A standard intake
       landing 6pm Friday is amber by Saturday lunchtime with nobody at
       fault. Once volume makes that unfair, add a business-hours calendar in
       ops-data.js rather than lengthening the target — a longer target would
       also slacken the weekday number that actually matters.                */
    sla: {
      critical: 2,    // hours
      rush:     8,
      standard: 24
    },
    warnAt: 0.6,      // amber at 60% of target, red past it

    /* Days from acknowledgement to delivery when an intake carries no
       dueDate of its own. Drives the "Late" badge on the board. */
    deliveryDays: {
      critical: 3,
      rush:     7,
      standard: 14
    },

    /* ── Payouts ───────────────────────────────────────────────────────────
       Commission = quote.total × rate, earned when status reaches
       payableStatus.

       'delivered' is intake_projects' terminal state (STATUS in
       omega-intake.js), so that's the default. omega-intake.js also stamps
       completedAt when a record reaches it, which is where the delivery date
       comes from — there is no separate deliveredAt field.

       The console invents no statuses: intake-admin.html reads these same
       records and would show an unknown state. If you'd rather pay on client
       sign-off than on issue, add that status to omega-intake.js AND
       intake-admin.html first, then point this at it.

       There is no commission rate in intake_projects, so it comes from
       defaultCommissionRate unless a record carries its own.

       TWO DIFFERENT PAYMENTS, two different fields — don't merge them:
         quote.paidAt        the CLIENT settled their invoice with Omega
         commissionPaidAt    the REP was paid their cut by payroll
       Reusing quote.paidAt for both would mark a rep paid the moment the
       customer's money landed, which is weeks early and not payroll's call.
       commissionPaidAt is written only from the Earnings view, by an
       administrator, and never automatically.                               */
    payableStatus: 'delivered',
    defaultCommissionRate: 0.05,
    currency: 'USD'
  }
};


/* ═══════════════════════════════════════════════════════════════════════════════
   SETUP GUARD — same shape as the tenant repos, one extra check.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function (cfg) {
  var problems = [];

  var fb = cfg.firebase || {};
  for (var k in fb) {
    if (fb.hasOwnProperty(k) && String(fb[k]).indexOf('REPLACE_ME') >= 0) {
      problems.push('/config.js still has placeholder Firebase credentials. Copy the '
        + 'firebase block from a working deployment.');
      break;
    }
  }

  var host = location.hostname;
  var localish = (host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
  if (location.protocol === 'http:' && !localish) {
    problems.push('This page is served over HTTP. Firebase Auth requires HTTPS outside '
      + 'localhost \u2014 Google sign-in will fail. Install a certificate for ' + host + '.');
  }

  if (!problems.length) return;

  var MSG = 'Deployment not finished: ' + problems.join(' \u00B7 ');
  if (window.console && console.error) {
    for (var i = 0; i < problems.length; i++) console.error('[ClearSky-OMEGA setup] ' + problems[i]);
  }

  function apply() {
    var el = document.getElementById('auth-err');
    if (!el) { return setTimeout(apply, 200); }
    el.textContent = MSG;
    el.style.display = 'block';
    var ids = ['email-auth-btn', 'google-signin-btn'];
    for (var j = 0; j < ids.length; j++) {
      var b = document.getElementById(ids[j]);
      if (b) { b.disabled = true; b.style.opacity = '0.5'; b.style.cursor = 'not-allowed'; b.title = MSG; }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})(window.CLEARSKY_CONFIG);


})();

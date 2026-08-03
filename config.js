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

    /* ── Response-time targets ─────────────────────────────────────────────
       Measured from `submittedAt` to `firstResponseAt` — the moment a human
       acknowledges the request, not the moment the work is done. This is the
       number the console is built around, so be honest about what it means:

       These are WALL-CLOCK hours, not business hours. A standard request that
       lands at 6pm Friday is already amber by Saturday lunchtime with nobody
       at fault. If that reads as unfair once you have real volume, the fix is
       a business-hours calendar in ops-data.js — not a longer target, which
       would also slacken the weekday number.                                */
    sla: {
      critical: 2,    // hours
      rush:     8,
      standard: 24
    },

    /* Amber at this fraction of the target elapsed; red past the target. */
    warnAt: 0.6,

    /* ── Delivery target ───────────────────────────────────────────────────
       Days from acknowledgement to delivery, when a request carries no
       explicit dueDate of its own. Used for the pipeline's "due" column. */
    deliveryDays: {
      critical: 3,
      rush:     7,
      standard: 14
    },

    /* ── Payouts ───────────────────────────────────────────────────────────
       Commission is earned on COMPLETED work only — completed meaning the
       client has signed off, not that the file was sent. A request can carry
       its own `commissionRate` (set on the intake form) which overrides this.

       `paidAt` on the request is what moves a payout from Pending to Paid.
       Nothing in the console writes it automatically: payroll does, or you
       do, from the Earnings view. That's deliberate — the console should not
       be the system of record for money leaving the building.               */
    defaultCommissionRate: 0.05,
    currency: 'USD',

    /* ── Client-facing intake form ─────────────────────────────────────────
       false (default): /intake.html requires a signed-in staff account, and
       staff log requests on a client's behalf.

       true: the form also accepts submissions from a shared link with no
       sign-in, e.g. /intake.html?client=fenecon.com. That needs an explicit
       Firestore rule allowing unauthenticated create on intake_requests —
       see README § "Opening the intake form to clients". Do not flip this
       flag without adding the rule; the form will just fail on submit.      */
    publicIntake: false,

    /* Shown on the intake form so a client knows who picks it up. */
    intakeReplyTo: 'dev@clearsky-usa.com',

    /* Tenants the console expects to see. Purely for the intake form's
       client picker and for showing a tenant with zero requests in the CRM
       instead of silently omitting them — the queue itself reads whatever
       orgIds actually appear in Firestore, so a tenant missing from this
       list still shows up the moment it submits anything. */
    tenants: [
      { orgId: 'fenecon.com',           name: 'FENECON' },
      { orgId: 'iqgen.energy',          name: 'iQGen Technologies' },
      { orgId: 'concordenergyusa.com',  name: 'Concord Energy' }
    ]
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

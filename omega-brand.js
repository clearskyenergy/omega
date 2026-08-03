/* ═══════════════════════════════════════════════════════════════════════════════
   ClearSky-OMEGA · Tenant Branding Layer
   © 2025 ClearSky Energy Solutions LLC. Proprietary and Confidential.

   ─────────────────────────────────────────────────────────────────────────────
   WHY THIS FILE EXISTS
   ─────────────────────────────────────────────────────────────────────────────
   The portal pages (index / marketplace / projects) ship BYTE-IDENTICAL to every
   tenant. No customer name, logo, or domain is baked into their markup. This
   file is the single place that answers "which tenant is this deployment, and
   what does it look like?" — so standing up a new tenant means editing that
   deployment's /config.js and nothing else.

   ─────────────────────────────────────────────────────────────────────────────
   CONFIG CONTRACT  (/config.js, per deployment)
   ─────────────────────────────────────────────────────────────────────────────
   window.CLEARSKY_CONFIG = {
     firebase: { ... },                  // unchanged, as today

     // ── Option A: fully self-describing deployment (RECOMMENDED) ──
     // Works on every page, including ones with no workspace registry.
     tenant: {
       type:         'developer',        // 'developer' | 'partner'
       orgId:        'example.com',      // hard tenant lock — scopes ALL data
       clientName:   'Example Energy',
       accountTier:  'Enterprise',
       tierLevel:    3,
       allowedDomain:'example.com',   // primary sign-in domain
       allowedDomains:['contractor.io'], // OPTIONAL extra domains
       allowedEmails:['jane@gmail.com'], // OPTIONAL individual accounts
       requiredTools:['editor'],
       logo:         '/example-logo.png',
       exportBrand:  { name:'Example Energy', logo:'/example-logo.png' },

       // OPTIONAL — trial account with a countdown.
       trial: {
         startsAt:     '2026-08-03', // YYYY-MM-DD, local midnight
         days:         30,
         lockOnExpiry: false         // true = refuse sign-in once expired
       }
     },

     // ── Option B: name a tenant already in the WORKSPACES registry ──
     // tenantKey: 'example.com',

     // ── Option C: omit both → ZERO-CONFIG. The workspace is derived from
     //    whoever signs in: their email domain becomes the orgId, so the
     //    portal works immediately on upload with no config edit.
     //    Any domain may sign in; each is isolated by orgId (Firestore rules
     //    enforce this). Set strictTenant:true to refuse instead.

     adminDomains: ['csebuilders.com']   // may preview any locked deployment
   };

   Precedence: CFG.tenant → CFG.tenantKey → email-domain lookup in WORKSPACES.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function cfg() { return global.CLEARSKY_CONFIG || {}; }

  function domainOf(email) {
    var parts = String(email || '').split('@');
    return parts[1] ? parts[1].toLowerCase() : '';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── Tenant resolution ──────────────────────────────────────────────────── */

  /* The tenant this DEPLOYMENT is pinned to, independent of who signs in.
     Returns null on a true multi-tenant deployment (Option C above).
     `registry` is optional — pages without a WORKSPACES map pass null. */
  function pinned(registry) {
    var c = cfg();
    if (c.tenant && c.tenant.orgId) return c.tenant;
    if (c.tenantKey && registry && registry[c.tenantKey]) return registry[c.tenantKey];
    return null;
  }

  /* Every domain this tenant accepts: `allowedDomain` plus any in the optional
     `allowedDomains` array. */
  function allowedDomainsOf(ws) {
    var out = [];
    if (!ws) return out;
    if (ws.allowedDomain) out.push(String(ws.allowedDomain).toLowerCase());
    var extra = ws.allowedDomains || [];
    for (var i = 0; i < extra.length; i++) out.push(String(extra[i]).toLowerCase());
    return out;
  }

  /* Individually allowlisted addresses. Lets a specific personal account (a
     Gmail, a contractor) into a tenant WITHOUT opening its whole domain. */
  function emailAllowed(ws, email) {
    var list = (ws && ws.allowedEmails) || [];
    var e = String(email || '').toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]).toLowerCase() === e) return true;
    }
    return false;
  }

  /* True once this deployment knows who it is. False means /config.js is
     missing its `tenant` (or `workspaces`) block. */
  function configured(registry) {
    if (pinned(registry)) return true;
    for (var k in registry) { if (registry.hasOwnProperty(k)) return true; }
    return false;
  }

  /* Domains permitted to view a locked deployment in addition to the tenant's
     own (e.g. ClearSky staff previewing a client portal). */
  function adminDomains() {
    var c = cfg();
    return (c.adminDomains && c.adminDomains.length) ? c.adminDomains : [];
  }

  /* The domain users are expected to sign in with. Drives the auth copy.
     NOT a security gate — resolve() is. */
  function defaultDomain(registry) {
    var ws = pinned(registry);
    return (ws && ws.allowedDomain) || cfg().allowedDomain || '';
  }

  /* Domain hint for the Google account chooser. Suppressed when the tenant
     accepts more than one domain or allowlists individual addresses —
     otherwise Google would hide exactly the accounts we just permitted. */
  function googleHint(registry) {
    var ws = pinned(registry);
    if (!ws) return '';
    if ((ws.allowedEmails || []).length) return '';
    if (allowedDomainsOf(ws).length > 1) return '';
    return ws.allowedDomain || '';
  }

  /* ── Zero-config fallback ─────────────────────────────────────────────
     When /config.js names neither a `tenant` nor a `workspaces` map, derive a
     workspace from the signed-in user's own email domain. This is what makes
     the pages work the instant they're uploaded, with no config step.

     TRADE-OFF: in this mode ANY email domain can sign in and receives its own
     empty workspace, isolated from every other by orgId. That's right for a
     demo or a first deploy; it is NOT right for a customer-facing production
     tenant. Lock those down by defining `tenant` in /config.js — or set
     `strictTenant: true` to refuse unconfigured sign-ins outright. */
  function autoTenantEnabled() { return cfg().strictTenant !== true; }

  function titleCase(str) {
    var parts = String(str || '').split(/[-_.]+/), out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) out.push(parts[i].charAt(0).toUpperCase() + parts[i].slice(1));
    }
    return out.join(' ');
  }

  function autoTenant(email) {
    var dom = domainOf(email);
    if (!dom) return null;
    var label = titleCase(dom.replace(/\.[a-z.]+$/i, ''));
    return {
      type:          'developer',
      orgId:         dom,              // scopes all data to this domain
      clientName:    label || dom,
      accountTier:   'Enterprise',
      tierLevel:     3,
      allowedDomain: dom,
      requiredTools: ['editor'],
      _auto:         true              // flag: derived, not configured
    };
  }

  /* Authoritative gate. Returns the workspace this user may use, or null.
       • Locked deployment  → the pinned tenant, if the user's domain matches
                              it or an admin domain; otherwise null.
       • Multi-tenant       → WORKSPACES[user's domain], or null if unknown. */
  function resolve(email, registry) {
    var dom = domainOf(email);
    if (!dom) return null;

    var lock = pinned(registry);
    if (lock) {
      var ok = (allowedDomainsOf(lock).indexOf(dom) >= 0)
            || emailAllowed(lock, email)
            || (adminDomains().indexOf(dom) >= 0);
      if (!ok) return null;
      /* Admin domains keep access after expiry so you can still get in. */
      if (trialBlocks(lock) && adminDomains().indexOf(dom) < 0) return null;
      return lock;
    }

    if (registry && registry.hasOwnProperty(dom)) return registry[dom];

    /* Multi-tenant hub: honour per-tenant email allowlists too. */
    for (var k in registry) {
      if (registry.hasOwnProperty(k) && emailAllowed(registry[k], email)) return registry[k];
    }

    /* Nothing configured → derive a workspace from the user's domain. */
    if (!configured(registry) && autoTenantEnabled()) return autoTenant(email);

    return null;
  }

  /* ── Brand accessors ────────────────────────────────────────────────────── */

  function nameOf(ws) {
    if (!ws) return '';
    return ws.clientName || (ws.exportBrand && ws.exportBrand.name) || '';
  }

  function logoOf(ws) {
    if (!ws) return '';
    return ws.logo || (ws.exportBrand && ws.exportBrand.logo) || '';
  }

  function tierOf(ws) {
    if (!ws) return '';
    return (ws.type === 'partner')
      ? (ws.partnerKind || 'Partner')
      : ((ws.accountTier || 'Enterprise') + ' Account');
  }

  function platformName() { return cfg().platformName || 'ClearSky-OMEGA'; }

  /* Two different addresses, deliberately:
       supportEmail  — the TENANT's own support desk, shown to their users.
       upgradeEmail  — ClearSky's address. Upgrading, unlocking tools and
                       converting a trial are all conversations with the
                       vendor, not with the tenant's own support desk. */
  function upgradeEmail() { return cfg().upgradeEmail || 'dev@clearsky-usa.com'; }

  /* ── Trial accounts ──────────────────────────────────────────────────────
     A tenant may carry a `trial` block. Everything below derives from it; if
     it's absent, trial() returns null and nothing trial-related renders.

       trial: { startsAt:'2026-08-03', days:30, lockOnExpiry:false }

     Dates are interpreted at LOCAL midnight. A 30-day trial starting Aug 3
     runs through end of Sep 1 and is expired from Sep 2 00:00. */
  var MS_DAY = 86400000;

  function trial(ws) {
    var t = ws && ws.trial;
    if (!t || !t.startsAt) return null;

    var start = new Date(String(t.startsAt) + 'T00:00:00');
    if (isNaN(start.getTime())) return null;

    var days = t.days || 30;
    var end = new Date(start.getTime());
    end.setDate(end.getDate() + days);          // DST-safe day arithmetic

    var now = new Date();
    var notStarted = now < start;
    var expired = now >= end;

    return {
      startsAt:       start,
      endsAt:         end,                       // exclusive
      lastDay:        new Date(end.getTime() - MS_DAY),
      totalDays:      days,
      notStarted:     notStarted,
      expired:        expired,
      active:         !notStarted && !expired,
      /* Before the start date no days have been consumed, so the figure to
         show is the full allotment — not the calendar distance to the end. */
      daysLeft:       notStarted ? days
                                 : Math.max(0, Math.ceil((end - now) / MS_DAY)),
      daysUntilStart: Math.max(0, Math.ceil((start - now) / MS_DAY)),
      daysElapsed:    Math.max(0, Math.min(days, Math.floor((now - start) / MS_DAY))),
      lockOnExpiry:   t.lockOnExpiry === true
    };
  }

  /* True when an expired trial should block access outright. */
  function trialBlocks(ws) {
    var t = trial(ws);
    return !!(t && t.expired && t.lockOnExpiry);
  }

  function fmtDate(d) {
    var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return m[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  /* One-time <style> for the banner, so pages need no markup changes. */
  function ensureTrialStyles() {
    if (document.getElementById('omega-trial-css')) return;
    var css = document.createElement('style');
    css.id = 'omega-trial-css';
    css.textContent =
      '#omega-trial{font:500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'padding:9px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;' +
      'border-bottom:1px solid rgba(0,0,0,.10);position:relative;z-index:60}' +
      '#omega-trial .ot-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}' +
      '#omega-trial .ot-msg{flex:1 1 auto;min-width:200px}' +
      '#omega-trial .ot-bar{flex:0 0 140px;height:5px;border-radius:3px;' +
      'background:rgba(0,0,0,.14);overflow:hidden}' +
      '#omega-trial .ot-fill{height:100%;border-radius:3px;transition:width .4s ease}' +
      '#omega-trial .ot-cta{color:inherit;text-decoration:underline;white-space:nowrap}' +
      '#omega-trial.ot-live{background:#FFF6E5;color:#7A4E00}' +
      '#omega-trial.ot-live .ot-dot,#omega-trial.ot-live .ot-fill{background:#B8791B}' +
      '#omega-trial.ot-soon{background:#FDECEC;color:#8A1F1F}' +
      '#omega-trial.ot-soon .ot-dot,#omega-trial.ot-soon .ot-fill{background:#C0392B}' +
      '#omega-trial.ot-pending{background:#EAF2FB;color:#1B4A7A}' +
      '#omega-trial.ot-pending .ot-dot,#omega-trial.ot-pending .ot-fill{background:#2E86C1}' +
      '#omega-trial.ot-dead{background:#F4F4F5;color:#3A3A3C}' +
      '#omega-trial.ot-dead .ot-dot,#omega-trial.ot-dead .ot-fill{background:#6B6B70}';
    document.head.appendChild(css);
  }

  /* Render (or refresh) the countdown banner at the top of the page. */
  function paintTrial(ws) {
    var t = trial(ws);
    var bar = document.getElementById('omega-trial');
    if (!t) { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); return; }

    ensureTrialStyles();
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'omega-trial';
      document.body.insertBefore(bar, document.body.firstChild);
    }

    var support = upgradeEmail();
    var cta = support
      ? ' <a class="ot-cta" href="mailto:' + esc(support) + '?subject=' +
        encodeURIComponent('Upgrade ' + (nameOf(ws) || 'workspace') + ' from trial') +
        '">Upgrade</a>'
      : '';

    var cls, msg, pct;
    if (t.notStarted) {
      cls = 'ot-pending';
      pct = 0;
      msg = '<strong>' + t.daysLeft + ' day' + (t.daysLeft === 1 ? '' : 's') +
            ' left</strong> in your ' + t.totalDays + '-day trial · starts ' +
            fmtDate(t.startsAt) + cta;
    } else if (t.expired) {
      cls = 'ot-dead';
      pct = 100;
      msg = '<strong>Trial ended ' + fmtDate(t.lastDay) + '</strong> · ' +
            (t.lockOnExpiry ? 'access is now restricted' : 'access continues for now') + cta;
    } else {
      cls = (t.daysLeft <= 7) ? 'ot-soon' : 'ot-live';
      pct = Math.round((t.daysElapsed / t.totalDays) * 100);
      msg = '<strong>' + t.daysLeft + ' day' + (t.daysLeft === 1 ? '' : 's') +
            ' left</strong> in your ' + t.totalDays + '-day trial · ends ' +
            fmtDate(t.lastDay) + cta;
    }

    bar.className = cls;
    bar.innerHTML = '<span class="ot-dot"></span><span class="ot-msg">' + msg +
      '</span><span class="ot-bar"><span class="ot-fill" style="width:' + pct + '%"></span></span>';
  }

  /* ── DOM painting ───────────────────────────────────────────────────────── */

  function byId(id) { return document.getElementById(id); }

  function setText(id, txt) {
    var el = byId(id);
    if (el && txt) el.textContent = txt;
  }

  function setImg(id, src, alt) {
    var el = byId(id);
    if (!el) return;
    if (src) { el.src = src; el.alt = alt || ''; el.style.display = ''; }
    else { el.style.display = 'none'; }
  }

  /* Topbar client chip.
     Targets the CONTAINER (#tb-client-chip) rather than an inner <img>, because
     only index.html ships that <img>; marketplace and projects have an empty
     span they used to fill themselves. Owning the container here means one
     implementation for all three — and a missing logo degrades to the client
     name as text instead of an empty white box. */
  function paintChip(ws) {
    var box = byId('tb-client-chip');
    if (!box) return;
    var name = nameOf(ws), logo = logoOf(ws);

    function asText() {
      box.innerHTML = '<span class="tb-client-txt">' + esc(name) + '</span>';
    }
    if (!logo) { asText(); return; }

    var img = document.createElement('img');
    img.id = 'tb-client-logo';
    img.alt = name;
    img.onerror = asText;
    box.innerHTML = '';
    box.appendChild(img);
    img.src = logo;
  }

  /* Paint the app chrome. Safe on any page — absent elements are skipped. */
  function paint(ws) {
    if (!ws) return;
    var name = nameOf(ws), logo = logoOf(ws);

    setText('sn-logo-txt', name);      // sidebar brand
    setText('tb-logo-txt', name);      // topbar brand
    setText('sw-workspace', name);     // workspace drawer heading
    setText('co-scope', name);         // "across every <tenant> project"
    setText('ql-brand', name);         // "<tenant>-branded walkthrough"
    setText('tb-ent-badge', tierOf(ws));
    paintTrial(ws);

    paintChip(ws);
  }

  /* Paint the sign-in screen. Runs before auth, so it uses the DEPLOYMENT's
     tenant rather than the user's. */
  function paintAuth(registry) {
    var ws = pinned(registry);
    var name = nameOf(ws);
    var dom = defaultDomain(registry);

    setImg('auth-logo-img', logoOf(ws), name);
    setText('auth-company', name ? name + ' Workspace' : 'Workspace');
    setText('auth-toggle-brand', name ? (name + ' workspace') : 'this workspace');
    setText('auth-note-domain', dom ? '@' + dom : '');
    setText('auth-platform', platformName());

    var note = byId('auth-note-wrap');
    if (note) note.style.display = dom ? '' : 'none';

    var email = byId('auth-email');
    if (email && dom) email.placeholder = 'you@' + dom;
  }

  /* Set <title> as "<tenant> · <page>", falling back to the platform name. */
  function paintTitle(ws, pageLabel) {
    var name = nameOf(ws) || platformName();
    document.title = pageLabel ? (name + ' · ' + pageLabel) : name;
  }

  /* Message shown when a user's domain isn't permitted on this deployment. */
  function accessMessage(email, registry) {
    var who = email || 'an unrecognized account';

    /* Strict mode with nothing configured — say so plainly instead of
       blaming the user's account. Without strict mode we never get here,
       because autoTenant() will have resolved a workspace. */
    if (!configured(registry)) {
      return 'This deployment has no tenant configured and strictTenant is on. '
           + 'Add a `tenant` block to /config.js (see config.example.js), then reload.';
    }

    /* Expired, locked trial. */
    var lock = pinned(registry);
    var t = trial(lock);
    if (t && t.expired && t.lockOnExpiry) {
      return 'The ' + (nameOf(lock) || 'workspace') + ' trial ended on '
           + fmtDate(t.lastDay) + '. Contact '
           + upgradeEmail() + ' to continue.';
    }

    var dom = defaultDomain(registry);
    return dom
      ? ('This workspace is restricted to @' + dom + ' accounts. You signed in as '
         + who + '. Please sign in with your @' + dom + ' account.')
      : ('This account (' + who + ') is not registered to any workspace on this '
         + 'deployment. Contact your administrator for access.');
  }

  /* Make auto mode visible to anyone with devtools open. */
  function warnIfAuto(registry) {
    if (configured(registry) || !autoTenantEnabled()) return;
    if (global.console && console.warn) {
      console.warn('[OmegaBrand] No tenant in /config.js — deriving the workspace '
        + 'from each user\'s email domain. Any domain may sign in. Define '
        + '`tenant` in /config.js to lock this deployment to one customer.');
    }
  }

  global.OmegaBrand = {
    domainOf:      domainOf,
    esc:           esc,
    pinned:        pinned,
    configured:    configured,
    autoTenant:    autoTenant,
    warnIfAuto:    warnIfAuto,
    adminDomains:  adminDomains,
    defaultDomain: defaultDomain,
    googleHint:    googleHint,
    allowedDomainsOf: allowedDomainsOf,
    emailAllowed:  emailAllowed,
    resolve:       resolve,
    nameOf:        nameOf,
    logoOf:        logoOf,
    tierOf:        tierOf,
    platformName:  platformName,
    upgradeEmail:  upgradeEmail,
    trial:         trial,
    trialBlocks:   trialBlocks,
    paintTrial:    paintTrial,
    paint:         paint,
    paintAuth:     paintAuth,
    paintTitle:    paintTitle,
    accessMessage: accessMessage
  };
})(window);

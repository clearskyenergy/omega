/* ═══════════════════════════════════════════════════════════════════════════════
   ClearSky-OMEGA · Ops Data Layer  (v2)
   © 2026 ClearSky Energy Solutions LLC. Proprietary and Confidential.

   INTERNAL REPO ONLY. Not shared with tenant deployments.

   ─────────────────────────────────────────────────────────────────────────────
   WHAT CHANGED IN v2, AND WHY
   ─────────────────────────────────────────────────────────────────────────────
   v1 read a collection called `intake_requests` that this console invented for
   itself. That was a mistake: the real intake already existed at
   tools.csebuilders.com/intake.html and writes to `intake_projects`. Two
   collections meant a client could submit a job the ops console never saw —
   which is exactly what happened to the sunesol record.

   v2 reads `intake_projects`. One queue, the same one intake-admin.html works.

   v2 also stops being TOLD what the tenants are. They are DISCOVERED, in this
   order of preference:

     1. the `omega_orgs` collection — the registry that already exists
     2. orgIds observed on actual intake records
     3. `ops.tenantNames` in config.js — display-name overrides only

   Adding a customer therefore costs nothing here. Stand up their repo, let
   them submit, and they appear. No edit to this repo, no redeploy.

   ─────────────────────────────────────────────────────────────────────────────
   FIELD TOLERANCE
   ─────────────────────────────────────────────────────────────────────────────
   The exact shape written by omega-intake.js hasn't been read directly, so
   every field below resolves through pick() against several candidate paths.
   Where nothing matches, the drawer shows the raw document rather than
   rendering a blank — a wrong guess is then visible and correctable instead of
   silently losing data. Tighten the candidate lists once the real field names
   are confirmed; nothing else needs to change.
   ═══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var HOUR = 3600000, DAY = 86400000;

  /* ── Status model ────────────────────────────────────────────────────────
     These are intake_projects' OWN statuses, taken from clientStatus() and
     clientStatusMove() in the Firestore rules. The console deliberately does
     not invent new ones: intake-admin.html reads the same records, and a
     status it doesn't recognise would render as an unknown state there.

     'draft' and 'saved' are pre-submission — the client is still typing. Not
     work, so they stay out of the queue and out of every average.            */
  var STATUS = [
    { key:'draft',            label:'Draft',            short:'Draft',    color:'#9CA3AF', pipeline:false, pre:true,
      hint:'Not submitted yet. The client is still filling it in.' },
    { key:'saved',            label:'Saved (self-serve)',short:'Saved',   color:'#9CA3AF', pipeline:false, pre:true,
      hint:'Kept as the client\u2019s own record. Never sent to Omega.' },
    { key:'submitted',        label:'Submitted',        short:'New',      color:'#0070F2', pipeline:true,
      hint:'Received. Nobody has picked it up \u2014 the response clock is running.' },
    { key:'in_review',        label:'In review',        short:'Review',   color:'#6366F1', pipeline:true,
      hint:'Reviewing the inputs to price the work.' },
    { key:'quoted',           label:'Quote sent',       short:'Quoted',   color:'#8B5CF6', pipeline:true,
      hint:'A fee quote is with the client, waiting on approval.' },
    { key:'changes_requested',label:'Needs client input',short:'Blocked', color:'#D97706', pipeline:false,
      hint:'Waiting on something from the client. Off the board until they reply.' },
    { key:'accepted',         label:'Accepted',         short:'Accepted', color:'#0EA5E9', pipeline:true,
      hint:'Quote accepted, work scheduled. Ready to build.' },
    { key:'in_production',    label:'In production',    short:'Building', color:'#00A9A4', pipeline:true,
      hint:'Drawings and packages being produced. Linked to an editor project.' },
    { key:'delivered',        label:'Delivered',        short:'Delivered',color:'#16A34A', pipeline:true,
      hint:'Complete, files attached. Commission is payable.' },
    { key:'declined',         label:'Quote declined',   short:'Declined', color:'#DC2626', pipeline:false,
      hint:'Client declined the quote. No commission.' }
  ];

  /* A 'build' intake is the client opening their own project, no fee. Real,
     but not OUR work and it never pays, so it stays out of the delivery
     queue by default. Set ops.serviceOnly:false to include it. */
  var PURPOSE = {
    service: { label:'Omega builds it',   billable:true  },
    build:   { label:'Client self-serve', billable:false }
  };

  /* The six site scopes from omega-intake.js SCOPES. An intake can carry
     more than one — `scope` is a map of key -> {enabled}, not a single type. */
  var TYPES = [
    { key:'l2',      label:'Level 2 charging',            short:'L2' },
    { key:'dcfc',    label:'DC fast charging',            short:'DCFC' },
    { key:'bess',    label:'Battery storage',             short:'BESS' },
    { key:'der',     label:'Distributed energy resources',short:'DER' },
    { key:'solar',   label:'Solar PV',                    short:'Solar' },
    { key:'compute', label:'Compute / data center',       short:'Compute' }
  ];

  /* Mirrors the deliverables ledger on the intake form. */
  /* The seven deliverables, keys exactly as omega-intake.js writes them.
     Getting these wrong renders every requested package as "Siteplan". */
  var SCOPE = [
    { key:'siteplan',    label:'Project plot & site plan' },
    { key:'sitemap',     label:'Site map' },
    { key:'costs',       label:'Cost estimate & BOM' },
    { key:'loadstudy',   label:'Load study & one-line' },
    { key:'utility',     label:'Utility submission package' },
    { key:'interconnect',label:'Interconnection application' },
    { key:'ahj',         label:'AHJ permit package' }
  ];

  var PRIORITY = [
    { key:'critical', label:'Critical', color:'#DC2626' },
    { key:'rush',     label:'Rush',     color:'#D97706' },
    { key:'standard', label:'Standard', color:'#556B82' }
  ];

  function statusOf(key) {
    for (var i = 0; i < STATUS.length; i++) if (STATUS[i].key === key) return STATUS[i];
    return { key:key || 'unknown', label:key || 'Unknown', short:key || '?',
             color:'#6B7280', pipeline:false, hint:'' };
  }
  /* omega-intake.js seeds admin.priority as 'normal', not 'standard', and the
     admin console has no UI to change it — so in practice everything arrives
     'normal'. Fold the likely vocabularies onto our three rather than treating
     an unmapped value as an unknown priority with no SLA. */
  var PRIORITY_ALIAS = {
    normal:'standard', medium:'standard', low:'standard', standard:'standard',
    high:'rush', rush:'rush', urgent:'critical', critical:'critical', emergency:'critical'
  };
  function priorityKey(raw) {
    return PRIORITY_ALIAS[String(raw || '').toLowerCase()] || 'standard';
  }
  function priorityOf(key) {
    var k = priorityKey(key);
    for (var i = 0; i < PRIORITY.length; i++) if (PRIORITY[i].key === k) return PRIORITY[i];
    return PRIORITY[2];
  }
  function labelFor(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].label;
    if (!key) return '—';
    return String(key).replace(/[_-]+/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
  }

  /* ── Config ─────────────────────────────────────────────────────────────── */
  function cfg()    { return (global.CLEARSKY_CONFIG || {}); }
  function ops()    { return cfg().ops || {}; }
  function slaCfg() { return ops().sla || { critical:2, rush:8, standard:24 }; }

  /* ClearSky's own orgs are not customers. Without this the console lists
     itself as a client of itself the first time staff file a test intake. */
  function internalOrgs() {
    var list = ops().internalOrgs || ['clearsky-usa.com', 'csebuilders.com'];
    var out = {};
    for (var i = 0; i < list.length; i++) out[String(list[i]).toLowerCase()] = true;
    return out;
  }
  function isInternalOrg(orgId) { return !!internalOrgs()[String(orgId || '').toLowerCase()]; }

  /* ── Tolerant field access ───────────────────────────────────────────────
     pick(doc, ['a.b','c']) walks each dotted path, returns the first
     non-empty value. A guess that misses falls through; if all miss, the
     drawer shows the raw document so the real name is visible. */
  function dig(obj, path) {
    var parts = String(path).split('.'), cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }
  function empty(v) { return v == null || v === '' || (Array.isArray(v) && !v.length); }
  function pick(doc, paths, dflt) {
    for (var i = 0; i < paths.length; i++) {
      var v = dig(doc, paths[i]);
      if (!empty(v)) return v;
    }
    return dflt;
  }

  /* WHAT THEY ASKED FOR is deliverables[] filtered on requested:true.

     NOT `scope`. `scope` is the site description — a map of
     {l2:{enabled:false}, bess:{enabled:true}, ...} — and reading it as a
     truthy map would mark EVERY deliverable requested, because {enabled:false}
     is itself a truthy object. That bug would have shown seven packages
     requested on an intake that asked for one. */
  function pickDeliverables(d) {
    var list = d && d.deliverables;
    if (Array.isArray(list)) {
      var out = [];
      for (var i = 0; i < list.length; i++) {
        var x = list[i];
        if (x && x.requested) out.push(x.key || '');
      }
      return out.filter(Boolean);
    }
    /* Older or hand-written records may carry a plain array. */
    if (Array.isArray(d && d.scope)) return d.scope.filter(function (s) { return typeof s === 'string'; });
    return [];
  }

  /* Delivery progress: deliverables carry their own status, so a half-built
     package set is visible without opening the editor. */
  function deliverableProgress(d) {
    var list = (d && d.deliverables) || [];
    var want = 0, done = 0;
    for (var i = 0; i < list.length; i++) {
      if (!list[i] || !list[i].requested) continue;
      want++;
      if (list[i].status === 'delivered' || list[i].status === 'complete' || list[i].outputUrl) done++;
    }
    return { requested: want, done: done };
  }

  /* The site scopes actually switched on, with whatever numbers were filled
     in. Rendered generically so a new scope added upstream still appears. */
  function enabledScopes(d) {
    var sc = (d && d.scope) || {}, out = [];
    for (var k in sc) {
      if (!sc.hasOwnProperty(k)) continue;
      var s = sc[k];
      if (!s || s.enabled !== true) continue;
      var bits = [];
      for (var f in s) {
        if (!s.hasOwnProperty(f) || f === 'enabled' || f === 'notes') continue;
        var v = s[f];
        if (v === '' || v == null || v === false) continue;
        bits.push((v === true ? f : f + ' ' + v));
      }
      out.push({ key:k, label:labelFor(TYPES, k), detail:bits.join(' · ') });
    }
    return out;
  }

  /* ── Time ───────────────────────────────────────────────────────────────── */
  function ms(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { var p = Date.parse(v); return isNaN(p) ? 0 : p; }
    if (v.toDate) { try { return v.toDate().getTime(); } catch (e) { return 0; } }
    if (v instanceof Date) return v.getTime();
    if (v.seconds) return v.seconds * 1000;
    return 0;
  }
  function fmtDate(v) {
    var t = ms(v);
    if (!t) return '—';
    var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var d = new Date(t);
    return m[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  function fmtDateTime(v) {
    var t = ms(v);
    if (!t) return '—';
    return fmtDate(t) + ' · ' + new Date(t).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  }

  /* Round FIRST, then pick the unit — otherwise 59.98 minutes prints as
     "60m" and 23.99 hours as "24h", both of which make the reader convert. */
  function fmtDur(msVal) {
    if (msVal == null || isNaN(msVal)) return '—';
    var neg = msVal < 0, v = Math.abs(msVal), out;
    if (v < 60000) {
      out = Math.max(1, Math.round(v / 1000)) + 's';
      if (out === '60s') out = '1m';
    } else if (v < HOUR) {
      var mins = Math.round(v / 60000);
      out = (mins >= 60) ? '1h' : mins + 'm';
    } else if (v < DAY) {
      var h = Math.floor(v / HOUR), m = Math.round((v % HOUR) / 60000);
      if (m === 60) { h += 1; m = 0; }
      out = (h >= 24) ? '1d' : (h + 'h' + (m ? ' ' + m + 'm' : ''));
    } else {
      var d = Math.floor(v / DAY), hh = Math.round((v % DAY) / HOUR);
      if (hh === 24) { d += 1; hh = 0; }
      out = d + 'd' + (hh ? ' ' + hh + 'h' : '');
    }
    return neg ? '−' + out : out;
  }
  function fmtAgo(v) {
    var t = ms(v);
    if (!t) return '—';
    var diff = Date.now() - t;
    if (diff < 45000) return 'just now';
    return (diff >= 0) ? fmtDur(diff) + ' ago' : 'in ' + fmtDur(-diff);
  }
  function fmtMoney(n, opts) {
    var v = Number(n) || 0, compact = opts && opts.compact;
    try {
      return v.toLocaleString('en-US', {
        style:'currency', currency: ops().currency || 'USD',
        maximumFractionDigits: (compact && Math.abs(v) >= 1000) ? 0 : (v % 1 ? 2 : 0),
        notation: (compact && Math.abs(v) >= 100000) ? 'compact' : 'standard'
      });
    } catch (e) { return '$' + Math.round(v).toLocaleString(); }
  }

  /* ── Response time ───────────────────────────────────────────────────────
     intake_projects has no first-response field of its own — it tracks status
     transitions, not when a human replied. The console writes
     `firstResponseAt` itself the first time staff act on a record.

     TWO CONSEQUENCES, both worth knowing before reading the dashboard:

       • Records submitted before this shipped have no stamp and show "—"
         forever. The metric starts now; it is not retroactive.
       • A record already past 'submitted' with no stamp counts as ANSWERED
         (we clearly replied — we priced it) but its response time is
         UNKNOWN, not zero. Counting it as zero would flatter the average
         with work nobody measured.                                           */
  function targetMs(req) {
    var hours = slaCfg()[req.priority] || slaCfg().standard || 24;
    return hours * HOUR;
  }
  function responseMs(req) {
    var s = ms(req.submittedAt), f = ms(req.firstResponseAt);
    if (!s || !f) return null;
    return Math.max(0, f - s);
  }
  function answered(req) {
    if (ms(req.firstResponseAt)) return true;
    return req.status && req.status !== 'submitted' && !statusOf(req.status).pre;
  }
  function clock(req, now) {
    now = now || Date.now();
    var t = targetMs(req), sub = ms(req.submittedAt), done = responseMs(req);
    var elapsed = (done != null) ? done : (sub ? Math.max(0, now - sub) : 0);
    var frac = t ? (elapsed / t) : 0;
    var warn = (ops().warnAt != null) ? ops().warnAt : 0.6;
    var state = frac >= 1 ? 'breach' : frac >= warn ? 'warn' : 'ok';
    return {
      target:t, elapsed:elapsed, remaining:t - elapsed, frac:frac,
      pct: Math.min(100, Math.round(frac * 100)),
      state:state, settled: done != null, answered: answered(req),
      unmeasured: answered(req) && done == null
    };
  }

  /* ── Money ───────────────────────────────────────────────────────────────
     The fee lives in the `quote` map, written by an administrator. The rep's
     cut isn't in intake_projects at all, so it comes from config unless the
     record carries an explicit override.

     Commission is earned at `delivered`, this pipeline's terminal state. If
     you later add a client sign-off step, point ops.payableStatus at it and
     nothing else here changes.                                               */
  function value(req) {
    var q = (req._raw && req._raw.quote) || {};
    var v = q.total;
    if (v == null || v === '') v = q.subtotal;
    return Number(v) || 0;
  }
  function rate(req) {
    var r = req.commissionRate;
    if (r == null || isNaN(r)) r = ops().defaultCommissionRate;
    if (r == null || isNaN(r)) r = 0.05;
    return Number(r);
  }
  function payableStatus() { return ops().payableStatus || 'delivered'; }
  function payout(req) { return value(req) * rate(req); }
  function isEarned(req) { return req.status === payableStatus(); }
  function isPaid(req)   { return isEarned(req) && !!ms(req.paidAt); }

  function dueMs(req) {
    if (req.dueDate) { var p = Date.parse(String(req.dueDate) + 'T23:59:59'); if (!isNaN(p)) return p; }
    var base = ms(req.firstResponseAt) || ms(req.submittedAt);
    if (!base) return 0;
    var d = (ops().deliveryDays || {})[req.priority];
    if (d == null) d = (ops().deliveryDays || {}).standard || 14;
    return base + d * DAY;
  }
  function cycleMs(req) {
    var a = ms(req.firstResponseAt) || ms(req.submittedAt);
    var d = ms(req.deliveredAt);
    if (!a || !d) return null;
    return Math.max(0, d - a);
  }

  /* ── Normalisation ──────────────────────────────────────────────────────
     Every candidate list below is a GUESS at omega-intake.js's shape. `_raw`
     keeps the original document so the drawer can show whatever didn't map. */
  function normalize(id, d) {
    d = d || {};
    var cust = d.customer || {}, proj = d.project || {}, adm = d.admin || {};
    var purpose = d.purpose || (d.routing === 'omega' ? 'service' : 'build');
    var prog = deliverableProgress(d);

    /* Site address: project.street/city/state, falling back to the customer's
       billing address only if the project has none — a job filed against a
       head-office address is still better than a blank. */
    var siteBits = [proj.street, proj.city, proj.state, proj.zip].filter(Boolean);
    if (!siteBits.length) siteBits = [cust.city, cust.state].filter(Boolean);

    return {
      id:            id,
      intakeId:      d.intakeId || id,
      orgId:         String(d.orgId || '').toLowerCase(),
      tenantName:    d.tenantName || '',
      purpose:       purpose,
      billable:      purpose === 'service',

      clientName:    cust.company || d.tenantName || '',
      contactName:   cust.contactName || (d.createdBy && d.createdBy.name) || '',
      contactEmail:  cust.email || (d.createdBy && d.createdBy.email) || '',
      contactPhone:  cust.phone || '',
      contactRole:   cust.role || '',
      customerNotes: cust.notes || '',

      /* project.name is what the client titled it; siteName is the site. The
         intake list shows the company when neither is set, so match that
         rather than inventing "Untitled". */
      projectName:   proj.name || proj.siteName || cust.company || 'Untitled intake',
      siteName:      proj.siteName || '',
      address:       siteBits.join(', '),
      utility:       proj.utility || '',
      ahj:           proj.ahj || '',
      projectStage:  proj.stage || '',
      projectNotes:  proj.notes || '',

      /* An intake can carry several site scopes at once. */
      scopes:        enabledScopes(d),
      projectType:   (enabledScopes(d)[0] || {}).key || '',

      /* Deliverables requested, plus how many are done. */
      scope:         pickDeliverables(d),
      progress:      prog,
      /* Full rows for the requested packages, so the drawer can attach the
         output links that are the actual delivery. */
      deliverables:  (Array.isArray(d.deliverables) ? d.deliverables : [])
                       .filter(function (x) { return x && x.requested; }),

      notes:         proj.notes || cust.notes || '',
      priority:      priorityKey(adm.priority),
      dueDate:       adm.dueDate || proj.targetDate || '',
      commissionRate: d.commissionRate,

      status:        d.status || 'draft',
      assignedTo:    String(adm.assignee || '').toLowerCase(),
      assignedName:  adm.assigneeName || '',
      /* omega-intake.js calls it editorProjectId, not projectId. */
      projectId:     d.editorProjectId || '',
      projectLabel:  d.editorProjectName || '',
      internalNotes: adm.internalNotes || '',

      submittedAt:     d.submittedAt || null,
      /* Written by this console. Absent on every record that predates it. */
      firstResponseAt: d.firstResponseAt || null,
      startedAt:       d.startedAt || null,
      /* omega-intake.js stamps completedAt when status hits 'delivered'.
         That's the delivery timestamp — no separate deliveredAt exists. */
      deliveredAt:     d.completedAt || null,
      /* Commission paid to the REP. Deliberately not `paidAt`: quote.paidAt
         already means the CLIENT paid their invoice, and conflating the two
         would have the earnings ledger call a job paid out the moment the
         customer settled. */
      paidAt:          d.commissionPaidAt || null,
      clientPaidAt:    (d.quote && d.quote.paidAt) || null,
      paymentStatus:   (d.quote && d.quote.paymentStatus) || '',

      /* {ts, type, message, actor}, newest first (unshift upstream). */
      activity:      Array.isArray(d.activity) ? d.activity.slice() : [],
      messages:      Array.isArray(d.messages) ? d.messages.slice() : [],
      files:         Array.isArray(d.files) ? d.files.slice() : [],
      links:         Array.isArray(d.links) ? d.links : [],
      /* Quote detail the client sees. */
      quoteNote:     (d.quote && d.quote.note) || '',
      quoteSentAt:   (d.quote && d.quote.sentAt) || null,
      quoteCurrency: (d.quote && d.quote.currency) || 'USD',
      paymentUrl:    (d.quote && d.quote.paymentUrl) || '',
      acceptance:    d.acceptance || null,
      /* The client's own claim that they paid. Separate from
         quote.paymentStatus, which only staff set. */
      paymentClaimedAt: (d.payment && d.payment.claimedAt) || null,
      paymentRef:       (d.payment && d.payment.reference) || '',
      _raw:          d,
      _demo:         !!d._demo
    };
  }

  /* ── Firestore ──────────────────────────────────────────────────────────── */
  var _db = null, _me = { email:'', name:'' }, _orgs = [];

  function init(db, me) {
    _db = db || null;
    if (me) _me = { email:(me.email || '').toLowerCase(), name: me.name || '' };
  }
  /* ── ISO strings, NOT serverTimestamp ────────────────────────────────────
     Every other tool writing intake_projects — omega-intake.js, intake.html,
     intake-admin.html — stores dates as ISO strings and reads them back with
     `new Date(str)`. A Firestore Timestamp survives a round trip through this
     console fine, but `new Date(Timestamp)` on the tenant side yields
     "Invalid Date".

     That is exactly what happened: this console stamped updatedAt as a server
     Timestamp and the client's project list started printing Invalid Date.

     Server time would be marginally more trustworthy for an SLA clock, but not
     at the cost of corrupting a document model three other pages read. If
     clock skew ever matters, move all four tools together. */
  function stamp() { return new Date().toISOString(); }

  /* ...but /projects is the OPPOSITE convention. index.html and projects.html
     write and read Firestore Timestamps there (`p.updatedAt?.toDate?.()`), so
     an ISO string in that collection renders the date column as a dash.

     Two collections, two conventions, and they are not interchangeable.
     Unifying them means rewriting every existing document in one of them;
     until someone does that migration, write what each collection expects. */
  function serverStamp() {
    try { return firebase.firestore.FieldValue.serverTimestamp(); }
    catch (e) { return new Date(); }
  }
  function collectionName() { return ops().collection || 'intake_projects'; }

  function loadRequests() {
    if (!_db) return Promise.reject(new Error('No database connection.'));
    return _db.collection(collectionName()).get().then(function (snap) {
      var out = [];
      snap.forEach(function (doc) { out.push(normalize(doc.id, doc.data())); });
      out.sort(function (a, b) { return ms(b.submittedAt) - ms(a.submittedAt); });
      return out;
    });
  }

  /* The tenant registry that already exists. Optional: if it's empty or
     unreadable, discovery falls back to orgIds seen on records, so the
     console degrades to "whoever has actually submitted" rather than to
     nothing. */
  function loadOrgs() {
    if (!_db) return Promise.resolve([]);
    return _db.collection('omega_orgs').get().then(function (snap) {
      var out = [];
      snap.forEach(function (doc) {
        var d = doc.data() || {};
        out.push({
          orgId:  String(d.orgId || doc.id).toLowerCase(),
          name:   d.name || d.clientName || d.displayName || '',
          active: d.active !== false
        });
      });
      _orgs = out;
      return out;
    })['catch'](function (err) {
      console.warn('[ops] omega_orgs unreadable — falling back to record discovery:', err.message);
      _orgs = [];
      return [];
    });
  }
  function orgs() { return _orgs.slice(); }

  /* Display name, best available: registry → config override → the record's
     own clientName → title-cased domain. A tenant onboarded five minutes ago
     still reads as something a human recognises. */
  function tenantName(orgId, requests) {
    if (!orgId) return 'Unknown';
    var key = String(orgId).toLowerCase(), i;
    for (i = 0; i < _orgs.length; i++) if (_orgs[i].orgId === key && _orgs[i].name) return _orgs[i].name;
    var over = ops().tenantNames || {};
    if (over[key]) return over[key];
    if (requests) {
      for (i = 0; i < requests.length; i++) {
        if (requests[i].orgId === key && requests[i].clientName) return requests[i].clientName;
      }
    }
    var stem = key.replace(/\.[a-z.]+$/i, '');
    return stem.split(/[-_.]/).map(function (p) {
      return p ? p.charAt(0).toUpperCase() + p.slice(1) : '';
    }).join(' ') || key;
  }

  /* omega-intake.js writes activity as {ts, type, message, actor}. Match it
     exactly — a second shape in the same array means intake-admin.html renders
     half the log as blanks. */
  function entry(type, text) {
    return { ts: new Date().toISOString(), type: type, message: text || '',
             actor: _me.name || _me.email || 'system' };
  }

  function patch(id, fields, note) {
    if (!_db) return Promise.reject(new Error('No database connection.'));
    var body = {};
    for (var k in fields) if (fields.hasOwnProperty(k)) body[k] = fields[k];
    body.updatedAt = stamp();
    if (note) {
      try { body.activity = firebase.firestore.FieldValue.arrayUnion(entry(note.type, note.text)); }
      catch (e) { /* arrayUnion unavailable — skip the log rather than fail the write */ }
    }
    return _db.collection(collectionName()).doc(id).update(body);
  }

  /* Create the editor project for an intake and link the two. Stamped with
     the CLIENT's orgId so the finished work lands in their own portal.

     Field-for-field with omega-intake.js projectSeed(), PLUS the four canvas
     arrays index.html seeds on a hand-made project. Two paths create projects
     in this collection - a client opening their own from the intake, and this
     one - and a project that arrives missing half its context is obviously
     second-class the moment it opens in the editor.

     Timestamps here are server Timestamps, not ISO. See serverStamp(). */
  function createLinkedProject(req) {
    if (!_db) return Promise.reject(new Error('No database connection.'));
    var user = null;
    try { user = firebase.auth().currentUser; } catch (e) {}
    var raw = req._raw || {}, p = raw.project || {};
    var t = String(req.projectType || '').toLowerCase();
    return _db.collection('projects').add({
      orgId:      req.orgId,                       // the CLIENT's tenant
      uid:        user ? user.uid : null,
      name:       req.projectName || 'Untitled project',
      address:    req.address || '',
      city:       p.city || '', state: p.state || '', zip: p.zip || '',
      lat:        (p.lat === '' || p.lat == null) ? null : Number(p.lat),
      lng:        (p.lng === '' || p.lng == null) ? null : Number(p.lng),
      apn:        p.apn || '',
      utility:    p.utility || '',
      ahj:        p.ahj || '',
      stage:      p.stage || 'candidate',
      scopes:     (req.scopes || []).map(function (s) { return s.key; }),
      type:       (t === 'l2' || t === 'dcfc') ? 'EV' : 'BESS',
      client:     req.clientName || '',
      source:     'intake',
      intakeId:   req.intakeId || req.id,
      /* Owner is the STAFF member building it. The client still sees it
         because projects.html scopes on orgId, not owner. */
      ownerEmail: (_me.email || '').toLowerCase(),
      ownerName:  _me.name || _me.email || '',
      createdBy:  (_me.email || '').toLowerCase(),
      createdAt:  serverStamp(),
      updatedAt:  serverStamp(),
      elements: [], conduits: [], bessList: [], annotations: []
    });
  }


  /* ── Quoting ─────────────────────────────────────────────────────────────
     Standard rungs plus a custom amount. Fixed rungs mean two reps quoting the
     same job land on the same number, and the client sees a price list rather
     than a figure invented on a call. Anything off the ladder is still
     allowed — some jobs genuinely are bespoke — but it has to be typed
     deliberately rather than defaulted into. */
  var QUOTE_TIERS = [100, 250, 500, 750, 1000];

  /* Build the quote in the shape omega-intake.js's own sendQuote() produces,
     so intake-admin.html and the tenant portal read it with no special case.

     A flat fee still needs a LINE, because the client-facing quote renders
     lines — a total with no lines shows as a price for nothing. */
  function quotePayload(req, amount, note) {
    var wanted = (req.scope || []);
    var label = wanted.length === 1
      ? labelFor(SCOPE, wanted[0])
      : (wanted.length ? wanted.length + ' deliverables' : 'Project package');
    return {
      'quote.lines':    [{ key:'package', label:label, amount:Number(amount) || 0, note:note || '' }],
      'quote.subtotal': Number(amount) || 0,
      'quote.discount': 0,
      'quote.total':    Number(amount) || 0,
      'quote.currency': ops().currency || 'USD',
      'quote.sentAt':   stamp(),
      'quote.sentBy':   _me.email || '',
      'quote.note':     note || '',
      /* A re-quote must clear the previous answer, or a record can read as
         "accepted" against a number the client never saw. */
      acceptance:       { state:'', by:'', at:null, poNumber:'', note:'' },
      status:           'quoted'
    };
  }

  /* -- Files ---------------------------------------------------------------
     Real uploads, not just pasted links. The editor exports a proposal, a
     one-line, a plot plan, a cost estimate; those are files, and asking a rep
     to first park them on a Drive and paste the URL is a step that gets
     skipped, which is how a client ends up with "Delivered" and nothing to
     open.

     Firestore holds only the metadata. The bytes live in Cloud Storage under

         intake/{orgId}/{intakeId}/{fileId}-{name}

     ORG IS IN THE PATH ON PURPOSE. Storage rules cannot read Firestore, so
     they cannot look up who owns an intake — the only thing they can scope on
     is the path itself. Putting orgId there is what lets a client read their
     own files and nobody else's. See storage.rules.

     Links still work and are still supported. Some deliverables genuinely are
     a shared folder rather than a file.                                       */
  var MAX_FILE_MB = 50;

  function storage() {
    try { return firebase.storage(); }
    catch (e) { return null; }
  }

  function filePath(req, fileId, name) {
    var clean = String(name || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    return 'intake/' + (req.orgId || 'unknown') + '/' + (req.intakeId || req.id)
         + '/' + fileId + '-' + clean;
  }

  /* Upload one file and return the metadata row to append. Progress is
     reported so a 30 MB permit set doesn't look like a hung button. */
  function uploadFile(req, file, key, onProgress) {
    var st = storage();
    if (!st) return Promise.reject(new Error('Storage SDK not loaded on this page.'));
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      return Promise.reject(new Error(file.name + ' is ' + Math.round(file.size / 1048576)
        + ' MB. The cap is ' + MAX_FILE_MB + ' MB \u2014 put anything larger on a shared '
        + 'drive and paste the link instead.'));
    }
    var id = 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    var path = filePath(req, id, file.name);
    var task = st.ref(path).put(file, {
      contentType: file.type || 'application/octet-stream',
      customMetadata: { intakeId: String(req.intakeId || req.id), orgId: String(req.orgId || '') }
    });
    return new Promise(function (resolve, reject) {
      task.on('state_changed',
        function (s) { if (onProgress) onProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)); },
        reject,
        function () {
          resolve({
            id: id, key: key || 'other', path: path,
            name: file.name, size: file.size,
            contentType: file.type || '', at: stamp(),
            by: _me.email || '', byName: _me.name || _me.email || ''
          });
        });
    });
  }

  /* Storage download URLs are resolved at render time rather than stored.
     A stored getDownloadURL() token is a permanent public link to a
     customer's permit set — anyone it is forwarded to can read it forever,
     with no way to revoke short of rewriting the file. Resolving on demand
     keeps the storage rules in the loop on every read. */
  function fileUrl(f) {
    var st = storage();
    if (!st) return Promise.reject(new Error('Storage SDK not loaded.'));
    return st.ref(f.path).getDownloadURL();
  }

  function removeFile(req, fileId) {
    var st = storage();
    var list = ((req._raw || {}).files || []).filter(function (f) { return f.id !== fileId; });
    var gone = ((req._raw || {}).files || []).filter(function (f) { return f.id === fileId; })[0];
    var after = (st && gone)
      ? st.ref(gone.path)['delete']()['catch'](function (e) {
          /* The metadata row is what the UI reads, so a failed object delete
             must not block removing it — otherwise a stale row is unremovable. */
          console.warn('[ops] storage delete failed, removing the row anyway:', e.message);
        })
      : Promise.resolve();
    return after.then(function () { return { files: list }; });
  }

  function filesFor(req, key) {
    return (req.files || []).filter(function (f) { return (f.key || 'other') === key; });
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }


  /* -- Deliverables ------------------------------------------------------
     THE actual handover. Each requested deliverable carries its own outputUrl,
     and the tenant portal renders those as "Your files". Marking a record
     delivered without filling any of them in hands the client a status change
     and nothing else - which is exactly what this console did until now.

     The whole array is rewritten rather than patched by index: Firestore has
     no way to update one element of an array by position. The client can also
     toggle `requested` from their own intake form, so this works from the
     freshly loaded record rather than a stale copy. */
  function deliverablesPayload(req, edits) {
    var list = ((req._raw || {}).deliverables || []).map(function (d) {
      var e = edits[d.key];
      if (!e) return d;
      var out = {};
      for (var k in d) if (d.hasOwnProperty(k)) out[k] = d[k];
      if (e.outputUrl != null) {
        var u = String(e.outputUrl).trim();
        if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
        out.outputUrl = u;
      }
      if (e.note != null) out.note = e.note;
      out.status = out.outputUrl ? 'delivered'
                 : (out.status === 'delivered' ? 'in_progress' : (out.status || 'not_started'));
      out.updatedAt = stamp();
      return out;
    });
    return { deliverables: list };
  }

  /* ── Messages ────────────────────────────────────────────────────────────
     A thread on the record itself, deliberately not a subcollection: the
     client already has read+update on their own intake document, so a plain
     array needs no new rules and no second read. */
  function messagePayload(text, side) {
    return {
      id:     'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      at:     stamp(),
      side:   side || 'staff',
      by:     _me.email || '',
      byName: _me.name || _me.email || '',
      text:   String(text || '').slice(0, 4000)
    };
  }

  /* ── Roll-ups ────────────────────────────────────────────────────────────
     Drafts and declined quotes stay out of every average. A draft nobody
     sent is not a response time we missed. */
  function inQueue(r) {
    if (statusOf(r.status).pre) return false;
    if (r.status === 'declined') return false;
    if (ops().serviceOnly !== false && !r.billable) return false;
    return true;
  }
  /* Blocked on the client. Still in the queue and still counted, but parked
     on the board — chasing it is a different job from building it. */
  function isBlocked(r) { return r.status === 'changes_requested'; }

  function summarize(reqs, opts) {
    opts = opts || {};
    var now = Date.now();
    var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    var weekAgo = now - 7 * DAY;
    var pay = payableStatus();

    var s = {
      total:0, open:0, awaitingResponse:0, breached:0, reviewing:0, quoted:0,
      accepted:0, blocked:0, working:0, delivered:0, declined:0, drafts:0, selfServe:0,
      valueOpen:0, valueCompleted:0,
      earnedThisMonth:0, earnedPending:0, earnedPaid:0, earnedAll:0,
      completed:0, completedThisMonth:0,
      respAvg:null, respAvg7d:null, unmeasured:0,
      cycleAvg:null, slaHitRate:null, oldestUnanswered:null
    };
    var respAll = [], resp7 = [], cyc = [], slaOk = 0, slaCount = 0;

    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      if (opts.mine && r.assignedTo !== opts.mine) continue;
      if (statusOf(r.status).pre) { s.drafts++; continue; }
      if (!r.billable) { s.selfServe++; continue; }
      if (r.status === 'declined') { s.declined++; continue; }

      s.total++;
      var isDone = (r.status === pay);
      if (!isDone) { s.open++; s.valueOpen += value(r); }

      if (r.status === 'submitted')         s.awaitingResponse++;
      if (r.status === 'in_review')         s.reviewing++;
      if (r.status === 'quoted')            s.quoted++;
      if (r.status === 'accepted')          s.accepted++;
      if (r.status === 'changes_requested') s.blocked++;
      if (r.status === 'in_production')     s.working++;
      if (r.status === 'delivered')         s.delivered++;

      var c = clock(r, now);
      if (c.state === 'breach' && !c.answered) s.breached++;
      if (c.unmeasured) s.unmeasured++;

      if (!c.answered && ms(r.submittedAt)) {
        if (!s.oldestUnanswered || ms(r.submittedAt) < ms(s.oldestUnanswered.submittedAt)) {
          s.oldestUnanswered = r;
        }
      }

      var rm = responseMs(r);
      if (rm != null) {
        respAll.push(rm);
        if (ms(r.firstResponseAt) >= weekAgo) resp7.push(rm);
        slaCount++;
        if (rm <= targetMs(r)) slaOk++;
      }
      var cm = cycleMs(r);
      if (cm != null) cyc.push(cm);

      if (isDone) {
        s.completed++;
        s.valueCompleted += value(r);
        var p = payout(r);
        s.earnedAll += p;
        if (isPaid(r)) s.earnedPaid += p; else s.earnedPending += p;
        var when = ms(r.deliveredAt) || ms(r.submittedAt);
        if (when >= monthStart.getTime()) { s.completedThisMonth++; s.earnedThisMonth += p; }
      }
    }

    function avg(a) {
      if (!a.length) return null;
      var t = 0; for (var i = 0; i < a.length; i++) t += a[i];
      return t / a.length;
    }
    s.respAvg = avg(respAll); s.respAvg7d = avg(resp7); s.cycleAvg = avg(cyc);
    s.slaHitRate = slaCount ? (slaOk / slaCount) : null;
    s.respCount = respAll.length;
    return s;
  }

  /* Every tenant the console knows about, from all three sources, minus
     ClearSky's own orgs. */
  function byTenant(reqs) {
    var map = {}, i, r, key;

    for (i = 0; i < _orgs.length; i++) {
      key = _orgs[i].orgId;
      if (!key || isInternalOrg(key) || _orgs[i].active === false) continue;
      map[key] = { orgId:key, name:_orgs[i].name || tenantName(key), requests:[], source:'registry' };
    }
    var over = ops().tenantNames || {};
    for (key in over) {
      if (!over.hasOwnProperty(key) || isInternalOrg(key)) continue;
      if (!map[key]) map[key] = { orgId:key, name:over[key], requests:[], source:'config' };
    }
    for (i = 0; i < reqs.length; i++) {
      r = reqs[i]; key = r.orgId;
      if (!key || isInternalOrg(key)) continue;
      if (!map[key]) map[key] = { orgId:key, name:tenantName(key, reqs), requests:[], source:'observed' };
      map[key].requests.push(r);
    }

    var out = [];
    for (key in map) {
      if (!map.hasOwnProperty(key)) continue;
      var t = map[key];
      t.stats = summarize(t.requests);
      t.lastActivity = 0;
      for (i = 0; i < t.requests.length; i++) {
        var w = Math.max(ms(t.requests[i].submittedAt), ms(t.requests[i].deliveredAt));
        if (w > t.lastActivity) t.lastActivity = w;
      }
      out.push(t);
    }
    out.sort(function (a, b) {
      if (b.lastActivity !== a.lastActivity) return b.lastActivity - a.lastActivity;
      return String(a.name).localeCompare(String(b.name));
    });
    return out;
  }

  function byStaff(reqs) {
    var map = {};
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i], who = r.assignedTo;
      if (!who) continue;
      if (!map[who]) map[who] = { email:who, name:r.assignedName || who.split('@')[0], requests:[] };
      map[who].requests.push(r);
    }
    var out = [];
    for (var k in map) {
      if (!map.hasOwnProperty(k)) continue;
      map[k].stats = summarize(map[k].requests);
      out.push(map[k]);
    }
    out.sort(function (a, b) { return b.stats.earnedAll - a.stats.earnedAll; });
    return out;
  }

  /* ── Sample data ─────────────────────────────────────────────────────────
     In-memory only, never written, every record flagged _demo. Shaped like a
     real intake_projects document (nested `customer`, `quote.total`) so it
     also exercises the field-tolerance paths. */
  function sample() {
    var now = Date.now();
    function t(hr) { return new Date(now - hr * HOUR).toISOString(); }
    var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    var recentDone = Math.max(now - 60 * HOUR, monthStart.getTime() + 6 * HOUR);
    if (recentDone > now) recentDone = now - HOUR;
    function fd(hr) { return new Date(recentDone - hr * HOUR).toISOString(); }

    /* Built in the real intake_projects shape — nested customer/project,
       scope as {key:{enabled}}, deliverables as objects with `requested` —
       so the sample exercises the same mapping the live data does. Anything
       that renders here renders there. */
    function del(keys, doneKeys) {
      return SCOPE.map(function (s) {
        return { key:s.key, label:s.label,
                 requested: keys.indexOf(s.key) >= 0,
                 status: (doneKeys || []).indexOf(s.key) >= 0 ? 'delivered' : 'not_started',
                 outputUrl:'', note:'', updatedAt:null };
      });
    }
    function sc(map) {
      var out = {};
      TYPES.forEach(function (x) { out[x.key] = { enabled:false }; });
      for (var k in map) if (map.hasOwnProperty(k)) out[k] = map[k];
      return out;
    }

    var rows = [
      { orgId:'fenecon.com', tenantName:'FENECON', purpose:'service', routing:'omega',
        status:'submitted', submittedAt:t(3.4),
        customer:{ company:'FENECON', contactName:'Anna Bauer', email:'a.bauer@fenecon.com', role:'Developer' },
        project:{ name:'Munich DC — 4h BESS', city:'Garching', state:'DE',
                  notes:'Utility wants the one-line before their Thursday review.' },
        scope: sc({ bess:{ enabled:true, powerMw:12.5, energyMwh:50, useCase:'Peak shaving' } }),
        deliverables: del(['siteplan','loadstudy','costs']),
        quote:{ total:null, currency:'USD' }, admin:{ priority:'urgent', assignee:'' } },

      { orgId:'sunesol.com', tenantName:'SunESol', purpose:'service', routing:'omega',
        status:'submitted', submittedAt:t(26),
        customer:{ company:'SunESol', contactName:'Dana Ruiz', email:'dana@sunesol.com' },
        project:{ name:'Fresno depot — DCFC', city:'Fresno', state:'CA' },
        scope: sc({ dcfc:{ enabled:true, dispensers:6 } }),
        deliverables: del(['siteplan','sitemap','utility']),
        quote:{ total:null }, admin:{ priority:'normal' } },

      { orgId:'iqgen.energy', tenantName:'iQGen Technologies', purpose:'service', routing:'omega',
        status:'in_production', submittedAt:t(52), firstResponseAt:t(50.5), startedAt:t(46),
        customer:{ company:'iQGen Technologies', contactName:'Priya Raman', email:'priya@iqgen.energy' },
        project:{ name:'Odessa TX — solar + storage', city:'Odessa', state:'TX' },
        scope: sc({ solar:{ enabled:true, dcKw:40000 }, bess:{ enabled:true, powerMw:20, energyMwh:40 } }),
        deliverables: del(['siteplan','costs','loadstudy'], ['siteplan']),
        editorProjectId:'demo-proj-1', editorProjectName:'Odessa TX',
        quote:{ total:88000, currency:'USD' },
        admin:{ priority:'high', assignee:'tom@clearsky-usa.com', assigneeName:'Thomas' } },

      { orgId:'nextnrg.com', tenantName:'NextNRG', purpose:'service', routing:'omega',
        status:'quoted', submittedAt:t(140), firstResponseAt:t(133),
        customer:{ company:'NextNRG', contactName:'Marcus Hale', email:'marcus@nextnrg.com' },
        project:{ name:'Tampa microgrid screen', city:'Tampa', state:'FL' },
        scope: sc({ der:{ enabled:true, capacityKw:8000, islandMode:true } }),
        deliverables: del(['interconnect','costs']),
        quote:{ total:42000, currency:'USD', sentAt:t(133) },
        admin:{ priority:'normal', assignee:'tom@clearsky-usa.com', assigneeName:'Thomas' } },

      { orgId:'spatco.com', tenantName:'SPATCO', purpose:'build', routing:'self',
        status:'saved', submittedAt:null, createdAt:t(88),
        customer:{ company:'SPATCO', contactName:'Ellis Ward', email:'ellis@spatco.com' },
        project:{ name:'Charlotte yard — self serve', city:'Charlotte', state:'NC' },
        scope: sc({ l2:{ enabled:true, ports:8, kwPerPort:11.5 } }),
        deliverables: del([]), quote:{ total:null }, admin:{ priority:'normal' } },

      { orgId:'concordenergyusa.com', tenantName:'Concord Energy', purpose:'service', routing:'omega',
        status:'delivered', submittedAt:fd(240), firstResponseAt:fd(237.5), startedAt:fd(230),
        completedAt:new Date(recentDone).toISOString(),
        customer:{ company:'Concord Energy', contactName:'Dale Whitcomb', email:'dale@concordenergyusa.com' },
        project:{ name:'Cedar Rapids fleet depot', city:'Cedar Rapids', state:'IA' },
        scope: sc({ dcfc:{ enabled:true, dispensers:4 } }),
        deliverables: del(['siteplan','ahj'], ['siteplan','ahj']),
        editorProjectId:'demo-proj-2',
        quote:{ total:47000, currency:'USD', paymentStatus:'paid', paidAt:fd(4) },
        admin:{ priority:'high', assignee:'tom@clearsky-usa.com', assigneeName:'Thomas' } },

      { orgId:'sunesol.com', tenantName:'SunESol', purpose:'service', routing:'omega',
        status:'delivered', submittedAt:t(1100), firstResponseAt:t(1078), completedAt:t(820),
        commissionPaidAt:t(300),
        customer:{ company:'SunESol', contactName:'Dana Ruiz', email:'dana@sunesol.com' },
        project:{ name:'Bakersfield rooftop', city:'Bakersfield', state:'CA' },
        scope: sc({ solar:{ enabled:true, dcKw:2100 } }),
        deliverables: del(['costs'], ['costs']),
        quote:{ total:18500, currency:'USD' },
        admin:{ priority:'normal', assignee:'tom@clearsky-usa.com', assigneeName:'Thomas' } },

      { orgId:'fenecon.com', tenantName:'FENECON', purpose:'service', routing:'omega',
        status:'changes_requested', submittedAt:t(300), firstResponseAt:t(292),
        customer:{ company:'FENECON', contactName:'Jonas Mehl', email:'j.mehl@fenecon.de' },
        project:{ name:'Ulm C&I retrofit', city:'Ulm', state:'DE' },
        scope: sc({ bess:{ enabled:true, powerMw:1.4 } }),
        deliverables: del(['costs']),
        quote:{ total:12000, currency:'USD' },
        admin:{ priority:'normal', assignee:'tom@clearsky-usa.com', assigneeName:'Thomas',
                internalNotes:'Waiting on landlord roof-loading confirmation.' } },

      { orgId:'iqgen.energy', tenantName:'iQGen Technologies', purpose:'service', routing:'omega',
        status:'declined', submittedAt:t(700), firstResponseAt:t(690),
        customer:{ company:'iQGen Technologies', contactName:'Marcus Hale', email:'marcus@iqgen.energy' },
        project:{ name:'El Paso compute screen', city:'El Paso', state:'TX' },
        scope: sc({ compute:{ enabled:true, itLoadMw:75 } }),
        deliverables: del(['interconnect']),
        quote:{ total:60000, currency:'USD' }, admin:{ priority:'normal' } }
    ];

    var out = [];
    for (var i = 0; i < rows.length; i++) {
      rows[i]._demo = true;
      rows[i].intakeId = 'demo-' + (i + 1);
      out.push(normalize('demo-' + (i + 1), rows[i]));
    }
    out.sort(function (a, b) { return ms(b.submittedAt) - ms(a.submittedAt); });
    return out;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* Anything in the raw document the console didn't map, rendered in the
     drawer so a wrong field guess shows as visible data rather than a blank
     row nobody notices. */
  var KNOWN = ['intakeId','schemaVersion','orgId','tenantKey','tenantName','createdBy',
    'createdAt','updatedAt','submittedAt','completedAt','purpose','routing','status',
    'editorProjectId','editorProjectName','quote','acceptance','customer','project',
    'scope','links','categories','deliverables','activity','admin','notify',
    'firstResponseAt','startedAt','commissionRate','commissionPaidAt',
    'messages','payment','files','_demo'];

  function unmapped(req) {
    var raw = req._raw || {}, out = {}, n = 0;
    for (var k in raw) {
      if (!raw.hasOwnProperty(k)) continue;
      if (KNOWN.indexOf(k) >= 0) continue;
      out[k] = raw[k]; n++;
    }
    return n ? out : null;
  }

  global.OpsData = {
    STATUS:STATUS, PRIORITY:PRIORITY, SCOPE:SCOPE, TYPES:TYPES, PURPOSE:PURPOSE,
    statusOf:statusOf, priorityOf:priorityOf, labelFor:labelFor,
    tenantName:tenantName, isInternalOrg:isInternalOrg, orgs:orgs,
    ms:ms, fmtDate:fmtDate, fmtDateTime:fmtDateTime, fmtDur:fmtDur,
    fmtAgo:fmtAgo, fmtMoney:fmtMoney, esc:esc,
    targetMs:targetMs, responseMs:responseMs, answered:answered, clock:clock,
    value:value, rate:rate, payout:payout, payableStatus:payableStatus,
    isEarned:isEarned, isPaid:isPaid, dueMs:dueMs, cycleMs:cycleMs,
    inQueue:inQueue, isBlocked:isBlocked, pick:pick, unmapped:unmapped,
    QUOTE_TIERS:QUOTE_TIERS, quotePayload:quotePayload, messagePayload:messagePayload,
    deliverablesPayload:deliverablesPayload, serverStamp:serverStamp,
    uploadFile:uploadFile, fileUrl:fileUrl, removeFile:removeFile, filesFor:filesFor,
    fmtBytes:fmtBytes, MAX_FILE_MB:MAX_FILE_MB,
    enabledScopes:enabledScopes, deliverableProgress:deliverableProgress,
    priorityKey:priorityKey,
    normalize:normalize, init:init, collectionName:collectionName,
    loadRequests:loadRequests, loadOrgs:loadOrgs,
    patch:patch, createLinkedProject:createLinkedProject,
    summarize:summarize, byTenant:byTenant, byStaff:byStaff, sample:sample
  };
})(window);

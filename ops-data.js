/* ═══════════════════════════════════════════════════════════════════════════════
   ClearSky-OMEGA · Ops Data Layer
   © 2026 ClearSky Energy Solutions LLC. Proprietary and Confidential.

   INTERNAL REPO ONLY. Not shared with tenant deployments.

   One place for everything the ops console and the intake form both need to
   agree on: what the statuses are, how a response time is measured, what a
   payout is worth, and how a request document is shaped in Firestore.

   Both pages import this. If they disagreed about any of it — say, one counted
   `delivered` as payable and the other didn't — the queue and the earnings
   view would quietly report different numbers from the same data, which is the
   worst kind of bug to find.

   ─────────────────────────────────────────────────────────────────────────────
   COLLECTION: intake_requests
   ─────────────────────────────────────────────────────────────────────────────
   {
     orgId          'fenecon.com'        the CLIENT's org — who asked
     clientName     'FENECON'
     contactName    'Anna Bauer'
     contactEmail   'anna@fenecon.com'
     contactPhone   '+49 …'

     projectName    'Munich DC — 4h BESS'
     projectType    'bess' | 'solar+bess' | 'ev' | 'microgrid' | 'other'
     address        '…'
     capacityMw     12.5
     durationHrs    4
     scope          ['sitemap','oneline','proforma','proposal','permit']
     notes          free text from the client

     priority       'standard' | 'rush' | 'critical'
     dueDate        'YYYY-MM-DD'  (optional — client's own deadline)
     value          48000         contract value, USD
     commissionRate 0.05          overrides ops.defaultCommissionRate

     status         see STATUS below
     assignedTo     'tom@clearsky-usa.com'
     assignedName   'Thomas'
     projectId      linked doc in `projects` — what the editor opens

     submittedAt      Timestamp   set on create
     firstResponseAt  Timestamp   set once, on first acknowledgement
     startedAt        Timestamp
     deliveredAt      Timestamp
     completedAt      Timestamp   ← the one that makes commission payable
     paidAt           Timestamp   ← set by payroll, never by this console

     activity       [{ at, by, byName, type, text }]
   }
   ═══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var HOUR = 3600000, DAY = 86400000;

  /* ── Status model ────────────────────────────────────────────────────────
     `pipeline: true` means the status is a column on the board and a step in
     the normal flow. on_hold and cancelled are real states but not steps, so
     they sit outside it and are excluded from cycle-time averages. */
  var STATUS = [
    { key:'new',          label:'New',            short:'New',       color:'#0070F2', pipeline:true,
      hint:'Submitted. Nobody has replied yet — the response clock is running.' },
    { key:'acknowledged', label:'Acknowledged',   short:'Ack',       color:'#8B5CF6', pipeline:true,
      hint:'A human has replied. Response time is locked in.' },
    { key:'in_progress',  label:'In progress',    short:'Working',   color:'#00A9A4', pipeline:true,
      hint:'Being built. Linked to a project in the editor.' },
    { key:'review',       label:'Internal review',short:'Review',    color:'#D97706', pipeline:true,
      hint:'Work is done, checking it before the client sees it.' },
    { key:'delivered',    label:'Delivered',      short:'Delivered', color:'#2563EB', pipeline:true,
      hint:'Sent to the client. Waiting on their sign-off.' },
    { key:'completed',    label:'Completed',      short:'Done',      color:'#16A34A', pipeline:true,
      hint:'Client signed off. Commission is payable.' },
    { key:'on_hold',      label:'On hold',        short:'Hold',      color:'#6B7280', pipeline:false,
      hint:'Blocked on the client or on something outside the queue.' },
    { key:'cancelled',    label:'Cancelled',      short:'Cancelled', color:'#9CA3AF', pipeline:false,
      hint:'Withdrawn or dropped. No commission.' }
  ];

  var PRIORITY = [
    { key:'critical', label:'Critical', color:'#DC2626' },
    { key:'rush',     label:'Rush',     color:'#D97706' },
    { key:'standard', label:'Standard', color:'#556B82' }
  ];

  var SCOPE = [
    { key:'sitemap',   label:'Site map / layout' },
    { key:'oneline',   label:'One-line diagram' },
    { key:'sizing',    label:'Battery sizing' },
    { key:'proforma',  label:'Pro forma / financials' },
    { key:'proposal',  label:'Sales proposal' },
    { key:'permit',    label:'Permit-ready export' },
    { key:'intercon',  label:'Interconnection screen' },
    { key:'other',     label:'Something else (see notes)' }
  ];

  var TYPES = [
    { key:'bess',       label:'Standalone BESS' },
    { key:'solar+bess', label:'Solar + storage' },
    { key:'ev',         label:'EV charging' },
    { key:'microgrid',  label:'Microgrid' },
    { key:'datacenter', label:'Data center' },
    { key:'other',      label:'Other' }
  ];

  function statusOf(key) {
    for (var i = 0; i < STATUS.length; i++) if (STATUS[i].key === key) return STATUS[i];
    return STATUS[0];
  }
  function priorityOf(key) {
    for (var i = 0; i < PRIORITY.length; i++) if (PRIORITY[i].key === key) return PRIORITY[i];
    return PRIORITY[2];
  }
  function labelFor(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].label;
    return key || '—';
  }

  /* ── Config accessors ───────────────────────────────────────────────────── */

  function cfg()    { return (global.CLEARSKY_CONFIG || {}); }
  function ops()    { return cfg().ops || {}; }
  function slaCfg() { return ops().sla || { critical:2, rush:8, standard:24 }; }

  /* Tenant display name: config list first, then whatever the request itself
     recorded, then the bare domain. A tenant that onboarded after this repo
     was last edited still renders with a real name from its own documents. */
  function tenantName(orgId, requests) {
    var list = ops().tenants || [], i;
    for (i = 0; i < list.length; i++) if (list[i].orgId === orgId) return list[i].name;
    if (requests) {
      for (i = 0; i < requests.length; i++) {
        if (requests[i].orgId === orgId && requests[i].clientName) return requests[i].clientName;
      }
    }
    return orgId || 'Unknown';
  }

  /* ── Time ────────────────────────────────────────────────────────────────
     Firestore hands back Timestamps; the sample data and anything written
     offline hands back Date or ISO strings. Everything downstream wants a
     number, so funnel all of it through here. */
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
    var d = new Date(t);
    return fmtDate(t) + ' · ' + d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  }

  /* Compact duration. Sub-hour precision matters here — the difference
     between a 12-minute and a 50-minute reply is the whole point of the
     dashboard, and "1h" for both would hide it. */
  function fmtDur(msVal) {
    if (msVal == null || isNaN(msVal)) return '—';
    var neg = msVal < 0;
    var v = Math.abs(msVal);
    var out;

    /* Round FIRST, then pick the unit. Doing it the other way round produces
       "60m" for 59.98 minutes and "24h" for 23.99 hours — both technically
       true and both wrong on a dashboard, because they read as a unit the
       reader has to convert in their head. */
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
    var v = Number(n) || 0;
    var compact = opts && opts.compact;
    try {
      return v.toLocaleString('en-US', {
        style:'currency', currency: ops().currency || 'USD',
        maximumFractionDigits: (compact && Math.abs(v) >= 1000) ? 0 : (v % 1 ? 2 : 0),
        notation: (compact && Math.abs(v) >= 100000) ? 'compact' : 'standard'
      });
    } catch (e) { return '$' + Math.round(v).toLocaleString(); }
  }

  /* ── SLA / response time ─────────────────────────────────────────────────
     target(req)      how long this request had, in ms
     responseMs(req)  how long it actually took, or null if still waiting
     clock(req)       everything the UI needs to draw the countdown

     Note that `elapsed` keeps counting after the target is blown, so a badly
     missed request keeps getting worse on screen instead of parking at 100%.
     That's intentional: a 3-hour miss and a 3-day miss should not look alike. */
  function targetMs(req) {
    var hours = slaCfg()[req.priority] || slaCfg().standard || 24;
    return hours * HOUR;
  }

  function responseMs(req) {
    var s = ms(req.submittedAt), f = ms(req.firstResponseAt);
    if (!s || !f) return null;
    return Math.max(0, f - s);
  }

  /* Has anyone replied yet? Explicit stamp wins; anything past `new` counts
     as replied even on an older document written before the stamp existed. */
  function answered(req) {
    if (ms(req.firstResponseAt)) return true;
    return req.status && req.status !== 'new';
  }

  function clock(req, now) {
    now = now || Date.now();
    var t = targetMs(req);
    var sub = ms(req.submittedAt);
    var done = responseMs(req);
    var elapsed = (done != null) ? done : (sub ? Math.max(0, now - sub) : 0);
    var frac = t ? (elapsed / t) : 0;
    var warn = (ops().warnAt != null) ? ops().warnAt : 0.6;

    var state = 'ok';
    if (frac >= 1) state = 'breach';
    else if (frac >= warn) state = 'warn';

    return {
      target:    t,
      elapsed:   elapsed,
      remaining: t - elapsed,        // negative once blown
      frac:      frac,
      pct:       Math.min(100, Math.round(frac * 100)),
      state:     state,
      settled:   done != null,       // true = historical, stop ticking it
      answered:  answered(req)
    };
  }

  /* ── Payouts ─────────────────────────────────────────────────────────────
     Earned on completion and nothing earlier. Delivered-but-unsigned is the
     tempting one to count and the wrong one: the client can still come back
     with changes, and a rep watching a number that later drops is worse than
     one watching a number that only ever goes up. */
  function rate(req) {
    var r = req.commissionRate;
    if (r == null || isNaN(r)) r = ops().defaultCommissionRate;
    if (r == null || isNaN(r)) r = 0.05;
    return Number(r);
  }

  function payout(req) { return (Number(req.value) || 0) * rate(req); }
  function isEarned(req) { return req.status === 'completed' && !!ms(req.completedAt); }
  function isPaid(req)   { return isEarned(req) && !!ms(req.paidAt); }

  /* ── Delivery due date ───────────────────────────────────────────────────
     The client's own dueDate wins when they gave one. Otherwise derive from
     the acknowledgement, not from submission — the clock on doing the work
     shouldn't start before anyone has picked it up. */
  function dueMs(req) {
    if (req.dueDate) { var p = Date.parse(String(req.dueDate) + 'T23:59:59'); if (!isNaN(p)) return p; }
    var base = ms(req.firstResponseAt) || ms(req.submittedAt);
    if (!base) return 0;
    var d = (ops().deliveryDays || {})[req.priority];
    if (d == null) d = (ops().deliveryDays || {}).standard || 14;
    return base + d * DAY;
  }

  /* Cycle time: acknowledgement → delivery. What a client experiences as
     "how long did it take", once someone was actually on it. */
  function cycleMs(req) {
    var a = ms(req.firstResponseAt) || ms(req.submittedAt);
    var d = ms(req.deliveredAt) || ms(req.completedAt);
    if (!a || !d) return null;
    return Math.max(0, d - a);
  }

  /* ── Normalisation ───────────────────────────────────────────────────────
     Give every consumer the same shape regardless of how old the document is
     or which page wrote it. Defaults here rather than at each call site. */
  function normalize(id, d) {
    d = d || {};
    return {
      id:             id,
      orgId:          d.orgId || '',
      clientName:     d.clientName || '',
      contactName:    d.contactName || '',
      contactEmail:   d.contactEmail || '',
      contactPhone:   d.contactPhone || '',
      projectName:    d.projectName || 'Untitled request',
      projectType:    d.projectType || 'bess',
      address:        d.address || '',
      capacityMw:     d.capacityMw != null ? d.capacityMw : '',
      durationHrs:    d.durationHrs != null ? d.durationHrs : '',
      scope:          Array.isArray(d.scope) ? d.scope : [],
      notes:          d.notes || '',
      priority:       d.priority || 'standard',
      dueDate:        d.dueDate || '',
      value:          Number(d.value) || 0,
      commissionRate: d.commissionRate,
      status:         d.status || 'new',
      assignedTo:     (d.assignedTo || '').toLowerCase(),
      assignedName:   d.assignedName || '',
      projectId:      d.projectId || '',
      deliveryNote:   d.deliveryNote || '',
      submittedAt:    d.submittedAt || null,
      firstResponseAt:d.firstResponseAt || null,
      startedAt:      d.startedAt || null,
      deliveredAt:    d.deliveredAt || null,
      completedAt:    d.completedAt || null,
      paidAt:         d.paidAt || null,
      activity:       Array.isArray(d.activity) ? d.activity.slice() : [],
      _demo:          !!d._demo
    };
  }

  /* ── Firestore ──────────────────────────────────────────────────────────── */

  var _db = null, _me = { email:'', name:'' };

  function init(db, me) {
    _db = db || null;
    if (me) _me = { email: (me.email||'').toLowerCase(), name: me.name || '' };
  }

  function stamp() {
    try { return firebase.firestore.FieldValue.serverTimestamp(); }
    catch (e) { return new Date(); }
  }

  /* Read the whole queue. No composite index needed — one where-less get and
     a client-side sort, same approach projects.html uses. If this ever grows
     past a few thousand documents, add a `where('status','!=','completed')`
     for the board views and page the archive separately. */
  function loadRequests() {
    if (!_db) return Promise.reject(new Error('No database connection.'));
    return _db.collection('intake_requests').get().then(function (snap) {
      var out = [];
      snap.forEach(function (doc) { out.push(normalize(doc.id, doc.data())); });
      out.sort(function (a, b) { return ms(b.submittedAt) - ms(a.submittedAt); });
      return out;
    });
  }

  /* Activity entries live in an array, and Firestore refuses a
     serverTimestamp() inside array elements — so these carry a client clock.
     Fine for a readable log; never use activity[].at for SLA math. The
     top-level *At fields are server-stamped and are what the numbers use. */
  function entry(type, text) {
    return {
      at:     new Date().toISOString(),
      by:     _me.email || 'system',
      byName: _me.name || _me.email || 'System',
      type:   type,
      text:   text || ''
    };
  }

  function patch(id, fields, note) {
    if (!_db) return Promise.reject(new Error('No database connection.'));
    var body = {};
    for (var k in fields) if (fields.hasOwnProperty(k)) body[k] = fields[k];
    body.updatedAt = stamp();
    if (note) {
      try { body.activity = firebase.firestore.FieldValue.arrayUnion(entry(note.type, note.text)); }
      catch (e) { /* arrayUnion unavailable: skip the log rather than fail the write */ }
    }
    return _db.collection('intake_requests').doc(id).update(body);
  }

  function create(doc) {
    if (!_db) return Promise.reject(new Error('No database connection.'));
    var body = normalize(null, doc);
    delete body.id;
    delete body._demo;
    body.status      = 'new';
    body.submittedAt = stamp();
    body.updatedAt   = stamp();
    body.activity    = [entry('created', 'Request submitted')];
    return _db.collection('intake_requests').add(body);
  }

  /* Create the editor-side project for a request and link the two.

     The project is stamped with the CLIENT's orgId, not ClearSky's. That is
     the whole point: when the work is finished the client already sees it in
     their own portal under their own tenant, with no export/import step. It
     also means Firestore rules must let staff write outside their own org —
     see README § "Firestore rules". */
  function createLinkedProject(req) {
    if (!_db) return Promise.reject(new Error('No database connection.'));
    var user = null;
    try { user = firebase.auth().currentUser; } catch (e) {}
    return _db.collection('projects').add({
      uid:        user ? user.uid : null,
      orgId:      req.orgId,                       // ← the client's tenant
      ownerEmail: (_me.email || '').toLowerCase(), // the staff member building it
      ownerName:  _me.name || _me.email || '',
      name:       req.projectName || 'Untitled',
      address:    req.address || '',
      type:       (req.projectType === 'ev') ? 'EV' : 'BESS',
      client:     req.clientName || '',
      stage:      'candidate',
      intakeId:   req.id,                          // back-reference to the request
      createdAt:  stamp(),
      updatedAt:  stamp(),
      elements: [], conduits: [], bessList: [], annotations: []
    });
  }

  /* ── Roll-ups ────────────────────────────────────────────────────────────
     Averages skip cancelled work and anything still unanswered, so a request
     nobody has touched can't flatter the average by contributing nothing. */
  function summarize(reqs, opts) {
    opts = opts || {};
    var now = Date.now();
    var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    var weekAgo = now - 7 * DAY;

    var s = {
      total:0, open:0, awaitingResponse:0, breached:0, working:0, review:0,
      delivered:0, completed:0, completedThisMonth:0, onHold:0,
      valueOpen:0, valueCompleted:0,
      earnedThisMonth:0, earnedPending:0, earnedPaid:0, earnedAll:0,
      respAvg:null, respAvg7d:null, respBest:null, respWorst:null,
      cycleAvg:null, slaHitRate:null,
      oldestUnanswered:null
    };

    var respAll = [], resp7 = [], cyc = [], slaOk = 0, slaCount = 0;

    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      if (opts.mine && r.assignedTo !== opts.mine) continue;
      if (r.status === 'cancelled') { s.total++; continue; }
      s.total++;

      var isOpen = (r.status !== 'completed');
      if (isOpen) { s.open++; s.valueOpen += (Number(r.value) || 0); }

      if (r.status === 'new')          s.awaitingResponse++;
      if (r.status === 'in_progress')  s.working++;
      if (r.status === 'review')       s.review++;
      if (r.status === 'delivered')    s.delivered++;
      if (r.status === 'on_hold')      s.onHold++;

      var c = clock(r, now);
      if (c.state === 'breach' && !c.answered) s.breached++;

      if (!c.answered && ms(r.submittedAt)) {
        if (!s.oldestUnanswered || ms(r.submittedAt) < ms(s.oldestUnanswered.submittedAt)) {
          s.oldestUnanswered = r;
        }
      }

      var rm = responseMs(r);
      if (rm != null) {
        respAll.push(rm);
        if (ms(r.firstResponseAt) >= weekAgo) resp7.push(rm);
        if (s.respBest  == null || rm < s.respBest)  s.respBest  = rm;
        if (s.respWorst == null || rm > s.respWorst) s.respWorst = rm;
        slaCount++;
        if (rm <= targetMs(r)) slaOk++;
      }

      var cm = cycleMs(r);
      if (cm != null) cyc.push(cm);

      if (r.status === 'completed') {
        s.completed++;
        s.valueCompleted += (Number(r.value) || 0);
        var p = payout(r);
        s.earnedAll += p;
        if (isPaid(r)) s.earnedPaid += p; else s.earnedPending += p;
        if (ms(r.completedAt) >= monthStart.getTime()) {
          s.completedThisMonth++;
          s.earnedThisMonth += p;
        }
      }
    }

    function avg(a) {
      if (!a.length) return null;
      var t = 0; for (var i = 0; i < a.length; i++) t += a[i];
      return t / a.length;
    }
    s.respAvg    = avg(respAll);
    s.respAvg7d  = avg(resp7);
    s.cycleAvg   = avg(cyc);
    s.slaHitRate = slaCount ? (slaOk / slaCount) : null;
    s.respCount  = respAll.length;

    return s;
  }

  /* Per-tenant roll-up for the CRM view. Tenants named in config appear even
     with zero requests, so a newly onboarded client reads as "nothing yet"
     rather than being invisible. */
  function byTenant(reqs) {
    var map = {}, i, r;

    var listed = ops().tenants || [];
    for (i = 0; i < listed.length; i++) {
      map[listed[i].orgId] = { orgId: listed[i].orgId, name: listed[i].name, requests: [] };
    }
    for (i = 0; i < reqs.length; i++) {
      r = reqs[i];
      if (!r.orgId) continue;
      if (!map[r.orgId]) map[r.orgId] = { orgId: r.orgId, name: r.clientName || r.orgId, requests: [] };
      if (!map[r.orgId].name && r.clientName) map[r.orgId].name = r.clientName;
      map[r.orgId].requests.push(r);
    }

    var out = [];
    for (var k in map) {
      if (!map.hasOwnProperty(k)) continue;
      var t = map[k];
      t.stats = summarize(t.requests);
      t.lastActivity = 0;
      for (i = 0; i < t.requests.length; i++) {
        var when = Math.max(ms(t.requests[i].submittedAt), ms(t.requests[i].completedAt),
                            ms(t.requests[i].deliveredAt));
        if (when > t.lastActivity) t.lastActivity = when;
      }
      out.push(t);
    }
    out.sort(function (a, b) { return b.lastActivity - a.lastActivity; });
    return out;
  }

  /* Per-person roll-up for Earnings. */
  function byStaff(reqs) {
    var map = {};
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      var who = r.assignedTo || '';
      if (!who) continue;
      if (!map[who]) map[who] = { email: who, name: r.assignedName || who.split('@')[0], requests: [] };
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
     In-memory only. Nothing here is ever written to Firestore, and every
     record carries _demo so the UI can keep saying so. It exists so the
     console can be demoed and the layout checked before the first real
     submission lands — an empty ops board tells you nothing about whether
     the SLA colours or the payout maths are right. */
  function sample() {
    var now = Date.now();
    function t(hoursAgo) { return new Date(now - hoursAgo * HOUR).toISOString(); }

    /* "Completed this month" is one of the headline numbers, and a demo that
       always shows zero for it teaches you nothing about whether it works.
       Pin one completion inside the current month whatever today's date is —
       on the 1st, a plain "60 hours ago" would land in the previous month. */
    var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    var recentDone = Math.max(now - 60 * HOUR, monthStart.getTime() + 6 * HOUR);
    if (recentDone > now) recentDone = now - HOUR;
    function fromDone(hoursBefore) { return new Date(recentDone - hoursBefore * HOUR).toISOString(); }
    var rows = [
      { orgId:'fenecon.com', clientName:'FENECON', contactName:'Anna Bauer',
        contactEmail:'a.bauer@fenecon.com', projectName:'Munich DC — 4h BESS',
        projectType:'bess', address:'Garching bei München, DE', capacityMw:12.5, durationHrs:4,
        scope:['sitemap','oneline','proforma'], priority:'critical', value:64000,
        status:'new', submittedAt:t(3.4), notes:'Utility wants the one-line before their Thursday review.' },

      { orgId:'iqgen.energy', clientName:'iQGen Technologies', contactName:'Priya Raman',
        contactEmail:'priya@iqgen.energy', projectName:'Odessa TX — solar + storage',
        projectType:'solar+bess', address:'Odessa, TX', capacityMw:40, durationHrs:2,
        scope:['sitemap','proforma','proposal'], priority:'rush', value:88000,
        status:'in_progress', assignedTo:'tom@clearsky-usa.com', assignedName:'Thomas',
        submittedAt:t(52), firstResponseAt:t(50.5), startedAt:t(46) },

      { orgId:'concordenergyusa.com', clientName:'Concord Energy', contactName:'Dale Whitcomb',
        contactEmail:'dale@concordenergyusa.com', projectName:'Cedar Rapids fleet depot',
        projectType:'ev', address:'Cedar Rapids, IA', capacityMw:3.2, durationHrs:'',
        scope:['sitemap','permit'], priority:'standard', value:31000,
        status:'review', assignedTo:'tom@clearsky-usa.com', assignedName:'Thomas',
        submittedAt:t(140), firstResponseAt:t(133), startedAt:t(120) },

      { orgId:'fenecon.com', clientName:'FENECON', contactName:'Jonas Mehl',
        contactEmail:'j.mehl@fenecon.de', projectName:'Hamburg port microgrid',
        projectType:'microgrid', address:'Hamburg, DE', capacityMw:8, durationHrs:6,
        scope:['sitemap','oneline','intercon'], priority:'standard', value:52000,
        status:'delivered', assignedTo:'tom@clearsky-usa.com', assignedName:'Thomas',
        submittedAt:t(330), firstResponseAt:t(322), startedAt:t(300), deliveredAt:t(40),
        deliveryNote:'Site map + one-line issued. Interconnection screen to follow.' },

      { orgId:'iqgen.energy', clientName:'iQGen Technologies', contactName:'Priya Raman',
        contactEmail:'priya@iqgen.energy', projectName:'Lubbock substation adjacency',
        projectType:'bess', address:'Lubbock, TX', capacityMw:20, durationHrs:4,
        scope:['sitemap','proforma'], priority:'rush', value:47000,
        status:'completed', assignedTo:'tom@clearsky-usa.com', assignedName:'Thomas',
        submittedAt:fromDone(240), firstResponseAt:fromDone(237.5), startedAt:fromDone(230),
        deliveredAt:fromDone(30), completedAt:new Date(recentDone).toISOString() },

      { orgId:'concordenergyusa.com', clientName:'Concord Energy', contactName:'Dale Whitcomb',
        contactEmail:'dale@concordenergyusa.com', projectName:'Ankeny warehouse rooftop',
        projectType:'solar+bess', address:'Ankeny, IA', capacityMw:2.1, durationHrs:2,
        scope:['proposal'], priority:'standard', value:18500,
        status:'completed', assignedTo:'tom@clearsky-usa.com', assignedName:'Thomas',
        submittedAt:t(1100), firstResponseAt:t(1078), startedAt:t(1050),
        deliveredAt:t(820), completedAt:t(800), paidAt:t(300) },

      { orgId:'fenecon.com', clientName:'FENECON', contactName:'Anna Bauer',
        contactEmail:'a.bauer@fenecon.com', projectName:'Ulm C&I retrofit',
        projectType:'bess', address:'Ulm, DE', capacityMw:1.4, durationHrs:2,
        scope:['sizing','proposal'], priority:'standard', value:12000,
        status:'on_hold', assignedTo:'tom@clearsky-usa.com', assignedName:'Thomas',
        submittedAt:t(500), firstResponseAt:t(492),
        notes:'Client pausing until their landlord confirms roof loading.' },

      { orgId:'iqgen.energy', clientName:'iQGen Technologies', contactName:'Marcus Hale',
        contactEmail:'marcus@iqgen.energy', projectName:'El Paso data center screen',
        projectType:'datacenter', address:'El Paso, TX', capacityMw:75, durationHrs:'',
        scope:['intercon','proforma'], priority:'standard', value:0,
        status:'new', submittedAt:t(26), notes:'Early look — no budget approved yet.' }
    ];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      rows[i]._demo = true;
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

  global.OpsData = {
    STATUS: STATUS, PRIORITY: PRIORITY, SCOPE: SCOPE, TYPES: TYPES,
    statusOf: statusOf, priorityOf: priorityOf, labelFor: labelFor,
    tenantName: tenantName,
    ms: ms, fmtDate: fmtDate, fmtDateTime: fmtDateTime, fmtDur: fmtDur,
    fmtAgo: fmtAgo, fmtMoney: fmtMoney, esc: esc,
    targetMs: targetMs, responseMs: responseMs, answered: answered, clock: clock,
    rate: rate, payout: payout, isEarned: isEarned, isPaid: isPaid,
    dueMs: dueMs, cycleMs: cycleMs,
    normalize: normalize, init: init, loadRequests: loadRequests,
    patch: patch, create: create, createLinkedProject: createLinkedProject,
    summarize: summarize, byTenant: byTenant, byStaff: byStaff,
    sample: sample
  };
})(window);

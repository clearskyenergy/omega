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
    { key:'draft',        label:'Draft',         short:'Draft',    color:'#9CA3AF', pipeline:false, pre:true,
      hint:'The client is still filling this in. Not submitted.' },
    { key:'saved',        label:'Saved',         short:'Saved',    color:'#9CA3AF', pipeline:false, pre:true,
      hint:'Saved but not sent. Not in the queue yet.' },
    { key:'submitted',    label:'Submitted',     short:'New',      color:'#0070F2', pipeline:true,
      hint:'In. Nobody has replied yet — the response clock is running.' },
    { key:'quoted',       label:'Quoted',        short:'Quoted',   color:'#8B5CF6', pipeline:true,
      hint:'Priced and sent back. Waiting on the client to accept.' },
    { key:'accepted',     label:'Accepted',      short:'Accepted', color:'#0EA5E9', pipeline:true,
      hint:'Client accepted the fee. Ready to build.' },
    { key:'in_production',label:'In production', short:'Building', color:'#00A9A4', pipeline:true,
      hint:'Being built. Linked to a project in the editor.' },
    { key:'delivered',    label:'Delivered',     short:'Delivered',color:'#16A34A', pipeline:true,
      hint:'Package issued. Commission is payable.' },
    { key:'declined',     label:'Declined',      short:'Declined', color:'#DC2626', pipeline:false,
      hint:'Client declined the quote. No commission.' }
  ];

  /* A 'build' intake is the client opening their own project, no fee. Real,
     but not OUR work and it never pays, so it stays out of the delivery
     queue by default. Set ops.serviceOnly:false to include it. */
  var PURPOSE = {
    service: { label:'Omega builds it',   billable:true  },
    build:   { label:'Client self-serve', billable:false }
  };

  var TYPES = [
    { key:'l2',         label:'L2 charging' },
    { key:'dcfc',       label:'DC fast charging' },
    { key:'bess',       label:'Standalone BESS' },
    { key:'der',        label:'DER' },
    { key:'solar',      label:'Solar' },
    { key:'solar+bess', label:'Solar + storage' },
    { key:'microgrid',  label:'Microgrid' },
    { key:'compute',    label:'Compute / data center' },
    { key:'other',      label:'Other' }
  ];

  /* Mirrors the deliverables ledger on the intake form. */
  var SCOPE = [
    { key:'plot',     label:'Project plot & site plan' },
    { key:'sitemap',  label:'Site map' },
    { key:'cost',     label:'Cost estimate & BOM' },
    { key:'oneline',  label:'Load study & one-line' },
    { key:'utility',  label:'Utility submission package' },
    { key:'intercon', label:'Interconnection application' },
    { key:'ahj',      label:'AHJ permit package' }
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
  function priorityOf(key) {
    for (var i = 0; i < PRIORITY.length; i++) if (PRIORITY[i].key === key) return PRIORITY[i];
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

  /* Scope may arrive as an array of keys, an array of objects, or a map of
     key → boolean. Normalise all three to an array of keys. */
  function pickScope(doc) {
    var v = pick(doc, ['scope','scopes','deliverables','ledger','packages'], null);
    if (!v) return [];
    if (Array.isArray(v)) {
      return v.map(function (x) {
        if (typeof x === 'string') return x;
        return (x && (x.key || x.id || x.name)) || '';
      }).filter(Boolean);
    }
    if (typeof v === 'object') {
      var out = [];
      for (var k in v) if (v.hasOwnProperty(k) && v[k]) out.push(k);
      return out;
    }
    return [];
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
    return Number(pick(req._raw || {},
      ['quote.total','quote.amount','quote.fee','quote.price','value','price'], 0)) || 0;
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
    var purpose = pick(d, ['purpose','mode','path'], 'service');
    return {
      id:            id,
      orgId:         String(pick(d, ['orgId','org','tenant'], '')).toLowerCase(),
      purpose:       purpose,
      billable:      (PURPOSE[purpose] || PURPOSE.service).billable,

      clientName:    pick(d, ['clientName','customer.company','customer.name','company','customer.org'], ''),
      contactName:   pick(d, ['contactName','customer.contact','customer.primaryContact',
                              'customer.contactName','contact.name','primaryContact'], ''),
      contactEmail:  pick(d, ['contactEmail','customer.email','contact.email','email','createdBy.email'], ''),
      contactPhone:  pick(d, ['contactPhone','customer.phone','contact.phone','phone'], ''),
      contactRole:   pick(d, ['customer.role','contact.role','role'], ''),

      projectName:   pick(d, ['projectName','name','project.name','site.name','title','customer.company'],
                          'Untitled intake'),
      projectType:   String(pick(d, ['projectType','type','site.type','scopeType','assetType'], '')).toLowerCase(),
      address:       pick(d, ['address','site.address','siteAddress','site.city',
                              'customer.billing.street','location'], ''),
      capacityMw:    pick(d, ['capacityMw','powerMw','site.powerMw','power.mw'], ''),
      durationHrs:   pick(d, ['durationHrs','durationHours','site.durationHrs'], ''),
      scope:         pickScope(d),
      notes:         pick(d, ['notes','note','customer.notes','site.notes'], ''),

      priority:      pick(d, ['priority','admin.priority','urgency'], 'standard'),
      dueDate:       pick(d, ['dueDate','admin.dueDate','deadline'], ''),
      commissionRate: d.commissionRate,

      status:        pick(d, ['status'], 'submitted'),
      assignedTo:    String(pick(d, ['assignedTo','admin.assignee','admin.assignedTo'], '')).toLowerCase(),
      assignedName:  pick(d, ['assignedName','admin.assigneeName'], ''),
      projectId:     pick(d, ['projectId','admin.projectId','linkedProjectId'], ''),
      internalNotes: pick(d, ['admin.internalNotes','internalNotes'], ''),

      submittedAt:     pick(d, ['submittedAt','submitted.at','createdAt','updatedAt'], null),
      firstResponseAt: pick(d, ['firstResponseAt','admin.firstResponseAt'], null),
      startedAt:       pick(d, ['startedAt','admin.startedAt'], null),
      deliveredAt:     pick(d, ['deliveredAt','admin.deliveredAt'], null),
      paidAt:          pick(d, ['paidAt','admin.paidAt'], null),

      activity:      Array.isArray(d.activity) ? d.activity.slice() : [],
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
  function stamp() {
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

  function entry(type, text) {
    return { at:new Date().toISOString(), by:_me.email || 'system',
             byName:_me.name || _me.email || 'System', type:type, text:text || '' };
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
     the CLIENT's orgId so the finished work is already in their portal. */
  function createLinkedProject(req) {
    if (!_db) return Promise.reject(new Error('No database connection.'));
    var user = null;
    try { user = firebase.auth().currentUser; } catch (e) {}
    var t = String(req.projectType || '').toLowerCase();
    return _db.collection('projects').add({
      uid:        user ? user.uid : null,
      orgId:      req.orgId,
      ownerEmail: (_me.email || '').toLowerCase(),
      ownerName:  _me.name || _me.email || '',
      name:       req.projectName || 'Untitled',
      address:    req.address || '',
      type:       (t === 'l2' || t === 'dcfc' || t === 'ev') ? 'EV' : 'BESS',
      client:     req.clientName || '',
      stage:      'candidate',
      intakeId:   req.id,
      createdAt:  stamp(),
      updatedAt:  stamp(),
      elements: [], conduits: [], bessList: [], annotations: []
    });
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

  function summarize(reqs, opts) {
    opts = opts || {};
    var now = Date.now();
    var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    var weekAgo = now - 7 * DAY;
    var pay = payableStatus();

    var s = {
      total:0, open:0, awaitingResponse:0, breached:0, quoted:0, accepted:0,
      working:0, delivered:0, declined:0, drafts:0, selfServe:0,
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

      if (r.status === 'submitted')     s.awaitingResponse++;
      if (r.status === 'quoted')        s.quoted++;
      if (r.status === 'accepted')      s.accepted++;
      if (r.status === 'in_production') s.working++;
      if (r.status === 'delivered')     s.delivered++;

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
    function t(h) { return new Date(now - h * HOUR).toISOString(); }
    var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    var recentDone = Math.max(now - 60 * HOUR, monthStart.getTime() + 6 * HOUR);
    if (recentDone > now) recentDone = now - HOUR;
    function fd(h) { return new Date(recentDone - h * HOUR).toISOString(); }

    var rows = [
      { orgId:'fenecon.com', purpose:'service', status:'submitted', priority:'critical',
        customer:{ company:'FENECON', contact:'Anna Bauer', email:'a.bauer@fenecon.com' },
        projectName:'Munich DC — 4h BESS', type:'bess', site:{ address:'Garching, DE' },
        scope:['plot','oneline','cost'], submittedAt:t(3.4),
        notes:'Utility wants the one-line before their Thursday review.' },

      { orgId:'sunesol.com', purpose:'service', status:'submitted', priority:'standard',
        customer:{ company:'SunESol', contact:'Dana Ruiz', email:'dana@sunesol.com' },
        projectName:'Fresno depot — DCFC', type:'dcfc', site:{ address:'Fresno, CA' },
        scope:['plot','sitemap','utility'], submittedAt:t(26) },

      { orgId:'iqgen.energy', purpose:'service', status:'in_production', priority:'rush',
        customer:{ company:'iQGen Technologies', contact:'Priya Raman', email:'priya@iqgen.energy' },
        projectName:'Odessa TX — solar + storage', type:'solar+bess', site:{ address:'Odessa, TX' },
        scope:['plot','cost','oneline'], quote:{ total:88000 },
        admin:{ assignee:'tom@clearsky-usa.com', assigneeName:'Thomas' },
        submittedAt:t(52), firstResponseAt:t(50.5), startedAt:t(46) },

      { orgId:'nextnrg.com', purpose:'service', status:'quoted', priority:'standard',
        customer:{ company:'NextNRG', contact:'Marcus Hale', email:'marcus@nextnrg.com' },
        projectName:'Tampa microgrid screen', type:'microgrid', site:{ address:'Tampa, FL' },
        scope:['intercon','cost'], quote:{ total:42000 },
        admin:{ assignee:'tom@clearsky-usa.com', assigneeName:'Thomas' },
        submittedAt:t(140), firstResponseAt:t(133) },

      { orgId:'spatco.com', purpose:'build', status:'submitted', priority:'standard',
        customer:{ company:'SPATCO', contact:'Ellis Ward', email:'ellis@spatco.com' },
        projectName:'Charlotte yard — self serve', type:'l2', site:{ address:'Charlotte, NC' },
        scope:['sitemap'], submittedAt:t(88) },

      { orgId:'concordenergyusa.com', purpose:'service', status:'delivered', priority:'rush',
        customer:{ company:'Concord Energy', contact:'Dale Whitcomb', email:'dale@concordenergyusa.com' },
        projectName:'Cedar Rapids fleet depot', type:'dcfc', site:{ address:'Cedar Rapids, IA' },
        scope:['plot','ahj'], quote:{ total:47000 },
        admin:{ assignee:'tom@clearsky-usa.com', assigneeName:'Thomas' },
        submittedAt:fd(240), firstResponseAt:fd(237.5), startedAt:fd(230),
        deliveredAt:new Date(recentDone).toISOString() },

      { orgId:'sunesol.com', purpose:'service', status:'delivered', priority:'standard',
        customer:{ company:'SunESol', contact:'Dana Ruiz', email:'dana@sunesol.com' },
        projectName:'Bakersfield rooftop', type:'solar', site:{ address:'Bakersfield, CA' },
        scope:['cost'], quote:{ total:18500 },
        admin:{ assignee:'tom@clearsky-usa.com', assigneeName:'Thomas' },
        submittedAt:t(1100), firstResponseAt:t(1078), deliveredAt:t(820), paidAt:t(300) },

      { orgId:'fenecon.com', purpose:'service', status:'declined', priority:'standard',
        customer:{ company:'FENECON', contact:'Jonas Mehl', email:'j.mehl@fenecon.de' },
        projectName:'Ulm C&I retrofit', type:'bess', site:{ address:'Ulm, DE' },
        scope:['cost'], quote:{ total:12000 },
        submittedAt:t(500), firstResponseAt:t(492) }
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

  /* Anything in the raw document the console didn't map, rendered in the
     drawer so a wrong field guess shows as visible data rather than a blank
     row nobody notices. */
  var KNOWN = ['orgId','org','tenant','purpose','mode','path','clientName','customer','company',
    'contactName','contactEmail','contactPhone','contact','email','phone','role','primaryContact',
    'projectName','name','project','site','title','projectType','type','scopeType','assetType',
    'address','siteAddress','location','capacityMw','powerMw','power','durationHrs','durationHours',
    'scope','scopes','deliverables','ledger','packages','notes','note','priority','urgency',
    'dueDate','deadline','commissionRate','status','assignedTo','assignedName','projectId',
    'linkedProjectId','admin','quote','acceptance','value','price','intakeId','createdBy',
    'submittedAt','submitted','createdAt','updatedAt','firstResponseAt','startedAt','deliveredAt',
    'paidAt','activity','internalNotes','_demo'];

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
    inQueue:inQueue, pick:pick, unmapped:unmapped,
    normalize:normalize, init:init, collectionName:collectionName,
    loadRequests:loadRequests, loadOrgs:loadOrgs,
    patch:patch, createLinkedProject:createLinkedProject,
    summarize:summarize, byTenant:byTenant, byStaff:byStaff, sample:sample
  };
})(window);

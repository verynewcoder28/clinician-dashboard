/* app.js - KCHD Clinician Dashboard data layer
   King's College Hospital Dubai | SMART on FHIR R4
   ES5-compatible | no import/export | fhirclient loaded as global FHIR */

// ── Module-level state ────────────────────────────────────────
var statusChart   = null;
var serviceChart  = null;
var volumeChart   = null;
var currentDaysBack = 14;
var currentClient   = null;

// ── Padding helper ─────────────────────────────────────────────
var pad2 = function(n) { return String(n).padStart(2, '0'); };

// ── Service type code lookup ───────────────────────────────────
var SVC_CODES = {
  '272961265': 'FM New',
  '272961277': 'FM Follow Up',
  '374214127': 'Telemedicine'
};

// ── getDateParam ───────────────────────────────────────────────
// Returns ISO 8601 date string with +04:00 offset for FHIR date queries.
function getDateParam(daysBack) {
  var d = new Date();
  d.setDate(d.getDate() - daysBack);
  return (
    d.getFullYear() + '-' +
    pad2(d.getMonth() + 1) + '-' +
    pad2(d.getDate()) +
    'T00:00:00+04:00'
  );
}

// ── UAE date helpers ───────────────────────────────────────────
function getTodayUAE() {
  // Compute current date in UTC+4
  var utcMs  = Date.now() + (new Date().getTimezoneOffset() * 60000);
  var uaeMs  = utcMs + (4 * 3600000);
  var d      = new Date(uaeMs);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function isTodayUAE(isoStr) {
  return typeof isoStr === 'string' && isoStr.startsWith(getTodayUAE());
}

// ── fetchAllPages ──────────────────────────────────────────────
// Fetches all pages of a FHIR bundle by following next links.
// Returns flat array of resource objects.
function fetchAllPages(client, relativeUrl) {
  var resources = [];
  function fetchPage(url) {
    return client.request({ url: url }).then(function(bundle) {
      if (bundle && bundle.entry) {
        bundle.entry.forEach(function(e) {
          if (e.resource) resources.push(e.resource);
        });
      }
      var next = null;
      if (bundle && bundle.link) {
        for (var i = 0; i < bundle.link.length; i++) {
          if (bundle.link[i].relation === 'next') {
            next = bundle.link[i].url;
            break;
          }
        }
      }
      return next ? fetchPage(next) : resources;
    });
  }
  return fetchPage(relativeUrl);
}

// ── Appointment participant helpers ────────────────────────────
function isPPRF(appt, prsnlId) {
  return (appt.participant || []).some(function(p) {
    var isPerformer = (p.type || []).some(function(t) {
      return (t.coding || []).some(function(c) { return c.code === 'PPRF'; });
    });
    return isPerformer && p.actor && p.actor.reference === 'Practitioner/' + prsnlId;
  });
}

function getSvcLabel(appt) {
  var codes = [];
  (appt.serviceType || []).forEach(function(st) {
    (st.coding || []).forEach(function(c) { codes.push(c.code); });
  });
  for (var i = 0; i < codes.length; i++) {
    if (SVC_CODES[codes[i]]) return SVC_CODES[codes[i]];
  }
  return 'Other';
}

function getEncounterId(appt) {
  var exts = appt.extension || [];
  for (var i = 0; i < exts.length; i++) {
    if (exts[i].url === 'https://fhir-ehr.cerner.com/r4/StructureDefinition/associated-encounter') {
      var ref = exts[i].valueReference && exts[i].valueReference.reference;
      return ref ? ref.replace('Encounter/', '') : null;
    }
  }
  return null;
}

function getPatientRef(appt) {
  var participants = appt.participant || [];
  for (var i = 0; i < participants.length; i++) {
    var p = participants[i];
    var isPatient = (p.type || []).some(function(t) {
      return (t.coding || []).some(function(c) { return c.code === '4572'; });
    });
    // Fallback: actor reference starts with Patient/
    if (!isPatient && p.actor && p.actor.reference &&
        p.actor.reference.startsWith('Patient/')) {
      isPatient = true;
    }
    if (isPatient && p.actor && p.actor.reference) return p.actor.reference;
  }
  return null;
}

// ── parseAppointmentBundle ─────────────────────────────────────
// Filters to PPRF appointments for this practitioner and computes metrics.
function parseAppointmentBundle(resources, prsnlId) {
  var filtered = resources.filter(function(a) {
    return a.resourceType === 'Appointment' && isPPRF(a, prsnlId);
  });

  var cnt = { fulfilled: 0, checkedIn: 0, noshow: 0, cancelled: 0 };
  var svc = { 'FM New': 0, 'FM Follow Up': 0, 'Telemedicine': 0, 'Other': 0 };
  var durations = [];

  filtered.forEach(function(a) {
    var s = a.status;
    if      (s === 'fulfilled')  cnt.fulfilled++;
    else if (s === 'checked-in') cnt.checkedIn++;
    else if (s === 'noshow')     cnt.noshow++;
    else if (s === 'cancelled')  cnt.cancelled++;

    if (s !== 'cancelled') {
      var lbl = getSvcLabel(a);
      svc[lbl] = (svc[lbl] || 0) + 1;
    }

    if ((s === 'fulfilled' || s === 'checked-in') && a.start && a.end) {
      var mins = (new Date(a.end) - new Date(a.start)) / 60000;
      if (mins > 0 && mins < 480) durations.push(mins);
    }
  });

  // total excludes cancelled
  var total = cnt.fulfilled + cnt.checkedIn + cnt.noshow;

  var avgDuration = durations.length
    ? Math.round(durations.reduce(function(a, b) { return a + b; }, 0) / durations.length)
    : 0;

  return {
    total:       total,
    fulfilled:   cnt.fulfilled,
    checkedIn:   cnt.checkedIn,
    noshow:      cnt.noshow,
    cancelled:   cnt.cancelled,
    newPts:      svc['FM New'],
    followUp:    svc['FM Follow Up'],
    telemed:     svc['Telemedicine'],
    dnaRate:     total > 0 ? Math.round(cnt.noshow / total * 1000) / 10 : 0,
    utilisation: total > 0
      ? Math.round((cnt.fulfilled + cnt.checkedIn) / total * 1000) / 10
      : 0,
    avgDuration: avgDuration,
    raw:         filtered
  };
}

// ── extractEncounterPatientMap ─────────────────────────────────
// Returns { [patientId]: { patientName, encounterIds: [...] } }
// for fulfilled and checked-in appointments only.
function extractEncounterPatientMap(resources, prsnlId) {
  var map = {};

  resources.filter(function(a) {
    return a.resourceType === 'Appointment'
      && isPPRF(a, prsnlId)
      && (a.status === 'fulfilled' || a.status === 'checked-in');
  }).forEach(function(a) {
    var ptRef = getPatientRef(a);
    if (!ptRef) return;

    var ptId  = ptRef.replace('Patient/', '');
    var encId = getEncounterId(a);

    if (!map[ptId]) {
      // Try to get display name from participant
      var ptName = '--';
      (a.participant || []).forEach(function(p) {
        var isPt = (p.type || []).some(function(t) {
          return (t.coding || []).some(function(c) { return c.code === '4572'; });
        });
        if (!isPt && p.actor && p.actor.reference &&
            p.actor.reference.startsWith('Patient/')) isPt = true;
        if (isPt && p.actor && p.actor.display) ptName = p.actor.display;
      });
      map[ptId] = { patientName: ptName, encounterIds: [] };
    }

    if (encId && map[ptId].encounterIds.indexOf(encId) === -1) {
      map[ptId].encounterIds.push(encId);
    }
  });

  return map;
}

// ── fetchActiveOrders ──────────────────────────────────────────
// Fetches ServiceRequest?patient=... for each patient in the map.
// Filters client-side: status=active AND encounter in that patient's encounterIds.
// Batches in groups of 5.
function fetchActiveOrders(client, encounterPatientMap) {
  var ptIds = Object.keys(encounterPatientMap);
  if (!ptIds.length) return Promise.resolve([]);

  var results = [];

  function runBatch(offset) {
    if (offset >= ptIds.length) return Promise.resolve();
    var batch = ptIds.slice(offset, offset + 5);
    return Promise.all(batch.map(function(ptId) {
      return client.request('ServiceRequest?patient=' + ptId + '&_count=50')
        .then(function(bundle) {
          var entries = bundle && bundle.entry ? bundle.entry : [];
          var encIds  = encounterPatientMap[ptId].encounterIds;
          entries.forEach(function(e) {
            if (!e.resource || e.resource.resourceType !== 'ServiceRequest') return;
            var sr = e.resource;
            if (sr.status !== 'active') return;
            if (!sr.encounter || !sr.encounter.reference) return;
            var srEncId = sr.encounter.reference.replace('Encounter/', '');
            if (encIds.indexOf(srEncId) !== -1) {
              sr._patientName = encounterPatientMap[ptId].patientName;
              results.push(sr);
            }
          });
        })
        .catch(function() { /* swallow - patient may have no SRs */ });
    })).then(function() { return runBatch(offset + 5); });
  }

  return runBatch(0).then(function() { return results; });
}

// ── UI helpers ─────────────────────────────────────────────────
function setText(id, val) {
  var e = document.getElementById(id);
  if (e) e.textContent = (val === null || val === undefined) ? '--' : val;
}

function escHtml(str) {
  return String(str == null ? '--' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function destroyChart(c) {
  if (c) { try { c.destroy(); } catch(e) {} }
}

// ── updateOrdersTable ──────────────────────────────────────────
// Pass null to show skeleton, [] for empty state, array for rows.
function updateOrdersTable(orders) {
  var skel  = document.getElementById('orders-skeleton');
  var empty = document.getElementById('orders-empty');
  var tbody = document.getElementById('orders-tbody');

  if (orders === null) {
    // Loading
    if (skel)  skel.style.display  = 'block';
    if (empty) empty.style.display = 'none';
    if (tbody) tbody.innerHTML = '';
    return;
  }

  if (skel)  skel.style.display = 'none';
  if (empty) empty.style.display = 'none';
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!orders.length) {
    if (empty) empty.style.display = 'block';
    return;
  }

  orders.forEach(function(sr) {
    var tr       = document.createElement('tr');
    var patient  = sr._patientName || '--';
    var orderTxt = sr.code && sr.code.text
      ? sr.code.text
      : sr.code && sr.code.coding && sr.code.coding[0]
        ? (sr.code.coding[0].display || sr.code.coding[0].code || '--')
        : '--';
    var category = '--';
    if (sr.category && sr.category[0]) {
      category = sr.category[0].text
        || (sr.category[0].coding && sr.category[0].coding[0]
            ? (sr.category[0].coding[0].display || '--')
            : '--');
    }
    var priority = sr.priority || '--';
    var authored = sr.authoredOn ? sr.authoredOn.substring(0, 10) : '--';

    tr.innerHTML =
      '<td>' + escHtml(patient)  + '</td>' +
      '<td>' + escHtml(orderTxt) + '</td>' +
      '<td>' + escHtml(category) + '</td>' +
      '<td><span class="priority-badge priority-' + escHtml(priority) + '">'
        + escHtml(priority) + '</span></td>' +
      '<td>' + escHtml(authored) + '</td>';
    tbody.appendChild(tr);
  });
}

// ── renderDashboard ────────────────────────────────────────────
// Populates doctor name, KPI cards, all three charts, and orders table.
// Call with activeOrders=null to show skeleton in orders section.
function renderDashboard(parsed, activeOrders, practitioner) {

  // Doctor name
  var name = 'Clinician';
  if (practitioner && practitioner.name && practitioner.name[0]) {
    var n = practitioner.name[0];
    if (n.text) {
      name = n.text;
    } else {
      var parts = [];
      if (n.prefix && n.prefix.length) parts.push(n.prefix.join(' '));
      if (n.given  && n.given.length)  parts.push(n.given.join(' '));
      if (n.family) parts.push(n.family);
      if (parts.length) name = parts.join(' ');
    }
  }
  setText('doctor-name', name);

  // KPI cards
  setText('kpi-total',     parsed.total);
  setText('kpi-fulfilled', parsed.fulfilled);
  setText('kpi-checkedin', parsed.checkedIn);
  setText('kpi-dna',       parsed.noshow + ' (' + parsed.dnaRate + '%)');
  setText('kpi-avg',       parsed.avgDuration > 0 ? parsed.avgDuration + ' min' : '--');
  setText('kpi-util',      parsed.utilisation + '%');

  // ── Status doughnut ────────────────────────────────────────
  destroyChart(statusChart);
  var sCtx = document.getElementById('chart-status');
  if (sCtx) {
    statusChart = new Chart(sCtx, {
      type: 'doughnut',
      data: {
        labels: ['Fulfilled', 'Checked In', 'No Show'],
        datasets: [{
          data: [parsed.fulfilled, parsed.checkedIn, parsed.noshow],
          backgroundColor: ['#1D9E75', '#378ADD', '#E24B4A'],
          borderWidth: 2,
          borderColor: '#ffffff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { padding: 16, font: { size: 12 } }
          },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                var tot = ctx.dataset.data.reduce(function(a, b) { return a + b; }, 0);
                var pct = tot > 0 ? ' (' + Math.round(ctx.raw / tot * 100) + '%)' : '';
                return ctx.label + ': ' + ctx.raw + pct;
              }
            }
          }
        }
      }
    });
  }

  // ── Service type doughnut ──────────────────────────────────
  destroyChart(serviceChart);
  var svCtx = document.getElementById('chart-service');
  if (svCtx) {
    serviceChart = new Chart(svCtx, {
      type: 'doughnut',
      data: {
        labels: ['FM New', 'FM Follow Up', 'Telemedicine'],
        datasets: [{
          data: [parsed.newPts, parsed.followUp, parsed.telemed],
          backgroundColor: ['#534AB7', '#378ADD', '#1D9E75'],
          borderWidth: 2,
          borderColor: '#ffffff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { padding: 16, font: { size: 12 } }
          },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                var tot = ctx.dataset.data.reduce(function(a, b) { return a + b; }, 0);
                var pct = tot > 0 ? ' (' + Math.round(ctx.raw / tot * 100) + '%)' : '';
                return ctx.label + ': ' + ctx.raw + pct;
              }
            }
          }
        }
      }
    });
  }

  // ── Daily volume bar chart ─────────────────────────────────
  var dateKeys   = [];
  var dateLabels = [];
  var dateCounts = {};

  for (var di = currentDaysBack; di >= 0; di--) {
    var dd = new Date();
    dd.setDate(dd.getDate() - di);
    var dk = dd.getFullYear() + '-' + pad2(dd.getMonth() + 1) + '-' + pad2(dd.getDate());
    dateKeys.push(dk);
    dateLabels.push(pad2(dd.getDate()) + '/' + pad2(dd.getMonth() + 1));
    dateCounts[dk] = 0;
  }

  parsed.raw.forEach(function(a) {
    if (a.status !== 'fulfilled' && a.status !== 'checked-in') return;
    if (!a.start) return;
    var dk2 = a.start.substring(0, 10);
    if (dateCounts.hasOwnProperty(dk2)) dateCounts[dk2]++;
  });

  destroyChart(volumeChart);
  var vCtx = document.getElementById('chart-volume');
  if (vCtx) {
    volumeChart = new Chart(vCtx, {
      type: 'bar',
      data: {
        labels: dateLabels,
        datasets: [{
          label: 'Patients Seen',
          data: dateKeys.map(function(k) { return dateCounts[k]; }),
          backgroundColor: '#378ADD',
          borderRadius: 4,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { size: 11 }, maxRotation: 45 }
          },
          y: {
            beginAtZero: true,
            ticks: { precision: 0, font: { size: 11 } },
            grid: { color: 'rgba(0,0,0,0.05)' }
          }
        }
      }
    });
  }

  // Orders table (null = skeleton, [] = empty, array = rows)
  updateOrdersTable(activeOrders);

  // Reveal dashboard
  document.body.removeAttribute('hidden');
  var overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.style.display = 'none';
  var dash = document.getElementById('dashboard');
  if (dash) dash.removeAttribute('hidden');
}

// ── showError ──────────────────────────────────────────────────
function showError(msg) {
  document.body.removeAttribute('hidden');
  var overlay = document.getElementById('loading-overlay');
  if (overlay) overlay.style.display = 'none';
  var errState = document.getElementById('error-state');
  if (errState) errState.removeAttribute('hidden');
  var errMsg = document.getElementById('error-message');
  if (errMsg) errMsg.textContent = msg;
}

// ── setDateRange ───────────────────────────────────────────────
// Called by date range buttons in index.html.
function setDateRange(btn, days) {
  currentDaysBack = days;
  var buttons = document.querySelectorAll('.date-range-buttons button');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].classList.remove('active');
  }
  if (btn) btn.classList.add('active');
  if (currentClient) loadDashboard(currentClient);
}

// ── Resolve Practitioner ID from token ────────────────────────
function resolveFhirUser(client) {
  // 1. fhirclient getFhirUser() method
  if (typeof client.getFhirUser === 'function') {
    var fu = client.getFhirUser();
    if (fu) return fu;
  }
  // 2. Decode ID token payload
  var tokenResp = (client.state && client.state.tokenResponse) || {};
  if (tokenResp.id_token) {
    try {
      var segments = tokenResp.id_token.split('.');
      var payload  = JSON.parse(atob(
        segments[1].replace(/-/g, '+').replace(/_/g, '/')
      ));
      if (payload.fhirUser) return payload.fhirUser;
      if (payload.profile)  return payload.profile;
    } catch(e) { /* ignore decode errors */ }
  }
  // 3. Top-level tokenResponse claim
  if (tokenResp.fhirUser) return tokenResp.fhirUser;
  return null;
}

// ── loadDashboard ──────────────────────────────────────────────
// Orchestrates the full data fetch and render cycle.
function loadDashboard(client) {
  currentClient = client;

  // Show loading overlay, hide everything else
  document.body.removeAttribute('hidden');
  var overlay    = document.getElementById('loading-overlay');
  var dash       = document.getElementById('dashboard');
  var errState   = document.getElementById('error-state');

  if (overlay)  overlay.style.display = 'flex';
  if (dash)     dash.setAttribute('hidden', '');
  if (errState) errState.setAttribute('hidden', '');

  // Resolve fhirUser reference (e.g. "Practitioner/12345")
  var fhirUser = resolveFhirUser(client);
  var prsnlId  = null;

  if (fhirUser && fhirUser.indexOf('Practitioner/') !== -1) {
    prsnlId = fhirUser.replace(/^.*Practitioner\//, '');
  }

  // Fetch Practitioner resource
  var practitioner  = null;
  var practPromise;

  if (fhirUser) {
    // Strip FHIR base URL if present so client.request gets a relative path
    var base    = (client.state && client.state.serverUrl) || '';
    var practUrl = fhirUser;
    if (base && practUrl.startsWith(base)) {
      practUrl = practUrl.slice(base.length).replace(/^\//, '');
    }
    practPromise = client.request(practUrl)
      .then(function(p) {
        practitioner = p;
        if (p && p.id) prsnlId = p.id;
      })
      .catch(function() {
        // Non-fatal - sandbox may not resolve fhirUser URL
      });
  } else {
    practPromise = Promise.resolve();
  }

  practPromise.then(function() {
    if (!prsnlId) {
      showError(
        'Could not determine Practitioner ID from token. ' +
        'Ensure the openid and profile scopes are granted and ' +
        'that fhirUser is present in the ID token.'
      );
      return;
    }

    var dateParam = getDateParam(currentDaysBack);
    var apptUrl   =
      'Appointment?practitioner=' + prsnlId +
      '&date=ge' + dateParam +
      '&status=fulfilled&status=noshow&status=checked-in' +
      '&_count=200';

    return fetchAllPages(client, apptUrl)
      .then(function(appointments) {
        var parsed  = parseAppointmentBundle(appointments, prsnlId);
        var fullMap = extractEncounterPatientMap(appointments, prsnlId);

        // Build today-only patient map for active orders
        var todayMap = {};
        parsed.raw.forEach(function(a) {
          if (a.status !== 'fulfilled' && a.status !== 'checked-in') return;
          if (!isTodayUAE(a.start)) return;
          var ptRef = getPatientRef(a);
          if (!ptRef) return;
          var ptId = ptRef.replace('Patient/', '');
          if (fullMap[ptId]) todayMap[ptId] = fullMap[ptId];
        });

        // Render KPIs and charts immediately; orders show skeleton
        renderDashboard(parsed, null, practitioner);

        // Fetch orders then update table
        return fetchActiveOrders(client, todayMap)
          .then(function(orders) {
            updateOrdersTable(orders);
          })
          .catch(function() {
            updateOrdersTable([]);
          });
      });
  }).catch(function(err) {
    showError(
      'Failed to load dashboard data: ' +
      (err && (err.message || JSON.stringify(err, null, 2)))
    );
  });
}

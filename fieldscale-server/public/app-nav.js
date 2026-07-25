// Shared à-la-carte gating: hides nav links for modules a company isn't subscribed to, and
// bounces you off a page whose module is disabled. Include on every app page along with a
// <meta name="fs-module" content="..."> naming the page's module (omit for always-on pages).
(function () {
  var TOKEN = 'fieldscale_token';
  function getToken() { return localStorage.getItem(TOKEN); }

  // Which module each nav destination belongs to. Anything not listed (Company, Owner) is always on.
  var NAV_MODULE = {
    '/': 'takeoff', '/index.html': 'takeoff',
    '/leads.html': 'crm', '/lead.html': 'crm', '/customers.html': 'crm', '/customer.html': 'crm',
    '/proposals.html': 'estimating', '/estimate.html': 'estimating', '/estimates.html': 'estimating',
    '/invoices.html': 'invoicing', '/invoice.html': 'invoicing',
    '/jobs.html': 'jobs', '/job.html': 'jobs', '/schedule.html': 'jobs',
    '/purchase-orders.html': 'jobs', '/po.html': 'jobs',
    '/workorders.html': 'jobs', '/workorder.html': 'jobs'
  };
  var LANDING = { takeoff: '/', crm: '/leads.html', estimating: '/proposals.html', jobs: '/jobs.html', invoicing: '/invoices.html' };
  var ORDER = ['crm', 'takeoff', 'estimating', 'jobs', 'invoicing'];

  function pageModule() {
    var m = document.querySelector('meta[name="fs-module"]');
    return m ? m.getAttribute('content') : null;
  }

  async function run() {
    var t = getToken();
    if (!t) return; // logged out — the page's own logic handles the login redirect
    var modules;
    try {
      var res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + t } });
      if (!res.ok) return;
      var me = await res.json();
      modules = me.modules;
    } catch (e) { return; }
    if (!Array.isArray(modules)) return; // everything on — nothing to gate
    var enabled = {}; modules.forEach(function (m) { enabled[m] = true; });

    // Hide nav links for modules this company can't use.
    document.querySelectorAll('header nav a[href]').forEach(function (a) {
      var mod = NAV_MODULE[a.getAttribute('href')];
      if (mod && !enabled[mod]) a.style.display = 'none';
    });

    // If the page itself belongs to a disabled module, send them to their first enabled area.
    var pm = pageModule();
    if (pm && !enabled[pm]) {
      var first = ORDER.filter(function (m) { return enabled[m]; })[0];
      alert('That part of Fieldscale isn’t enabled for your account.');
      location.href = first ? LANDING[first] : '/company.html';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();

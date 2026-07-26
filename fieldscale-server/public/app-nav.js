// Shared top navigation + à-la-carte gating. This renders the whole header menu (grouped into a
// few dropdowns) so every page gets the same nav from one place — pages only need an empty
// <nav></nav> in the header and a <meta name="fs-module" content="..."> for module gating.
(function () {
  var TOKEN = 'fieldscale_token';
  function getToken() { return localStorage.getItem(TOKEN); }

  // The menu: a few top groups, each with items (or a direct link). module gates visibility;
  // items with no module are always shown. Company/Owner live on the right as account links.
  var MENU = [
    { label: 'Leads', items: [
      { label: 'Leads', href: '/leads.html', module: 'crm' },
      { label: 'Customers', href: '/customers.html', module: 'crm' },
      { label: 'Follow-ups', href: '/followups.html' }
    ] },
    { label: 'Takeoff', href: '/', module: 'takeoff' },
    { label: 'Estimate', items: [
      { label: 'Estimates', href: '/proposals.html', module: 'estimating' },
      { label: 'Price Book', href: '/estimates.html', module: 'estimating' }
    ] },
    { label: 'Job', items: [
      { label: 'Jobs', href: '/jobs.html', module: 'jobs' },
      { label: 'Schedule', href: '/schedule.html', module: 'jobs' },
      { label: 'Work Orders', href: '/workorders.html', module: 'jobs' },
      { label: 'Purchase Orders', href: '/purchase-orders.html', module: 'jobs' }
    ] },
    { label: 'Invoice', items: [
      { label: 'Invoices', href: '/invoices.html', module: 'invoicing' },
      { label: 'Reports', href: '/reports.html' }
    ] }
  ];
  var ACCOUNT = [
    { label: 'Company', href: '/company.html' },
    { label: 'Team', href: '/admin.html', admin: true, id: 'owner-nav' }
  ];

  // Detail/editor pages light up their list page's group.
  var ACTIVE_ALIAS = {
    '/index.html': '/',
    '/lead.html': '/leads.html', '/customer.html': '/customers.html',
    '/estimate.html': '/proposals.html',
    '/job.html': '/jobs.html', '/workorder.html': '/workorders.html', '/po.html': '/purchase-orders.html',
    '/invoice.html': '/invoices.html'
  };
  var LANDING = { takeoff: '/', crm: '/leads.html', estimating: '/proposals.html', jobs: '/jobs.html', invoicing: '/invoices.html' };
  var ORDER = ['crm', 'takeoff', 'estimating', 'jobs', 'invoicing'];

  function pageModule() {
    var m = document.querySelector('meta[name="fs-module"]');
    return m ? m.getAttribute('content') : null;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function injectCSS() {
    if (document.getElementById('fs-nav-css')) return;
    var css = ''
      + 'header nav{position:relative;align-items:center}'
      + '.navgroup{position:relative;display:inline-flex;align-items:center}'
      + '.navtop{color:#B9C2CB;font-size:13px;padding:2px 0;cursor:pointer;white-space:nowrap;text-decoration:none;background:none;border:none;font-family:inherit;display:inline-flex;align-items:center;gap:3px}'
      + '.navtop:hover{color:#F6F3EA}'
      + '.navtop.active{color:#F6F3EA;border-bottom:2px solid #E8722C;padding-bottom:2px}'
      + '.nav-caret{font-size:9px;opacity:.75}'
      + '.navmenu{position:absolute;top:100%;left:0;margin-top:6px;min-width:190px;background:#fff;border:1px solid #E4DFCF;border-radius:4px;box-shadow:0 8px 26px rgba(0,0,0,.22);padding:6px;display:none;flex-direction:column;z-index:120}'
      + '.navgroup:hover>.navmenu,.navgroup.open>.navmenu{display:flex}'
      + '.navmenu a{display:block;color:#1C1E22;padding:8px 12px;font-size:13px;border-radius:3px;white-space:nowrap;text-decoration:none;border:none}'
      + '.navmenu a:hover{background:#F6F3EA}'
      + '.navmenu a.active{color:#C25A1B;font-weight:600}'
      + '.nav-account{display:inline-flex;align-items:center;gap:16px;margin-left:14px}'
      + '.nav-account a{color:#B9C2CB;font-size:13px;text-decoration:none;white-space:nowrap}'
      + '.nav-account a:hover{color:#F6F3EA}'
      + '.nav-account a.active{color:#F6F3EA;border-bottom:2px solid #E8722C;padding-bottom:2px}'
      // Per-company co-branding: the customer's own logo/name next to the product mark.
      + '.fs-cobrand{display:none;align-items:center;gap:9px;margin-left:12px;padding-left:12px;border-left:1px solid rgba(255,255,255,.22)}'
      + '.fs-cobrand.on{display:inline-flex}'
      + '.fs-cobrand img{max-height:26px;max-width:130px;display:block;border-radius:2px}'
      + '.fs-cobrand .fs-coname{color:#F6F3EA;font-family:"Oswald",sans-serif;font-weight:600;font-size:15px;white-space:nowrap}'
      + '@media (max-width:760px){.fs-cobrand .fs-coname{display:none}.fs-cobrand{margin-left:8px;padding-left:8px}}'
      // Save action: bigger + green, and a matching bar for the bottom-of-page Save.
      + '.btn.save{background:#4A9B6E;border-color:#4A9B6E;color:#fff;font-weight:600;padding:10px 22px;font-size:14px}'
      + '.btn.save:hover{background:#3f8a60;border-color:#3f8a60}'
      + '.save-bottom-bar{display:flex;justify-content:flex-end;margin:24px 0 6px;padding-top:16px;border-top:1px solid #E4DFCF}';
    var st = document.createElement('style'); st.id = 'fs-nav-css'; st.textContent = css;
    document.head.appendChild(st);
  }

  // Show the customer's own logo/name in the header, next to the product mark. Renders from a
  // localStorage cache instantly, then refreshes from the server at most every few minutes.
  function ensureCobrandEl() {
    var el = document.getElementById('fs-cobrand');
    if (el) return el;
    var brand = document.querySelector('header .brand') || document.querySelector('.topbar .brand');
    if (!brand || !brand.parentNode) return null;
    el = document.createElement('div'); el.className = 'fs-cobrand'; el.id = 'fs-cobrand';
    brand.parentNode.insertBefore(el, brand.nextSibling);
    return el;
  }
  function paintCobrand(name, logo) {
    var el = ensureCobrandEl(); if (!el) return;
    if (!logo && !name) { el.className = 'fs-cobrand'; el.innerHTML = ''; return; }
    el.innerHTML = (logo ? '<img src="' + logo + '" alt="' + esc(name || '') + '">' : '')
      + (name ? '<span class="fs-coname">' + esc(name) + '</span>' : '');
    el.className = 'fs-cobrand on';
  }
  function renderBranding() {
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem('fs_brand') || 'null'); } catch (e) {}
    if (cached) paintCobrand(cached.name, cached.logo);   // instant, no flash
    var fresh = cached && cached.ts && (Date.now() - cached.ts < 5 * 60 * 1000);
    if (fresh) return;                                     // refreshed recently — skip the fetch
    var t = getToken(); if (!t) return;
    fetch('/api/branding', { headers: { 'Authorization': 'Bearer ' + t } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        paintCobrand(d.companyName, d.logo);
        try { localStorage.setItem('fs_brand', JSON.stringify({ name: d.companyName, logo: d.logo, ts: Date.now() })); } catch (e) {}
      }).catch(function () {});
  }

  function build() {
    // Standard pages use <header><nav>; the takeoff app uses <nav class="topnav">.
    var nav = document.querySelector('header nav') || document.querySelector('nav.topnav');
    if (!nav) return;
    var cur = location.pathname;
    var curActive = ACTIVE_ALIAS[cur] || cur;

    var html = '';
    MENU.forEach(function (g) {
      if (g.href) { // direct link (Takeoff)
        html += '<a class="navtop navdirect" href="' + g.href + '" data-mod="' + (g.module || '') + '">' + esc(g.label) + '</a>';
      } else {
        var items = g.items.map(function (it) {
          return '<a href="' + it.href + '" data-mod="' + (it.module || '') + '">' + esc(it.label) + '</a>';
        }).join('');
        html += '<div class="navgroup"><span class="navtop">' + esc(g.label) + ' <span class="nav-caret">▾</span></span><div class="navmenu">' + items + '</div></div>';
      }
    });
    nav.innerHTML = html;

    // The brand/logo (top-left) is the home button — click it to reach the company dashboard.
    document.querySelectorAll('header .brand, .topbar .brand').forEach(function (b) {
      b.style.cursor = 'pointer';
      b.title = 'Home — company dashboard';
      b.addEventListener('click', function () { location.href = '/home.html'; });
    });

    // Account links (Company / Owner) on the right of the header.
    var acct = document.createElement('div'); acct.className = 'nav-account';
    acct.innerHTML = ACCOUNT.map(function (a) {
      return '<a href="' + a.href + '"' + (a.id ? ' id="' + a.id + '"' : '') + (a.admin ? ' style="display:none"' : '') + '>' + esc(a.label) + '</a>';
    }).join('');
    var who = document.querySelector('header .who');
    if (who && who.parentNode) who.parentNode.insertBefore(acct, who);
    else nav.appendChild(acct); // takeoff topbar has no .who — keep account links inline after the groups

    // Mark active group/item.
    nav.querySelectorAll('a[href]').forEach(function (a) {
      if (a.getAttribute('href') === curActive) {
        a.classList.add('active');
        var grp = a.closest('.navgroup');
        if (grp) grp.querySelector('.navtop').classList.add('active');
      }
    });
    document.querySelectorAll('.nav-account a[href]').forEach(function (a) {
      if (a.getAttribute('href') === curActive) a.classList.add('active');
    });

    // Tap a group label to toggle its menu (touch); clicking elsewhere closes.
    nav.querySelectorAll('.navgroup > .navtop').forEach(function (top) {
      top.addEventListener('click', function (e) {
        e.stopPropagation();
        var grp = top.parentNode, wasOpen = grp.classList.contains('open');
        nav.querySelectorAll('.navgroup.open').forEach(function (o) { o.classList.remove('open'); });
        if (!wasOpen) grp.classList.add('open');
      });
    });
    document.addEventListener('click', function () {
      nav.querySelectorAll('.navgroup.open').forEach(function (o) { o.classList.remove('open'); });
    });
  }

  // Field employees only get their jobs. Strip the nav to Jobs + Schedule, drop the account links,
  // and bounce them out of any other page. (The server enforces this too — this is just the UI.)
  function applyFieldRole() {
    var FIELD_OK = { '/jobs.html': 1, '/job.html': 1, '/schedule.html': 1 };
    var p = location.pathname;
    var nav = document.querySelector('header nav') || document.querySelector('nav.topnav');
    if (nav) {
      nav.innerHTML =
        '<a class="navtop navdirect' + (p === '/jobs.html' ? ' active' : '') + '" href="/jobs.html">Jobs</a>' +
        '<a class="navtop navdirect' + (p === '/schedule.html' ? ' active' : '') + '" href="/schedule.html">Schedule</a>';
    }
    document.querySelectorAll('.nav-account').forEach(function (a) { a.remove(); });
    document.querySelectorAll('header .brand, .topbar .brand').forEach(function (b) {
      var c = b.cloneNode(true); if (b.parentNode) b.parentNode.replaceChild(c, b); // drop the home-click handler
      c.style.cursor = 'pointer'; c.addEventListener('click', function () { location.href = '/jobs.html'; });
    });
    if (!FIELD_OK[p]) location.replace('/jobs.html');
  }

  function gate(me) {
    if (me && me.role === 'field') { applyFieldRole(); return; }
    var modules = me && me.modules;
    var enabled = null;
    if (Array.isArray(modules)) { enabled = {}; modules.forEach(function (m) { enabled[m] = true; }); }

    if (enabled) {
      // Remove items whose module is off, then any group left with no items.
      document.querySelectorAll('header nav [data-mod]').forEach(function (el) {
        var mod = el.getAttribute('data-mod');
        if (mod && !enabled[mod]) el.remove();
      });
      document.querySelectorAll('header nav .navgroup').forEach(function (grp) {
        if (!grp.querySelector('.navmenu a')) grp.remove();
      });
    }

    // Owner link: admins / platform admins only.
    var owner = document.getElementById('owner-nav');
    if (owner) owner.style.display = (me && (me.role === 'admin' || me.platformAdmin)) ? '' : 'none';

    // If the current page's module is disabled, bounce to the first enabled area.
    if (enabled) {
      var pm = pageModule();
      if (pm && !enabled[pm]) {
        var first = ORDER.filter(function (m) { return enabled[m]; })[0];
        alert('That part of Fieldscale isn’t enabled for your account.');
        location.href = first ? LANDING[first] : '/company.html';
      }
    }
  }

  // Let the Company page trigger an immediate re-fetch after the logo/name changes.
  window.fsRefreshBranding = function () { try { localStorage.removeItem('fs_brand'); } catch (e) {} renderBranding(); };

  // Make the page's Save button green + bigger, and mirror it at the bottom of the page so a
  // long form can be saved without scrolling back up. Pages opt in simply by having a #save-btn.
  function setupSaveButtons() {
    var top = document.getElementById('save-btn');
    if (!top) return;
    top.classList.add('save');
    var host = document.getElementById('content') || document.querySelector('.wrap');
    if (!host || document.getElementById('save-btn-bottom')) return;
    var bar = document.createElement('div');
    bar.className = 'save-bottom-bar';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'save-btn-bottom';
    btn.className = 'btn save';
    btn.textContent = top.textContent.trim() || 'Save';
    // Reuse the page's own save handler by clicking the top button.
    btn.addEventListener('click', function () { document.getElementById('save-btn').click(); });
    bar.appendChild(btn);
    host.appendChild(bar);
  }

  async function run() {
    injectCSS();
    build();
    setupSaveButtons();
    renderBranding();
    var t = getToken();
    if (!t) return; // logged out — the page handles its own login redirect
    try {
      var res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + t } });
      if (!res.ok) return;
      gate(await res.json());
    } catch (e) { /* leave the full nav up if /api/me fails */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();

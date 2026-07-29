// Apply the saved color theme + load the Inter UI font as early as possible (runs during <head>
// parse, before the body paints, so there's no flash and no per-page edits needed).
(function () {
  try { if (localStorage.getItem('fs-theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); } catch (e) {}
  if (!document.getElementById('fs-inter')) {
    var pc = document.createElement('link'); pc.rel = 'preconnect'; pc.href = 'https://fonts.gstatic.com'; pc.crossOrigin = 'anonymous'; document.head.appendChild(pc);
    var l = document.createElement('link'); l.id = 'fs-inter'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Oswald:wght@500;600;700&display=swap';
    document.head.appendChild(l);
  }
  // Theme tokens (mirror of fs-theme.css) — injected so the shared nav/menu chrome themes correctly
  // even on pages that don't link fs-theme.css (e.g. the takeoff tool). Keep these in sync with fs-theme.css.
  if (!document.getElementById('fs-tokens')) {
    var tk = document.createElement('style'); tk.id = 'fs-tokens';
    tk.textContent = ":root{--ink-navy:#15273A;--header-text:#EAF0F6;--paper:#F4F6F9;--surface:#FFFFFF;--surface-2:#EEF1F5;"
      + "--paper-line:#E4E8EE;--heading:#17293D;--charcoal:#1E242C;--steel:#5C6672;--steel-light:#AEB8C4;"
      + "--accent:#2F6DB0;--accent-dim:#255C97;--cyan:#6FB0DE;--cyan-dim:#3D7FB5;--good:#3E8E5A;--danger:#C0432F;--warn:#B7791F;"
      + "--orange:var(--accent);--orange-dim:var(--accent-dim);--blueprint:#244E74;--blueprint-2:#3A6DA8;--radius:6px;--shadow:0 8px 26px rgba(20,40,70,.14)}"
      + "[data-theme=dark]{--ink-navy:#111B27;--header-text:#E8EEF4;--paper:#14181E;--surface:#1C222B;--surface-2:#242B35;"
      + "--paper-line:#2C333E;--heading:#E9ECF0;--charcoal:#DCE1E7;--steel:#95A0AC;--steel-light:#8A94A0;"
      + "--accent:#5B9CE0;--accent-dim:#3D7FB5;--cyan:#6FB0DE;--cyan-dim:#4A88BE;--good:#61B180;--danger:#E27567;--warn:#D6A24A;"
      + "--blueprint:#2A4E70;--blueprint-2:#3D6FA0;--shadow:0 10px 30px rgba(0,0,0,.5)}";
    document.head.insertBefore(tk, document.head.firstChild);
  }
  // Force Inter for UI/body + keep Oswald for headings, overriding the pages' older per-page fonts.
  var st = document.createElement('style'); st.id = 'fs-font-override';
  // Blueprint Blue uses Inter throughout — headings and brand included (no Oswald).
  st.textContent = "body,input,textarea,select,button,table,th,td,.btn,.navtop,.navmenu a,.acct-btn,.who,.tile,.pill,.card,"
    + "h1,h2,h3,h4,h5,h6,.brand,.fs-coname,.v{font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif !important}";
  document.head.appendChild(st);
})();

// ---- Installable app (PWA): manifest + icons + home-screen meta, and register the service worker.
// Injected here so every page that loads app-nav.js becomes installable — no per-page edits. ----
(function () {
  function head(tag, attrs) {
    var sel = tag + Object.keys(attrs).map(function (k) { return '[' + k + '="' + attrs[k] + '"]'; }).join('');
    if (document.head.querySelector(sel)) return;
    var el = document.createElement(tag);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    document.head.appendChild(el);
  }
  head('link', { rel: 'manifest', href: '/manifest.webmanifest' });
  head('meta', { name: 'theme-color', content: '#15273A' });
  head('meta', { name: 'mobile-web-app-capable', content: 'yes' });
  head('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
  head('meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' });
  head('meta', { name: 'apple-mobile-web-app-title', content: 'Fieldscale' });
  head('link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
})();

// Shared top navigation + à-la-carte gating. This renders the whole header menu (grouped into a
// few dropdowns) so every page gets the same nav from one place — pages only need an empty
// <nav></nav> in the header and a <meta name="fs-module" content="..."> for module gating.
(function () {
  var TOKEN = 'fieldscale_token';
  function getToken() { return localStorage.getItem(TOKEN); }

  // The menu: a few top groups, each with items (or a direct link). module gates visibility;
  // items with no module are always shown. Company/Owner live on the right as account links.
  // Header order (Mike's spec): Leads · Estimate · Job · Invoice · Takeoff.
  var MENU = [
    { label: 'Leads', items: [
      { label: 'Leads', href: '/leads.html', module: 'crm' },
      { label: 'Customers', href: '/customers.html', module: 'crm' },
      { label: 'Follow-ups', href: '/followups.html' }
    ] },
    { label: 'Estimate', items: [
      { label: 'Estimates', href: '/proposals.html', module: 'estimating' },
      { label: 'Price Book', href: '/estimates.html', module: 'estimating' },
      { label: 'Field Measure', href: '/fieldmeasure.html', module: 'estimating' },
      { label: 'Floor Plans', href: '/plans.html', module: 'estimating' }
    ] },
    { label: 'Job', items: [
      { label: 'Jobs', href: '/jobs.html', module: 'jobs' },
      { label: 'Schedule', href: '/schedule.html', module: 'jobs' },
      { label: 'Work Orders', href: '/workorders.html', module: 'jobs' },
      { label: 'Purchase Orders', href: '/purchase-orders.html', module: 'jobs' },
      { label: 'Subs & Vendors', href: '/subs.html', module: 'jobs' }
    ] },
    { label: 'Invoice', items: [
      { label: 'Invoices', href: '/invoices.html', module: 'invoicing' },
      { label: 'Reports', href: '/reports.html' }
    ] },
    { label: 'Takeoff', href: '/', module: 'takeoff' }
  ];
  var ACCOUNT = [
    { label: 'Employees', href: '/employees.html' },
    { label: 'Company', href: '/company.html' },
    { label: 'Team', href: '/admin.html', admin: true, id: 'owner-nav' }
  ];

  // Detail/editor pages light up their list page's group.
  var ACTIVE_ALIAS = {
    '/index.html': '/',
    '/lead.html': '/leads.html', '/customer.html': '/customers.html',
    '/estimate.html': '/proposals.html',
    '/job.html': '/jobs.html', '/workorder.html': '/workorders.html', '/po.html': '/purchase-orders.html',
    '/invoice.html': '/invoices.html', '/floorplan.html': '/plans.html'
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
      + '.navtop{color:var(--steel-light);font-size:13px;padding:2px 0;cursor:pointer;white-space:nowrap;text-decoration:none;background:none;border:none;font-family:inherit;display:inline-flex;align-items:center;gap:3px}'
      + '.navtop:hover{color:var(--header-text)}'
      + '.navtop.active{color:var(--header-text);border-bottom:2px solid var(--accent);padding-bottom:2px}'
      + '.nav-caret{font-size:9px;opacity:.75}'
      + '.navmenu{position:absolute;top:100%;left:0;margin-top:6px;min-width:190px;background:var(--surface);border:1px solid var(--paper-line);border-radius:6px;box-shadow:var(--shadow);padding:6px;display:none;flex-direction:column;z-index:120}'
      + '.navgroup:hover>.navmenu,.navgroup.open>.navmenu{display:flex}'
      + '.navmenu a{display:block;color:var(--charcoal);padding:8px 12px;font-size:13px;border-radius:4px;white-space:nowrap;text-decoration:none;border:none}'
      + '.navmenu a:hover{background:var(--surface-2)}'
      + '.navmenu a.active{color:var(--accent);font-weight:600}'
      + '.nav-account{display:inline-flex;align-items:center;gap:16px;margin-left:14px}'
      + '.nav-account a{color:var(--steel-light);font-size:13px;text-decoration:none;white-space:nowrap}'
      + '.nav-account a:hover{color:var(--header-text)}'
      + '.nav-account a.active{color:var(--header-text);border-bottom:2px solid var(--accent);padding-bottom:2px}'
      // Per-company co-branding: the customer's own logo/name next to the product mark.
      + '.fs-cobrand{display:none;align-items:center;gap:9px;margin-left:12px;padding-left:12px;border-left:1px solid rgba(255,255,255,.22)}'
      + '.fs-cobrand.on{display:inline-flex}'
      + '.fs-cobrand img{max-height:26px;max-width:130px;display:block;border-radius:2px}'
      + '.fs-cobrand .fs-coname{color:var(--header-text);font-family:"Oswald","Inter",sans-serif;font-weight:600;font-size:15px;white-space:nowrap}'
      + '@media (max-width:760px){.fs-cobrand .fs-coname{display:none}.fs-cobrand{margin-left:8px;padding-left:8px}}'
      // Save action: bigger + green, and a matching bar for the bottom-of-page Save.
      + '.btn.save{background:var(--good);border-color:var(--good);color:#fff;font-weight:600;padding:10px 22px;font-size:14px}'
      + '.btn.save:hover{filter:brightness(.94)}'
      + '.save-bottom-bar{display:flex;justify-content:flex-end;margin:24px 0 6px;padding-top:16px;border-top:1px solid var(--paper-line)}'
      // Theme (light/dark) toggle button in the header.
      + '.fs-theme-toggle{background:none;border:1px solid rgba(255,255,255,.28);color:var(--steel-light);border-radius:6px;padding:3px 10px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}'
      + '.fs-theme-toggle:hover{color:var(--header-text);border-color:rgba(255,255,255,.5)}'
      // Account dropdown (username → Manage Users / Change Password / Log Out) in the header.
      + '.nav-account .acctgroup{position:relative;display:inline-block}'
      + '.nav-account .acct-btn{background:none;border:none;color:var(--steel-light);font-family:"IBM Plex Mono",monospace;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;padding:2px 0;white-space:nowrap}'
      + '.nav-account .acct-btn:hover{color:var(--header-text)}'
      + '.nav-account .acct-menu{position:absolute;top:100%;right:0;margin-top:8px;min-width:210px;background:var(--surface);border:1px solid var(--paper-line);border-radius:6px;box-shadow:var(--shadow);padding:6px;display:none;flex-direction:column;z-index:130}'
      + '.nav-account .acctgroup.open .acct-menu{display:flex}'
      + '.nav-account .acct-menu a{display:block;color:var(--charcoal);padding:8px 12px;font-size:13px;border-radius:4px;text-decoration:none;white-space:nowrap;border:none;background:none;text-align:left;cursor:pointer;font-family:inherit}'
      + '.nav-account .acct-menu a:hover{background:var(--surface-2)}'
      + '.nav-account .acct-hdr{font-size:11px;color:var(--steel);padding:4px 12px 8px;border-bottom:1px solid var(--paper-line);margin-bottom:4px;white-space:nowrap}'
      + '.fs-modal{position:fixed;inset:0;background:rgba(10,20,35,.55);display:none;align-items:center;justify-content:center;z-index:200}'
      + '.fs-modal.open{display:flex}'
      + '.fs-modal .box{background:var(--surface);border-radius:8px;padding:22px;width:340px;max-width:92vw;box-shadow:var(--shadow)}'
      + '.fs-modal h3{font-family:"Oswald","Inter",sans-serif;margin:0 0 6px;color:var(--heading);font-size:18px}'
      + '.fs-modal label{display:block;font-size:12px;color:var(--steel);margin:10px 0 3px}'
      + '.fs-modal input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--paper-line);border-radius:6px;font-size:14px;font-family:inherit;background:var(--surface);color:var(--charcoal)}'
      + '.fs-modal .frow{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}'
      + '.fs-modal .fmsg{font-size:12.5px;margin-top:8px;min-height:16px}'
      + '.fs-modal .fmsg.err{color:var(--danger)}.fs-modal .fmsg.ok{color:var(--good)}'
      // Let the header wrap instead of pushing the account items (Employees/Company/Team/username)
      // off the right edge on medium-width windows. They drop to a second row and stay reachable.
      + 'header{flex-wrap:wrap;height:auto;min-height:52px;row-gap:4px;padding-top:6px;padding-bottom:6px}'
      + 'header nav{flex-wrap:wrap;row-gap:4px}'
      + '.nav-account{flex-wrap:wrap;row-gap:4px}';
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

    // Rebuilding the nav wiped the page's hardcoded "Owner" link (id="owner-nav"). Several pages do
    // `document.getElementById('owner-nav').style.display=''` for admins — with the element gone that
    // threw and left the page stuck on "Loading…". Re-add it (hidden); those pages reveal it by role.
    if (!nav.querySelector('#owner-nav')) {
      var on = document.createElement('a');
      on.id = 'owner-nav'; on.className = 'navtop navdirect'; on.href = '/admin.html';
      on.textContent = 'Owner'; on.style.display = 'none';
      if (location.pathname === '/admin.html') on.classList.add('active');
      nav.appendChild(on);
    }

    // The brand/logo (top-left) is the home button — click it to reach the company dashboard.
    document.querySelectorAll('header .brand, .topbar .brand').forEach(function (b) {
      b.style.cursor = 'pointer';
      b.title = 'Home — company dashboard';
      b.addEventListener('click', function () { location.href = '/home.html'; });
    });

    // Header shows only the five nav items. No account links, no username menu — Company, Team,
    // Employees and Change Password live on the Home page. Keep ONE Log Out in the top-right corner
    // of every page. Standard pages already have #logout-link; the takeoff topbar gets one added.
    var who = document.querySelector('header .who');
    if (who) who.style.display = 'none';                  // don't show the username in the header
    var pageLogout = document.getElementById('logout-link');
    if (pageLogout) {
      pageLogout.style.display = '';
    } else {
      var topbar = document.querySelector('.topbar');
      if (topbar && !document.getElementById('fs-logout')) {
        var lo = document.createElement('a');
        lo.href = '#'; lo.id = 'fs-logout'; lo.textContent = 'Log Out';
        lo.style.cssText = 'color:#B9C2CB;font-size:13px;text-decoration:none;white-space:nowrap;margin-left:14px;align-self:center';
        lo.addEventListener('click', function (e) { e.preventDefault(); logout(); });
        topbar.appendChild(lo);
      }
    }

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
    addThemeToggle();
    addTrainingLink(nav);
  }

  // Owner-only: surface the AI Training dashboard in the menu. Hidden for everyone else.
  function addTrainingLink(nav) {
    var t = getToken(); if (!t) return;
    fetch('/api/training/status', { headers: { 'Authorization': 'Bearer ' + t } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.enabled) return;
        if (nav.querySelector('a[href="/training.html"]')) return;
        var a = document.createElement('a');
        a.className = 'navtop navdirect' + (location.pathname === '/training.html' ? ' active' : '');
        a.href = '/training.html'; a.textContent = 'AI Training';
        nav.appendChild(a);
      }).catch(function () {});
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
    document.querySelectorAll('header .brand, .topbar .brand').forEach(function (b) {
      var c = b.cloneNode(true); if (b.parentNode) b.parentNode.replaceChild(c, b); // drop the home-click handler
      c.style.cursor = 'pointer'; c.addEventListener('click', function () { location.href = '/jobs.html'; });
    });
    addThemeToggle();
    if (!FIELD_OK[p]) location.replace('/jobs.html');
  }

  function logout() {
    try { localStorage.removeItem('fieldscale_token'); localStorage.removeItem('fieldscale_username'); } catch (e) {}
    location.href = '/';
  }

  // ---- Light / dark theme toggle (top-right of the header) ----
  function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  function applyTheme(m) {
    if (m === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('fs-theme', m); } catch (e) {}
    var b = document.getElementById('fs-theme-toggle');
    if (b) b.textContent = m === 'dark' ? '☀︎ Light' : '☾ Dark';
  }
  function addThemeToggle() {
    if (document.getElementById('fs-theme-toggle')) return;
    var btn = document.createElement('button');
    btn.id = 'fs-theme-toggle'; btn.className = 'fs-theme-toggle'; btn.type = 'button';
    btn.textContent = currentTheme() === 'dark' ? '☀︎ Light' : '☾ Dark';
    btn.addEventListener('click', function () { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); });
    var logout = document.getElementById('logout-link') || document.getElementById('fs-logout');
    if (logout && logout.parentNode) { logout.parentNode.insertBefore(btn, logout); btn.style.marginLeft = '14px'; }
    else { var h = document.querySelector('header') || document.querySelector('.topbar'); if (h) h.appendChild(btn); }
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

// ---- Offline field mode: PWA install + service worker + offline / sync-pending banner ----
// Injected from here so every app page (which all load app-nav.js) becomes installable and
// offline-capable without editing each page. Skipped on the public/no-login pages.
(function () {
  var PUBLIC_PAGES = /\/(welcome|accept|portal|lead-form|privacy)\.html$/;
  if (PUBLIC_PAGES.test(location.pathname)) return;

  // Head tags: manifest, theme colour, iOS home-screen icon + standalone hints.
  function addOnce(sel, make) { if (!document.head.querySelector(sel)) document.head.appendChild(make()); }
  addOnce('link[rel="manifest"]', function () { var l = document.createElement('link'); l.rel = 'manifest'; l.href = '/manifest.webmanifest'; return l; });
  addOnce('meta[name="theme-color"]', function () { var m = document.createElement('meta'); m.name = 'theme-color'; m.content = '#0E2A47'; return m; });
  addOnce('link[rel="apple-touch-icon"]', function () { var l = document.createElement('link'); l.rel = 'apple-touch-icon'; l.href = '/apple-touch-icon.png'; return l; });
  addOnce('meta[name="apple-mobile-web-app-capable"]', function () { var m = document.createElement('meta'); m.name = 'apple-mobile-web-app-capable'; m.content = 'yes'; return m; });
  addOnce('meta[name="apple-mobile-web-app-status-bar-style"]', function () { var m = document.createElement('meta'); m.name = 'apple-mobile-web-app-status-bar-style'; m.content = 'black-translucent'; return m; });

  var pending = 0;

  function bar() {
    var b = document.getElementById('fs-net-bar');
    if (!b) {
      b = document.createElement('div');
      b.id = 'fs-net-bar';
      b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;display:none;padding:9px 14px;'
        + 'font:500 13px "IBM Plex Sans",system-ui,sans-serif;color:#fff;text-align:center;box-shadow:0 -2px 10px rgba(14,42,71,.18)';
      document.body.appendChild(b);
    }
    return b;
  }
  function render() {
    var b = bar();
    var off = !navigator.onLine;
    if (!off && !pending) { b.style.display = 'none'; return; }
    b.style.display = 'block';
    if (off) {
      b.style.background = '#C25A1B';
      b.innerHTML = '&#128244; Offline — you can keep working; changes are saved on this device and sync when you’re back online.'
        + (pending ? ' <b>' + pending + ' waiting</b>' : '');
    } else {
      b.style.background = '#1B4B7A';
      b.innerHTML = '&#128260; ' + pending + ' change' + (pending > 1 ? 's' : '') + ' waiting to sync… '
        + '<button id="fs-sync-now" style="margin-left:8px;background:#fff;color:#1B4B7A;border:none;border-radius:4px;padding:3px 10px;font:600 12px inherit;cursor:pointer">Sync now</button>';
      var s = document.getElementById('fs-sync-now');
      if (s) s.onclick = flush;
    }
  }
  function flush() { if (navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'flush' }); }

  window.addEventListener('online', function () { render(); flush(); });
  window.addEventListener('offline', render);

  function boot() {
    render();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'fs-outbox') { pending = e.data.count; render(); }
      });
      // ask the worker for the current queued count once it's controlling
      navigator.serviceWorker.ready.then(function () { if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'count' }); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

// ---- Shared AI helper + result modal (used by the estimate/job/reports/home pages) ----
(function () {
  var css = '.fsai-ov{position:fixed;inset:0;background:rgba(14,42,71,.42);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px}'
    + '.fsai-card{background:#fff;border-radius:8px;max-width:580px;width:100%;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 14px 44px rgba(14,42,71,.35)}'
    + '.fsai-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #E4DFCF;font-family:Oswald,sans-serif;font-weight:600;color:#0E2A47;font-size:17px}'
    + '.fsai-x{background:none;border:none;font-size:22px;line-height:1;cursor:pointer;color:#7C8896}'
    + '.fsai-bd{padding:16px 18px;font-size:14px;line-height:1.55;color:#1C1E22;white-space:pre-wrap;overflow:auto}'
    + '.fsai-in{width:100%;box-sizing:border-box;border:1px solid #B9C2CB;border-radius:5px;padding:9px 11px;font:14px inherit;margin-bottom:10px;resize:vertical}'
    + '.fsai-ft{display:flex;gap:8px;justify-content:flex-end;padding:12px 18px;border-top:1px solid #E4DFCF;flex-wrap:wrap}'
    + '.fsai-btn{border:1px solid #B9C2CB;background:#fff;border-radius:5px;padding:8px 14px;font:600 13px inherit;cursor:pointer;color:#1C1E22}'
    + '.fsai-btn.primary{background:#E8722C;border-color:#E8722C;color:#fff}.fsai-btn:disabled{opacity:.5;cursor:default}'
    + '.fsai-spin{display:inline-block;width:15px;height:15px;border:2px solid #E4DFCF;border-top-color:#E8722C;border-radius:50%;animation:fsaispin .7s linear infinite;vertical-align:-2px}'
    + '@keyframes fsaispin{to{transform:rotate(360deg)}} .fsai-err{color:#C0392B}'
    + '.fsd-hint{margin:0 0 12px;color:#4A5763;font-size:13px;line-height:1.5}'
    + '.fsd-microw{display:flex;align-items:center;gap:10px;margin-bottom:10px}'
    + '.fsd-mic{border:1px solid #B9C2CB;background:#fff;border-radius:22px;padding:9px 16px;font:600 14px inherit;cursor:pointer;color:#1C1E22}'
    + '.fsd-mic.on{background:#C0392B;border-color:#C0392B;color:#fff;animation:fsdpulse 1.1s ease-in-out infinite}'
    + '@keyframes fsdpulse{0%,100%{box-shadow:0 0 0 0 rgba(192,57,43,.45)}50%{box-shadow:0 0 0 7px rgba(192,57,43,0)}}'
    + '.fsd-status{font-size:12px;color:#7C8896}'
    + '.fsd-text{width:100%;box-sizing:border-box;min-height:120px;border:1px solid #B9C2CB;border-radius:5px;padding:10px 12px;font:14px inherit;resize:vertical}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  window.fsAI = {
    async post(path, body) {
      var t = localStorage.getItem('fieldscale_token');
      var r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t }, body: JSON.stringify(body || {}) });
      var d; try { d = await r.json(); } catch (e) { d = {}; }
      if (!r.ok) throw new Error(d.error || 'AI request failed.');
      return d;
    },
    status() { return fetch('/api/ai/status').then(function (r) { return r.json(); }).catch(function () { return { enabled: false }; }); }
  };

  // Opens a modal, runs an async task, shows the text with Copy + an optional Insert button.
  window.fsAiRun = function (opts) {
    var ov = document.createElement('div'); ov.className = 'fsai-ov';
    ov.innerHTML = '<div class="fsai-card"><div class="fsai-hd"><span>' + (opts.title || 'AI') + '</span><button class="fsai-x" aria-label="Close">×</button></div>'
      + '<div class="fsai-bd" id="fsai-bd"><span class="fsai-spin"></span> ' + (opts.loading || 'Thinking…') + '</div>'
      + '<div class="fsai-ft" id="fsai-ft"></div></div>';
    document.body.appendChild(ov);
    function close() { ov.remove(); }
    ov.querySelector('.fsai-x').onclick = close;
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    var bd = ov.querySelector('#fsai-bd'), ft = ov.querySelector('#fsai-ft');
    Promise.resolve().then(opts.run).then(function (result) {
      var text = opts.render ? opts.render(result) : (result.text || '');
      bd.textContent = text;
      ft.innerHTML = '';
      function addBtn(label, primary, fn) { var b = document.createElement('button'); b.className = 'fsai-btn' + (primary ? ' primary' : ''); b.textContent = label; b.onclick = fn; ft.appendChild(b); return b; }
      addBtn('Copy', false, function () { try { navigator.clipboard.writeText(text); } catch (e) {} });
      if (opts.onInsert) addBtn(opts.insertLabel || 'Insert', true, function () { opts.onInsert(text, result); close(); });
      addBtn('Close', false, close);
    }).catch(function (err) {
      bd.innerHTML = '<span class="fsai-err">' + (err.message || 'Something went wrong.') + '</span>';
      ft.innerHTML = ''; var b = document.createElement('button'); b.className = 'fsai-btn'; b.textContent = 'Close'; b.onclick = close; ft.appendChild(b);
    });
  };

  // General-purpose modal: arbitrary HTML body + custom buttons. Reused for the new-vendor
  // confirm form, the submittal preview, etc. Each button gets (close, cardEl); returning
  // false from onClick keeps the modal open (e.g. to show a validation message).
  window.fsModal = function (opts) {
    var ov = document.createElement('div'); ov.className = 'fsai-ov';
    var card = document.createElement('div'); card.className = 'fsai-card';
    card.innerHTML = '<div class="fsai-hd"><span>' + (opts.title || '') + '</span><button class="fsai-x" aria-label="Close">×</button></div>'
      + '<div class="fsai-bd">' + (opts.bodyHTML || '') + '</div>'
      + '<div class="fsai-ft"></div>';
    ov.appendChild(card); document.body.appendChild(ov);
    function close() { ov.remove(); }
    card.querySelector('.fsai-x').onclick = close;
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    var ft = card.querySelector('.fsai-ft');
    (opts.buttons || [{ label: 'Close' }]).forEach(function (b) {
      var el = document.createElement('button'); el.className = 'fsai-btn' + (b.primary ? ' primary' : '');
      el.textContent = b.label;
      el.onclick = function () { if (b.onClick) { if (b.onClick(close, card) === false) return; } else { close(); } };
      ft.appendChild(el);
    });
    if (opts.onOpen) opts.onOpen(card, close);
    return card;
  };

  // Structured address helper (#7). Renders Street / City / State / ZIP, composes a single line
  // for storage & PDFs, restores from a stored object OR a legacy one-line string, and validates
  // "required only if started" (a partly-filled address is rejected; a blank one is allowed).
  window.fsAddr = {
    html: function (p) {
      return '<div class="fs-addr" data-addr="' + p + '">'
        + '<input id="' + p + '-street" placeholder="Street address" autocomplete="address-line1" style="width:100%;box-sizing:border-box;margin-bottom:6px">'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
        + '<input id="' + p + '-city" placeholder="City" autocomplete="address-level2" style="flex:2 1 120px;min-width:90px;box-sizing:border-box">'
        + '<input id="' + p + '-state" placeholder="State" autocomplete="address-level1" maxlength="20" style="flex:1 1 60px;min-width:50px;box-sizing:border-box">'
        + '<input id="' + p + '-zip" placeholder="ZIP" autocomplete="postal-code" maxlength="12" style="flex:1 1 70px;min-width:60px;box-sizing:border-box">'
        + '</div></div>';
    },
    set: function (p, val) {
      var g = function (s) { return document.getElementById(p + '-' + s); };
      var o = (val && typeof val === 'object') ? val : this.parse(val);
      if (g('street')) g('street').value = o.street || '';
      if (g('city')) g('city').value = o.city || '';
      if (g('state')) g('state').value = o.state || '';
      if (g('zip')) g('zip').value = o.zip || '';
    },
    // Best-effort split of a legacy one-line address ("123 Main St, Columbia, SC 29201") into parts,
    // so old records populate all four fields instead of dumping everything into Street.
    parse: function (str) {
      var out = { street: '', city: '', state: '', zip: '' };
      if (!str || typeof str !== 'string') return out;
      var parts = str.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!parts.length) return out;
      var last = parts[parts.length - 1];
      var m = last.match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);   // "SC 29201"
      if (m) { out.state = m[1]; out.zip = m[2]; parts.pop(); }
      else if (/^\d{5}(-\d{4})?$/.test(last)) { out.zip = last; parts.pop(); }
      else if (/^[A-Za-z]{2}$/.test(last)) { out.state = last; parts.pop(); }
      var gotStateZip = !!(out.state || out.zip);
      // A single remaining token is the city if we already pulled a state/zip (e.g. "Columbia, SC"),
      // otherwise treat it as the street (e.g. "789 Pine Rd" with no city/state given).
      if (parts.length >= 2 || (parts.length === 1 && gotStateZip)) out.city = parts.pop();
      out.street = parts.join(', ');
      return out;
    },
    parts: function (p) {
      var v = function (s) { var el = document.getElementById(p + '-' + s); return el ? String(el.value || '').trim() : ''; };
      return { street: v('street'), city: v('city'), state: v('state'), zip: v('zip') };
    },
    line: function (a) {
      if (!a) return '';
      if (typeof a === 'string') return a;
      var cityState = [a.city, a.state].filter(Boolean).join(', ');
      return [a.street, [cityState, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    },
    // '' when ok; an error message when partly filled. Blank (all empty) is allowed.
    validate: function (p) {
      var a = this.parts(p);
      var n = [a.street, a.city, a.state, a.zip].filter(Boolean).length;
      return (n === 0 || n === 4) ? '' : 'Please complete the full address — street, city, state and ZIP.';
    }
  };

  // Voice-to-form: a mic + free-text box that sends what was said/typed to the AI, which pulls
  // out the requested fields and hands them back for the page to fill in.
  // opts: { title, fields:[{key,label,hint}], onValues(values), onDone(count) }
  window.fsDictate = function (opts) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var supported = !!SR;
    var body = '<p class="fsd-hint">' + (supported
        ? 'Tap the mic and say the details out loud (name, phone, email, address, type of work, budget…). Edit if needed, then tap <b>Fill form</b>.'
        : 'Voice isn\'t available on this device. Type the details below (or use your keyboard\'s own mic), then tap <b>Fill form</b>.') + '</p>'
      + (supported ? '<div class="fsd-microw"><button type="button" class="fsd-mic" id="fsd-mic">🎤 Start talking</button><span class="fsd-status" id="fsd-status"></span></div>' : '')
      + '<textarea class="fsd-text" id="fsd-text" placeholder="What you say shows up here — you can also type or edit it."></textarea>';
    fsModal({
      title: opts.title || 'Dictate',
      bodyHTML: body,
      buttons: [
        { label: 'Cancel' },
        { label: 'Fill form', primary: true, onClick: function (close, card) {
            var ta = card.querySelector('#fsd-text');
            var transcript = (ta.value || '').trim();
            var status = card.querySelector('#fsd-status');
            if (!transcript) { if (status) status.textContent = 'Say or type something first.'; ta.focus(); return false; }
            var btn = card.querySelector('.fsai-btn.primary');
            btn.disabled = true; btn.textContent = 'Reading…';
            window.fsAI.post('/api/ai/parse-fields', { transcript: transcript, fields: opts.fields })
              .then(function (d) {
                var values = (d && d.values) || {};
                var n = 0; for (var k in values) { if (values[k] != null && String(values[k]).trim() !== '') n++; }
                try { if (opts.onValues) opts.onValues(values); } catch (e) {}
                close();
                if (opts.onDone) opts.onDone(n);
              })
              .catch(function (err) {
                btn.disabled = false; btn.textContent = 'Fill form';
                if (status) status.textContent = err.message || 'Something went wrong.';
              });
            return false; // keep the modal open until the request resolves
          } }
      ],
      onOpen: function (card) {
        if (!supported) { var ta0 = card.querySelector('#fsd-text'); if (ta0) ta0.focus(); return; }
        var ta = card.querySelector('#fsd-text'), mic = card.querySelector('#fsd-mic'), status = card.querySelector('#fsd-status');
        var rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
        var listening = false, base = '';
        rec.onresult = function (e) {
          var interim = '', finalT = '';
          for (var i = e.resultIndex; i < e.results.length; i++) {
            var r = e.results[i]; if (r.isFinal) finalT += r[0].transcript; else interim += r[0].transcript;
          }
          if (finalT) base = (base ? base + ' ' : '') + finalT.trim();
          ta.value = (base + (interim ? ' ' + interim : '')).trim();
        };
        rec.onerror = function (e) { status.textContent = (e.error === 'not-allowed' || e.error === 'service-not-allowed') ? 'Microphone blocked — allow it in your browser settings.' : ('Mic error: ' + e.error); stop(); };
        rec.onend = function () { if (listening) { try { rec.start(); } catch (e) {} } };
        function start() { base = (ta.value || '').trim(); listening = true; try { rec.start(); } catch (e) {} mic.textContent = '⏹ Stop'; mic.classList.add('on'); status.textContent = 'Listening…'; }
        function stop() { listening = false; try { rec.stop(); } catch (e) {} mic.textContent = '🎤 Start talking'; mic.classList.remove('on'); if (status.textContent === 'Listening…') status.textContent = ''; }
        mic.onclick = function () { listening ? stop() : start(); };
        // Make sure the mic is released no matter how the modal is closed (X, overlay click, button).
        var ov = card.parentNode;
        var mo = new MutationObserver(function () { if (!document.body.contains(ov)) { stop(); mo.disconnect(); } });
        if (ov) mo.observe(document.body, { childList: true });
      }
    });
  };
})();

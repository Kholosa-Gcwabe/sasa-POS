(() => {
  'use strict';

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.SASA_CONFIG;
  const EMAIL_DOMAIN = 'sasa.local'; // staff log in with a username; this maps it to an email for Supabase Auth
  const QR_PREFIX = 'SASA1.';
  const LAST_KEY = 'sasa_last_active';
  const MSG_KEY = 'sasa_msg';

  // The sign-in lives in sessionStorage, not localStorage: closing the tab or browser signs the
  // person out, so a shared till is never left signed in as the last user.
  const authStore = (() => {
    try { sessionStorage.setItem('_t', '1'); sessionStorage.removeItem('_t'); return sessionStorage; } catch { return undefined; }
  })();
  // Remove any long-lived sign-in left behind by the earlier version of the app
  try {
    Object.keys(localStorage).filter((k) => /^sb-.*-auth-token/.test(k)).forEach((k) => localStorage.removeItem(k));
  } catch { /* storage not available, nothing to clean */ }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storage: authStore, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => 'R' + Number(n || 0).toFixed(2);
  const cents = (n) => Math.round(Number(n || 0) * 100);
  const fmtTime = (d) => d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
  const fmtDateTime = (d) => new Date(d).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
  const minsBetween = (a, b) => (new Date(b) - new Date(a)) / 60000;
  const ago = (d) => { const m = Math.max(0, Math.round(minsBetween(d, new Date()))); return m < 1 ? 'just now' : `${m} min ago`; };
  const STATUS = { pending: 'Waiting', preparing: 'Preparing', ready: 'Ready', completed: 'Collected', cancelled: 'Cancelled' };
  const badge = (s) => `<span class="badge b-${s}">${STATUS[s] || s}</span>`;
  const TYPES = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };
  const METHODS = { cash: 'Cash', card: 'Card', eft: 'EFT' };
  const typeTag = (o) => `<span class="tag tag-${esc(o.order_type || 'dine_in')}">${esc(TYPES[o.order_type] || 'Dine-in')}${
    o.order_type === 'dine_in' && o.table_number ? ' · Table ' + esc(o.table_number) : ''}</span>`;
  const typeText = (o) => (TYPES[o.order_type] || 'Dine-in') + (o.order_type === 'dine_in' && o.table_number ? ' · Table ' + o.table_number : '');

  const DEFAULT_SETTINGS = {
    business_name: 'Sasa Restaurant', tagline: 'Authentic Cultures & Tastes', address: 'Khayelitsha',
    phone: '', vat_number: '', logo_url: 'logo.png', vat_enabled: true, vat_rate: 15,
    receipt_footer: 'Thank you for dining with us',
    idle_minutes_admin: 5, idle_minutes_cashier: 2, idle_minutes_chef: 15,
  };

  const S = {
    me: null,
    settings: { ...DEFAULT_SETTINGS },
    profiles: new Map(),
    menu: [],
    cart: new Map(),
    orderType: 'dine_in',
    view: null,
    channel: null,
    timer: null,
    refreshTimer: null,
    readyCount: 0,
  };
  const nameOf = (id) => S.profiles.get(id)?.full_name || '-';
  const vatRate = () => (S.settings.vat_enabled ? Number(S.settings.vat_rate) / 100 : 0);

  // Only allow a plain file path or an embedded image as the logo
  const safeLogo = (u) => (/^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+|[\w./-]+)$/.test(u || '') ? u : 'logo.png');

  // ---------- toasts and sound ----------
  function toast(msg, type = 'info', ms = 4000) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span>${esc(msg)}</span><button type="button" aria-label="Dismiss">×</button>`;
    el.querySelector('button').onclick = () => el.remove();
    $('#toasts').appendChild(el);
    if (ms) setTimeout(() => el.remove(), ms);
  }

  let audioCtx;
  function beep(times = 2) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.connect(g); g.connect(audioCtx.destination);
        o.frequency.value = 880; g.gain.value = 0.18;
        const t = audioCtx.currentTime + i * 0.32;
        o.start(t); o.stop(t + 0.2);
      }
    } catch { /* sound is a bonus, never block on it */ }
  }

  async function fnError(error) {
    try { const j = await error.context.json(); return j.error || error.message; } catch { return error.message; }
  }

  // ---------- modal ----------
  // sticky: clicking outside or pressing Escape does not close it (used where closing loses something)
  function openModal(html, { sticky = false } = {}) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    const onKey = (e) => { if (e.key === 'Escape' && !sticky) close(); };
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
    if (!sticky) back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    return { el: back.querySelector('.modal'), close };
  }

  // ---------- branding and settings ----------
  function applyBranding() {
    const s = S.settings;
    const logo = safeLogo(s.logo_url);
    $('#login-logo').src = logo;
    $('#brand-logo').src = logo;
    $('#login-title').textContent = s.business_name;
    $('#login-tagline').textContent = 'Staff sign in';
    $('#brand-name').textContent = s.business_name;
    document.title = `${s.business_name} POS`;
    const icon = document.querySelector('link[rel=icon]');
    if (icon) icon.href = logo;
  }

  async function loadSettings() {
    try {
      const { data } = await sb.from('settings').select('*').eq('id', 1).maybeSingle();
      if (data) S.settings = { ...DEFAULT_SETTINGS, ...data };
    } catch { /* older database without the settings table: keep defaults */ }
    applyBranding();
  }

  // ---------- auth ----------
  const NAV = {
    admin: [['overview', 'Overview'], ['orders', 'Orders'], ['reports', 'Reports'], ['staff', 'Staff'],
      ['menu', 'Menu'], ['settings', 'Settings'], ['activity', 'Activity']],
    cashier: [['pos', 'New order'], ['myorders', 'My orders']],
    chef: [['kitchen', 'Kitchen']],
  };

  function showLogin() {
    $('#app-screen').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    const username = $('#username').value.trim().toLowerCase();
    btn.disabled = true;
    const { data, error } = await sb.auth.signInWithPassword({
      email: `${username}@${EMAIL_DOMAIN}`,
      password: $('#password').value,
    });
    btn.disabled = false;
    if (error) {
      console.error(error);
      toast(/invalid login/i.test(error.message) ? 'Wrong username or password' : error.message, 'error', 6000);
      return;
    }
    await boot(data.user, 'login_password');
  });

  // ---------- QR sign-in ----------
  // The QR card holds a random code, never the password. The qr-login function checks it and
  // returns a one-time token, which we exchange for a normal session.
  async function loginWithQr(payload) {
    const { data, error } = await sb.functions.invoke('qr-login', { body: { token: payload } });
    if (error) throw new Error(await fnError(error));
    if (data?.error) throw new Error(data.error);
    let r = await sb.auth.verifyOtp({ token_hash: data.token_hash, type: 'magiclink' });
    if (r.error) r = await sb.auth.verifyOtp({ token_hash: data.token_hash, type: 'email' });
    if (r.error || !r.data?.user) throw new Error('Could not sign in with that QR card. Try again or type your login.');
    return r.data.user;
  }

  const scan = { stream: null, timer: null, busy: false, lastBad: 0 };
  const scanStatus = (msg, bad = false) => {
    const el = $('#scan-status');
    el.textContent = msg;
    el.classList.toggle('bad', bad);
  };

  function stopScan() {
    clearInterval(scan.timer);
    scan.timer = null;
    if (scan.stream) scan.stream.getTracks().forEach((t) => t.stop());
    scan.stream = null;
    const v = $('#scan-video');
    if (v) v.srcObject = null;
    $('#scan-box').classList.remove('live');
  }

  async function handleScanned(payload) {
    if (scan.busy) return;
    if (typeof payload !== 'string' || !payload.startsWith(QR_PREFIX)) {
      if (Date.now() - scan.lastBad > 2500) { scan.lastBad = Date.now(); scanStatus('That is not a Sasa staff QR card.', true); }
      return;
    }
    scan.busy = true;
    stopScan();
    scanStatus('Signing in...');
    try {
      const user = await loginWithQr(payload);
      await boot(user, 'login_qr');
    } catch (e) {
      toast(e.message, 'error', 6000);
      scanStatus('Hold your QR card up to the camera.');
      scan.busy = false;
      startScan();
    } finally {
      scan.busy = false;
    }
  }

  async function startScan() {
    stopScan();
    if (!window.jsQR) { scanStatus('The scanner could not load. Type your login instead.', true); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      scanStatus('The camera needs a secure (https) page. Scan from a photo instead, or type your login.', true);
      return;
    }
    try {
      try {
        scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch (e) {
        if (e && e.name === 'NotAllowedError') throw e;
        scan.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
    } catch (e) {
      scanStatus(e && e.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow it in the browser, or scan from a photo.'
        : 'No camera found. Scan from a photo, or type your login.', true);
      return;
    }
    const video = $('#scan-video');
    video.srcObject = scan.stream;
    try { await video.play(); } catch { /* autoplay hiccup, frames still arrive */ }
    $('#scan-box').classList.add('live');
    scanStatus('Hold your QR card up to the camera.');

    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true });
    scan.timer = setInterval(() => {
      if (scan.busy || video.readyState < 2 || !video.videoWidth) return;
      const k = Math.min(1, 520 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * k);
      canvas.height = Math.round(video.videoHeight * k);
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = g.getImageData(0, 0, canvas.width, canvas.height);
      const hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (hit && hit.data) handleScanned(hit.data.trim());
    }, 160);
  }

  // Fallback when the camera is unavailable: pick or take a photo of the card
  $('#scan-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!window.jsQR) { scanStatus('The scanner could not load. Type your login instead.', true); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1400 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const d = g.getImageData(0, 0, c.width, c.height);
      const hit = window.jsQR(d.data, d.width, d.height);
      if (hit && hit.data) handleScanned(hit.data.trim());
      else scanStatus('No QR code found in that photo. Try again with the whole card in view.', true);
    };
    img.onerror = () => { URL.revokeObjectURL(url); scanStatus('Could not read that image.', true); };
    img.src = url;
  });
  $('#scan-start').addEventListener('click', startScan);

  function setLoginMode(mode) {
    $('#login-mode').querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#login-form').classList.toggle('hidden', mode !== 'type');
    $('#scan-panel').classList.toggle('hidden', mode !== 'scan');
    if (mode === 'scan') startScan(); else { stopScan(); $('#username').focus(); }
  }
  $('#login-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b) setLoginMode(b.dataset.mode);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopScan(); });

  // ---------- sign out and inactivity timeout ----------
  // If nobody touches the screen for a while, the person is signed out. The next person has to
  // sign in as themselves (type or scan), and the half-built order on screen is cleared.
  const WARN_SECS = 15;
  const idle = { timer: null, warnEl: null, lastActive: Date.now(), ending: false };

  const persistActive = () => { try { sessionStorage.setItem(LAST_KEY, String(idle.lastActive)); } catch { /* ignore */ } };
  const idleLimitMs = () => {
    const mins = Number(S.settings[`idle_minutes_${S.me?.role}`]);
    return mins > 0 ? mins * 60000 : 0;
  };

  function onActivity() {
    if (!S.me || idle.warnEl) return; // while the warning is up, only its button counts
    const now = Date.now();
    if (now - idle.lastActive < 1000) return;
    idle.lastActive = now;
    persistActive();
  }
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((t) =>
    window.addEventListener(t, onActivity, { capture: true, passive: true }));

  function hideWarn() {
    if (idle.warnEl) { idle.warnEl.remove(); idle.warnEl = null; }
  }

  function showWarn(secs) {
    if (!idle.warnEl) {
      const el = document.createElement('div');
      el.className = 'modal-back';
      el.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true">
        <h3>Still there?</h3>
        <p>For security you will be signed out in <b id="warn-s">${secs}</b> seconds because the screen has been idle.</p>
        <div class="actions end">
          <button type="button" class="btn btn-outline" id="warn-out">Sign out now</button>
          <button type="button" class="btn btn-primary btn-lg" id="warn-stay">I am still here</button>
        </div></div>`;
      document.body.appendChild(el);
      idle.warnEl = el;
      $('#warn-stay', el).onclick = () => { idle.lastActive = Date.now(); persistActive(); hideWarn(); };
      $('#warn-out', el).onclick = () => signOutNow('logout');
      $('#warn-stay', el).focus();
    }
    $('#warn-s', idle.warnEl).textContent = secs;
  }

  function idleTick() {
    if (!S.me || idle.ending) return;
    const limit = idleLimitMs();
    if (!limit) { hideWarn(); return; }
    const left = limit - (Date.now() - idle.lastActive);
    if (left <= 0) signOutNow('auto_logout');
    else if (left <= WARN_SECS * 1000) showWarn(Math.ceil(left / 1000));
    else hideWarn();
  }

  function startIdleWatch(fresh) {
    clearInterval(idle.timer);
    const saved = Number(sessionStorage.getItem(LAST_KEY));
    // A fresh sign-in starts the clock now. A restored session (page reload) keeps its old clock,
    // so reloading the page does not give a stranger a fresh window at someone else's till.
    idle.lastActive = !fresh && saved > 0 ? saved : Date.now();
    persistActive();
    idle.ending = false;
    idle.timer = setInterval(idleTick, 1000);
    idleTick();
  }

  async function signOutNow(event) {
    if (idle.ending) return;
    idle.ending = true;
    clearInterval(idle.timer);
    hideWarn();
    stopScan();
    if (event === 'auto_logout') { try { sessionStorage.setItem(MSG_KEY, 'timeout'); } catch { /* ignore */ } }
    // Record it, but never let a slow network keep someone signed in
    try {
      await Promise.race([
        Promise.resolve(sb.rpc('log_session_event', { p_event: event })).catch(() => {}),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    } catch { /* ignore */ }
    try { await sb.auth.signOut({ scope: 'local' }); } catch { /* ignore */ }
    try { sessionStorage.removeItem(LAST_KEY); } catch { /* ignore */ }
    location.reload();
  }

  $('#logout').addEventListener('click', () => signOutNow('logout'));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) idleTick(); });

  sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT' && S.me && !idle.ending) location.reload(); });

  async function boot(user, method) {
    const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (!profile || !profile.active) {
      await sb.auth.signOut();
      toast('This account is not active. Please ask the admin.', 'error', 6000);
      showLogin();
      return;
    }
    S.me = profile;
    const { data: all } = await sb.from('profiles').select('*');
    S.profiles = new Map((all || []).map((p) => [p.id, p]));

    $('#login-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    $('#who').innerHTML = `${esc(profile.full_name)}<span class="role-pill">${esc(profile.role)}</span>`;
    $('#password').value = '';
    stopScan();

    await loadSettings(); // signed in now, so this also picks up this restaurant's timeout settings
    startIdleWatch(!!method);
    if (method) Promise.resolve(sb.rpc('log_session_event', { p_event: method })).catch(() => {});
    subscribe();
    updateReadyBadge();
    go(NAV[profile.role][0][0]);
  }

  // ---------- navigation ----------
  function renderNav() {
    $('#nav').innerHTML = NAV[S.me.role].map(([id, label]) => `
      <button class="nav-btn ${S.view === id ? 'active' : ''}" data-view="${id}" type="button">
        ${label}${id === 'myorders' ? `<span class="nav-badge ${S.readyCount ? '' : 'hidden'}" id="ready-badge">${S.readyCount}</span>` : ''}
      </button>`).join('');
    $('#nav').querySelectorAll('[data-view]').forEach((b) => b.onclick = () => go(b.dataset.view));
  }

  const LIVE_VIEWS = ['kitchen', 'myorders', 'overview', 'orders'];

  async function go(view) {
    S.view = view;
    renderNav();
    clearInterval(S.timer);
    await runView();
    if (LIVE_VIEWS.includes(view)) S.timer = setInterval(runView, 20000); // fallback if realtime drops
  }

  async function runView() {
    try { await views[S.view](); }
    catch (e) { $('#view').innerHTML = `<div class="empty">Something went wrong: ${esc(e.message)}</div>`; }
  }

  function scheduleRefresh() {
    if (!LIVE_VIEWS.includes(S.view)) return;
    clearTimeout(S.refreshTimer);
    S.refreshTimer = setTimeout(runView, 300);
  }

  async function updateReadyBadge() {
    if (S.me?.role !== 'cashier') return;
    const { count } = await sb.from('orders').select('id', { count: 'exact', head: true })
      .eq('cashier_id', S.me.id).eq('status', 'ready');
    S.readyCount = count || 0;
    const el = $('#ready-badge');
    if (el) { el.textContent = S.readyCount; el.classList.toggle('hidden', !S.readyCount); }
  }

  // ---------- realtime ----------
  function subscribe() {
    S.channel = sb.channel('orders-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        const o = payload.new || {};
        if (S.me.role === 'chef' && payload.eventType === 'INSERT') {
          toast(`New order #${o.order_number} (${typeText(o)})`, 'info', 6000);
          beep(2);
        }
        if (S.me.role === 'cashier' && payload.eventType === 'UPDATE'
            && o.status === 'ready' && o.cashier_id === S.me.id) {
          toast(`Order #${o.order_number} is READY. Please collect it from the kitchen.`, 'ready', 0);
          beep(3);
        }
        updateReadyBadge();
        scheduleRefresh();
      })
      .subscribe((status) => { if (status === 'SUBSCRIBED') scheduleRefresh(); });
  }

  // ---------- data ----------
  async function loadMenu() {
    const { data, error } = await sb.from('menu_items').select('*').eq('available', true)
      .order('category').order('name');
    if (error) throw error;
    S.menu = data;
  }

  async function fetchOrders({ since, until, statuses, ascending = false, limit = 300 } = {}) {
    let q = sb.from('orders').select('*, order_items(*)').order('created_at', { ascending }).limit(limit);
    if (since) q = q.gte('created_at', since);
    if (until) q = q.lt('created_at', until);
    if (statuses) q = q.in('status', statuses);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  // Supabase returns at most 1000 rows per request, so page through for reports
  async function fetchAllOrders(since, until) {
    const out = [];
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await sb.from('orders').select('*, order_items(*)')
        .gte('created_at', since).lt('created_at', until)
        .order('created_at', { ascending: true }).range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }

  async function getOrder(id) {
    const { data, error } = await sb.from('orders').select('*, order_items(*)').eq('id', id).single();
    if (error) throw error;
    return data;
  }

  function bindStatusButtons() {
    $('#view').querySelectorAll('[data-act="status"]').forEach((b) => {
      b.onclick = async () => {
        const to = b.dataset.to;
        if (to === 'cancelled' && !confirm('Cancel this order?')) return;
        b.disabled = true;
        const { error } = await sb.from('orders').update({ status: to }).eq('id', b.dataset.id);
        if (error) toast(error.message, 'error');
        else if (to === 'ready') toast('Cashier alerted', 'success', 2500);
        updateReadyBadge();
        await runView();
      };
    });
    $('#view').querySelectorAll('[data-act="pay"]').forEach((b) => b.onclick = () => openPayment(b.dataset.id));
    $('#view').querySelectorAll('[data-act="receipt"]').forEach((b) => b.onclick = () => printReceipt(b.dataset.id));
  }

  const itemsList = (o) => `<ul>${o.order_items.map((i) => `<li><b>${i.quantity}×</b> ${esc(i.name)}</li>`).join('')}</ul>`;

  // ---------- payment ----------
  async function openPayment(orderId) {
    let order;
    try { order = await getOrder(orderId); } catch (e) { toast(e.message, 'error'); return; }
    if (order.status !== 'ready') { toast('This order is not ready to hand over.', 'error'); runView(); return; }

    const total = Number(order.total);
    const quick = [...new Set([total, ...[10, 50, 100, 200].map((n) => Math.ceil(total / n) * n)])]
      .filter((v) => v >= total).slice(0, 5);

    const m = openModal(`
      <h3>Take payment</h3>
      <div class="pay-total"><span>Order #${order.order_number} · ${esc(typeText(order))}</span><b>${money(total)}</b></div>
      <div class="seg" id="pay-methods">
        ${Object.entries(METHODS).map(([k, v]) => `<button type="button" data-m="${k}" class="${k === 'cash' ? 'on' : ''}">${v}</button>`).join('')}
      </div>
      <div id="cash-box">
        <label>Cash received<input id="tender" type="number" min="0" step="0.01" inputmode="decimal"></label>
        <div class="quick">${quick.map((v) => `<button type="button" class="btn btn-outline btn-sm" data-q="${v}">${v === total ? 'Exact' : money(v)}</button>`).join('')}</div>
        <div id="change" class="change"></div>
      </div>
      <div class="actions end">
        <button type="button" class="btn btn-outline" id="pay-cancel">Cancel</button>
        <button type="button" class="btn btn-ok btn-lg" id="pay-confirm" disabled>Confirm payment</button>
      </div>`);

    let method = 'cash';
    const tender = $('#tender', m.el);
    const confirmBtn = $('#pay-confirm', m.el);
    const refresh = () => {
      $('#cash-box', m.el).classList.toggle('hidden', method !== 'cash');
      const got = cents(tender.value);
      const enough = got >= cents(total);
      $('#change', m.el).innerHTML = method === 'cash' && tender.value !== ''
        ? (enough ? `Change due <b>${money((got - cents(total)) / 100)}</b>` : '<span class="bad">Not enough cash</span>') : '';
      confirmBtn.disabled = method === 'cash' ? !enough : false;
    };
    m.el.querySelectorAll('#pay-methods [data-m]').forEach((b) => b.onclick = () => {
      method = b.dataset.m;
      m.el.querySelectorAll('#pay-methods [data-m]').forEach((x) => x.classList.toggle('on', x === b));
      refresh();
    });
    m.el.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => { tender.value = Number(b.dataset.q).toFixed(2); refresh(); });
    tender.oninput = refresh;
    $('#pay-cancel', m.el).onclick = m.close;
    tender.focus();
    refresh();

    confirmBtn.onclick = async () => {
      confirmBtn.disabled = true;
      const given = method === 'cash' ? parseFloat(tender.value) : null;
      const { error } = await sb.rpc('complete_order', { p_order_id: orderId, p_method: method, p_tendered: given });
      if (error) { toast(error.message, 'error', 6000); confirmBtn.disabled = false; return; }
      const change = method === 'cash' ? (cents(given) - cents(total)) / 100 : 0;
      m.el.innerHTML = `
        <div class="paid">
          <div class="tick">✓</div>
          <h3>Paid · ${esc(METHODS[method])}</h3>
          <p class="big">${money(total)}</p>
          ${method === 'cash' ? `<p class="change">Change due <b>${money(change)}</b></p>` : ''}
          <div class="actions end">
            <button type="button" class="btn btn-outline" id="p-print">Print receipt</button>
            <button type="button" class="btn btn-primary" id="p-done">Done</button>
          </div>
        </div>`;
      $('#p-print', m.el).onclick = () => printReceipt(orderId);
      $('#p-done', m.el).onclick = m.close;
      updateReadyBadge();
      runView();
    };
  }

  // ---------- QR card ----------
  const loadImage = (src) => new Promise((resolve) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => resolve(null);
    i.src = src;
  });

  // Draws a printable staff card: logo, name, role and the QR code.
  async function drawCard({ name, role, username, token }) {
    if (!window.qrcode) throw new Error('The QR generator could not load. Check your internet and refresh.');
    const qr = window.qrcode(0, 'M');
    qr.addData(QR_PREFIX + token);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    const cell = Math.floor(440 / (n + quiet * 2)); // whole pixels per square keeps it sharp
    const side = cell * (n + quiet * 2);

    const W = 600, H = 900;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const font = (w, px) => `${w} ${px}px Nunito, system-ui, sans-serif`;
    const rrect = (x, y, w, h, r) => { if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
    try { await document.fonts.load(font(800, 30)); } catch { /* fall back to the system font */ }

    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);

    // header
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, '#A63F03'); grad.addColorStop(1, '#FF914D');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, 170);
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(95, 85, 62, 0, Math.PI * 2); g.fill();
    const logo = await loadImage(safeLogo(S.settings.logo_url));
    if (logo) {
      g.save();
      g.beginPath(); g.arc(95, 85, 58, 0, Math.PI * 2); g.clip();
      g.drawImage(logo, 37, 27, 116, 116);
      g.restore();
    }
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    const fit = (text, weight, px, maxW) => {
      let s = px;
      g.font = font(weight, s);
      while (g.measureText(text).width > maxW && s > 14) { s -= 2; g.font = font(weight, s); }
    };
    fit(S.settings.business_name, 800, 38, W - 200);
    g.fillText(S.settings.business_name, 180, 88);
    g.font = font(600, 22);
    g.fillText('Staff sign-in card', 180, 124);

    // who it belongs to
    g.textAlign = 'center';
    g.fillStyle = '#1F2937';
    fit(name, 800, 44, W - 70);
    g.fillText(name, W / 2, 245);
    g.fillStyle = '#6B7280';
    g.font = font(600, 24);
    g.fillText('@' + username, W / 2, 285);

    const label = role.charAt(0).toUpperCase() + role.slice(1);
    g.font = font(800, 22);
    const pw = g.measureText(label).width + 44;
    g.fillStyle = '#FDF8F4';
    g.beginPath(); rrect((W - pw) / 2, 305, pw, 40, 20); g.fill();
    g.fillStyle = '#A63F03';
    g.fillText(label, W / 2, 333);

    // QR code, black on white with a full quiet zone so cameras read it easily
    const x0 = Math.round((W - side) / 2), y0 = 365;
    g.fillStyle = '#fff';
    g.fillRect(x0, y0, side, side);
    g.fillStyle = '#000';
    for (let r = 0; r < n; r++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(r, col)) g.fillRect(x0 + (col + quiet) * cell, y0 + (r + quiet) * cell, cell, cell);
      }
    }

    g.fillStyle = '#1F2937';
    g.font = font(800, 32);
    g.fillText('Scan to sign in', W / 2, y0 + side + 50);
    g.fillStyle = '#6B7280';
    g.font = font(600, 19);
    g.fillText('Keep this card private. Anyone who has it can sign in as you.', W / 2, y0 + side + 88);
    g.fillText('Lost it? Ask the admin for a new one.', W / 2, y0 + side + 114);

    g.strokeStyle = '#E5E7EB';
    g.lineWidth = 3;
    g.beginPath(); rrect(1.5, 1.5, W - 3, H - 3, 22); g.stroke();
    return c;
  }

  // Shows the card once, with download and print. The code is not stored anywhere, so closing
  // this window without saving means a new card has to be issued.
  async function showCard(info) {
    let canvas;
    try { canvas = await drawCard(info); } catch (e) { toast(e.message, 'error', 6000); return; }
    canvas.className = 'qr-card';
    let saved = false;
    const m = openModal(`
      <h3>QR card for ${esc(info.name)}</h3>
      <div id="qr-slot"></div>
      <p class="muted small">Download or print this card now and hand it to ${esc(info.name)}. For safety it is shown only once. If it is lost, make a new card and the old one stops working.</p>
      <div class="actions end">
        <button type="button" class="btn btn-outline" id="qr-print">Print</button>
        <button type="button" class="btn btn-primary" id="qr-dl">Download PNG</button>
        <button type="button" class="btn btn-outline" id="qr-done">Done</button>
      </div>`, { sticky: true });
    $('#qr-slot', m.el).appendChild(canvas);

    $('#qr-dl', m.el).onclick = () => canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `sasa-card-${info.username}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      saved = true;
    }, 'image/png');
    $('#qr-print', m.el).onclick = () => {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>Staff card</title>
        <style>@page{margin:12mm}body{margin:0;text-align:center}img{width:90mm;height:auto}</style></head>
        <body><img src="${canvas.toDataURL('image/png')}" alt=""></body></html>`;
      frame.onload = () => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); saved = true; }
        catch { toast('Could not open the print dialog', 'error'); }
        setTimeout(() => frame.remove(), 60000);
      };
      document.body.appendChild(frame);
    };
    $('#qr-done', m.el).onclick = () => {
      if (!saved && !confirm('You have not downloaded or printed this card yet. It cannot be shown again. Close anyway?')) return;
      m.close();
    };
  }

  // ---------- receipt ----------
  async function printReceipt(orderId) {
    let o;
    try { o = await getOrder(orderId); } catch (e) { toast(e.message, 'error'); return; }
    const s = S.settings;
    const line = (l, r, cls = '') => `<div class="row ${cls}"><span>${l}</span><span>${r}</span></div>`;
    const when = new Date(o.paid_at || o.created_at).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const paid = o.payment_method ? [
      '<hr>',
      line('Paid by', esc(METHODS[o.payment_method] || o.payment_method)),
      o.payment_method === 'cash' && o.amount_tendered !== null ? line('Cash received', money(o.amount_tendered)) : '',
      o.payment_method === 'cash' && o.amount_tendered !== null ? line('Change', money(Number(o.amount_tendered) - Number(o.total))) : '',
    ].join('') : '';

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Receipt #${o.order_number}</title>
      <style>
        @page { size: 80mm auto; margin: 4mm; }
        body { font-family: 'Courier New', monospace; font-size: 12px; width: 72mm; margin: 0 auto; color: #000; }
        img.logo { display: block; margin: 0 auto 4px; width: 26mm; height: 26mm; }
        h1 { font-size: 15px; text-align: center; margin: 2px 0; }
        .c { text-align: center; }
        .row { display: flex; justify-content: space-between; gap: 6px; padding: 1px 0; }
        hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
        .tot { font-weight: bold; font-size: 14px; }
      </style></head><body>
      <img class="logo" src="${esc(safeLogo(s.logo_url))}" alt="">
      <h1>${esc(s.business_name)}</h1>
      <div class="c">${esc(s.address)}${s.phone ? '<br>Tel ' + esc(s.phone) : ''}${s.vat_number ? '<br>VAT No ' + esc(s.vat_number) : ''}</div>
      <hr>
      ${line('Order', '#' + o.order_number)}
      ${line('Date', esc(when))}
      ${line('Type', esc(typeText(o)))}
      ${line('Served by', esc(nameOf(o.cashier_id)))}
      ${o.customer_name ? line('Customer', esc(o.customer_name)) : ''}
      <hr>
      ${o.order_items.map((i) => line(`${i.quantity} x ${esc(i.name)}`, money(Number(i.price) * i.quantity))).join('')}
      <hr>
      ${line('Subtotal', money(o.subtotal))}
      ${Number(o.vat) > 0 ? line(`VAT (${Number(s.vat_rate)}%)`, money(o.vat)) : ''}
      ${line('TOTAL', money(o.total), 'tot')}
      ${paid}
      <hr>
      <div class="c">${esc(s.receipt_footer)}</div>
      </body></html>`;

    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc = html;
    frame.onload = () => {
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      catch { toast('Could not open the print dialog', 'error'); }
      setTimeout(() => frame.remove(), 60000);
    };
    document.body.appendChild(frame);
  }

  // ---------- CSV ----------
  function csvCell(v) {
    let t = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // stop spreadsheet formulas from names or notes
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function downloadCsv(filename, rows) {
    const text = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- views ----------
  const views = {};

  // ===== Cashier: new order =====
  views.pos = async () => {
    await loadMenu();
    const cats = [...new Set(S.menu.map((i) => i.category))];
    $('#view').innerHTML = `
      <div class="pos">
        <div>
          ${cats.length ? cats.map((c) => `
            <h3 class="cat">${esc(c)}</h3>
            <div class="grid">${S.menu.filter((i) => i.category === c).map((i) => `
              <button class="item" type="button" data-id="${i.id}"><b>${esc(i.name)}</b><span>${money(i.price)}</span></button>`).join('')}
            </div>`).join('') : '<div class="empty">No menu items yet. Ask the admin to add some.</div>'}
        </div>
        <aside class="card cart">
          <h3>Current order</h3>
          <div class="seg" id="otype">
            ${Object.entries(TYPES).map(([k, v]) => `<button type="button" data-t="${k}" class="${S.orderType === k ? 'on' : ''}">${v}</button>`).join('')}
          </div>
          <label id="table-wrap" class="${S.orderType === 'dine_in' ? '' : 'hidden'}">Table number (optional)<input id="table" maxlength="20" inputmode="text"></label>
          <div id="cart-lines" class="cart-lines"></div>
          <div class="totals" id="cart-totals"></div>
          <label><span id="cust-label"></span><input id="cust" maxlength="60"></label>
          <label>Kitchen notes (optional)<textarea id="notes" rows="2" maxlength="200"></textarea></label>
          <button id="place" class="btn btn-primary btn-lg btn-block" type="button" disabled>Send to kitchen</button>
          <button id="clear" class="btn btn-outline btn-block" type="button">Clear</button>
        </aside>
      </div>`;

    const setType = (t) => {
      S.orderType = t;
      $('#otype').querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
      $('#table-wrap').classList.toggle('hidden', t !== 'dine_in');
      $('#cust-label').textContent = t === 'delivery' ? 'Customer name and phone (required)'
        : t === 'takeaway' ? 'Customer name (optional)' : 'Customer name (optional)';
    };
    $('#otype').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) setType(b.dataset.t); };
    setType(S.orderType);

    $('#view').querySelectorAll('.item').forEach((b) => b.onclick = () => {
      S.cart.set(b.dataset.id, (S.cart.get(b.dataset.id) || 0) + 1);
      renderCart();
    });
    $('#cart-lines').onclick = (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const q = (S.cart.get(b.dataset.id) || 0) + (b.dataset.act === 'inc' ? 1 : -1);
      if (q <= 0) S.cart.delete(b.dataset.id); else S.cart.set(b.dataset.id, Math.min(q, 50));
      renderCart();
    };
    $('#clear').onclick = () => { S.cart.clear(); renderCart(); };
    $('#place').onclick = placeOrder;
    renderCart();
  };

  function renderCart() {
    const lines = [...S.cart]
      .map(([id, q]) => ({ item: S.menu.find((m) => m.id === id), q }))
      .filter((l) => l.item);
    S.cart = new Map(lines.map((l) => [l.item.id, l.q]));

    let sub = 0;
    $('#cart-lines').innerHTML = lines.length ? lines.map(({ item, q }) => {
      sub += item.price * q;
      return `<div class="line">
        <div>${esc(item.name)}<br><small class="muted">${money(item.price)} each</small></div>
        <div class="qty">
          <button type="button" data-act="dec" data-id="${item.id}">−</button><b>${q}</b>
          <button type="button" data-act="inc" data-id="${item.id}">+</button>
        </div></div>`;
    }).join('') : '<p class="muted">Tap items to add them.</p>';

    const vat = Math.round(sub * vatRate() * 100) / 100;
    $('#cart-totals').innerHTML = `
      ${vatRate() ? `<div><span>Subtotal</span><span>${money(sub)}</span></div>
      <div><span>VAT (${Number(S.settings.vat_rate)}%)</span><span>${money(vat)}</span></div>` : ''}
      <div class="grand"><span>Total</span><span>${money(sub + vat)}</span></div>`;
    $('#place').disabled = !lines.length;
  }

  async function placeOrder() {
    const btn = $('#place');
    if (S.orderType === 'delivery' && !$('#cust').value.trim()) {
      toast('Add the customer name and phone for a delivery', 'error');
      $('#cust').focus();
      return;
    }
    btn.disabled = true;
    const items = [...S.cart].map(([menu_item_id, quantity]) => ({ menu_item_id, quantity }));
    const { data, error } = await sb.rpc('create_order', {
      p_items: items,
      p_customer: $('#cust').value,
      p_notes: $('#notes').value,
      p_order_type: S.orderType,
      p_table: S.orderType === 'dine_in' ? $('#table').value : null,
    });
    if (error) { toast(error.message, 'error', 6000); btn.disabled = false; return; }
    S.cart.clear();
    toast(`Order #${data.order_number} sent to the kitchen`, 'success');
    views.pos();
  }

  // ===== Cashier: my orders =====
  views.myorders = async () => {
    const [today, active] = await Promise.all([
      fetchOrders({ since: startOfDay().toISOString() }),
      fetchOrders({ statuses: ['pending', 'preparing', 'ready'] }),
    ]);
    const map = new Map();
    [...active, ...today].forEach((o) => map.set(o.id, o));
    const mine = [...map.values()].filter((o) => o.cashier_id === S.me.id)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const ready = mine.filter((o) => o.status === 'ready');
    const cooking = mine.filter((o) => ['pending', 'preparing'].includes(o.status));
    const done = mine.filter((o) => ['completed', 'cancelled'].includes(o.status)).reverse();

    const card = (o) => `
      <div class="order ${o.status} ${o.status === 'ready' ? 'flash' : ''}">
        <div class="order-head"><b>#${o.order_number}</b>${badge(o.status)}</div>
        <div class="order-meta">${typeTag(o)} ${o.customer_name ? esc(o.customer_name) + ' · ' : ''}${ago(o.created_at)} · ${money(o.total)}${
          o.payment_method ? ' · ' + esc(METHODS[o.payment_method]) : ''}</div>
        ${itemsList(o)}
        <div class="actions">
          ${o.status === 'ready' ? `<button class="btn btn-ok" data-act="pay" data-id="${o.id}">Hand over and take payment</button>` : ''}
          ${['pending', 'preparing'].includes(o.status) ? `<button class="btn btn-outline btn-sm" data-act="status" data-id="${o.id}" data-to="cancelled">Cancel</button>` : ''}
          ${o.status === 'completed' ? `<button class="btn btn-outline btn-sm" data-act="receipt" data-id="${o.id}">Receipt</button>` : ''}
        </div>
      </div>`;
    const section = (title, list, empty) => `
      <div class="col"><h3>${title}<span class="count">${list.length}</span></h3>
      <div class="stack">${list.map(card).join('') || `<div class="empty">${empty}</div>`}</div></div>`;

    $('#view').innerHTML = `
      <h2 class="title">My orders</h2>
      <div class="cols">
        ${section('Ready to collect', ready, 'Nothing ready yet')}
        ${section('In the kitchen', cooking, 'No orders cooking')}
        ${section('Done today', done.slice(0, 15), 'Nothing finished yet')}
      </div>`;
    bindStatusButtons();
  };

  // ===== Chef: kitchen =====
  views.kitchen = async () => {
    const orders = await fetchOrders({ statuses: ['pending', 'preparing', 'ready'], ascending: true });
    const card = (o) => `
      <div class="order ${o.status}">
        <div class="order-head"><b>#${o.order_number}</b><span class="muted">${ago(o.created_at)}</span></div>
        <div class="order-meta">${typeTag(o)} ${o.customer_name ? esc(o.customer_name) + ' · ' : ''}Cashier: ${esc(nameOf(o.cashier_id))}</div>
        ${itemsList(o)}
        ${o.notes ? `<div class="note">📝 ${esc(o.notes)}</div>` : ''}
        <div class="actions">
          ${o.status === 'pending' ? `<button class="btn btn-blue btn-lg" data-act="status" data-id="${o.id}" data-to="preparing">Start preparing</button>` : ''}
          ${o.status === 'preparing' ? `<button class="btn btn-ok btn-lg" data-act="status" data-id="${o.id}" data-to="ready">Ready: alert cashier</button>` : ''}
          ${o.status === 'ready' ? `<span class="muted">Waiting for ${esc(nameOf(o.cashier_id))} to collect</span>` : ''}
        </div>
      </div>`;
    const col = (status, title) => {
      const list = orders.filter((o) => o.status === status);
      return `<div class="col"><h3>${title}<span class="count">${list.length}</span></h3>
        <div class="stack">${list.map(card).join('') || '<div class="empty">None</div>'}</div></div>`;
    };
    $('#view').innerHTML = `<h2 class="title">Kitchen</h2>
      <div class="cols">${col('pending', 'New')}${col('preparing', 'Preparing')}${col('ready', 'Ready for pickup')}</div>`;
    bindStatusButtons();
  };

  // ===== Admin: overview (who did what today) =====
  views.overview = async () => {
    const orders = await fetchOrders({ since: startOfDay().toISOString(), limit: 1000 });
    const paid = orders.filter((o) => o.status === 'completed');
    const sales = paid.reduce((s, o) => s + Number(o.total), 0);
    const active = orders.filter((o) => ['pending', 'preparing', 'ready'].includes(o.status)).length;
    const timed = orders.filter((o) => o.ready_at);
    const avg = timed.length ? timed.reduce((s, o) => s + minsBetween(o.created_at, o.ready_at), 0) / timed.length : null;
    const byMethod = (m) => paid.filter((o) => o.payment_method === m).reduce((s, o) => s + Number(o.total), 0);

    const rows = [...S.profiles.values()].filter((p) => p.active).map((p) => {
      const taken = orders.filter((o) => o.cashier_id === p.id && o.status !== 'cancelled');
      const prepared = orders.filter((o) => o.chef_id === p.id);
      const prepTimed = prepared.filter((o) => o.ready_at);
      const handed = orders.filter((o) => o.completed_by === p.id);
      const pAvg = prepTimed.length ? prepTimed.reduce((s, o) => s + minsBetween(o.created_at, o.ready_at), 0) / prepTimed.length : null;
      return `<tr>
        <td><b>${esc(p.full_name)}</b></td><td>${esc(p.role)}</td>
        <td>${taken.length || '-'}</td>
        <td>${taken.length ? money(taken.reduce((s, o) => s + Number(o.total), 0)) : '-'}</td>
        <td>${prepared.length || '-'}</td>
        <td>${pAvg !== null ? Math.round(pAvg) + ' min' : '-'}</td>
        <td>${handed.length || '-'}</td></tr>`;
    }).join('');

    $('#view').innerHTML = `
      <h2 class="title">Today</h2>
      <div class="stats">
        <div class="stat"><b>${money(sales)}</b><span>Paid sales${S.settings.vat_enabled ? ' (incl. VAT)' : ''}</span></div>
        <div class="stat"><b>${paid.length}</b><span>Orders paid</span></div>
        <div class="stat"><b>${active}</b><span>In progress</span></div>
        <div class="stat"><b>${avg !== null ? Math.round(avg) + ' min' : '-'}</b><span>Avg time to ready</span></div>
      </div>
      <div class="stats small">
        <div class="stat"><b>${money(byMethod('cash'))}</b><span>Cash</span></div>
        <div class="stat"><b>${money(byMethod('card'))}</b><span>Card</span></div>
        <div class="stat"><b>${money(byMethod('eft'))}</b><span>EFT</span></div>
      </div>
      <div class="card"><h3>Who did what today</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Staff</th><th>Role</th><th>Orders taken</th><th>Value</th><th>Orders cooked</th><th>Avg time to ready</th><th>Handed over</th></tr></thead>
          <tbody>${rows}</tbody></table></div></div>`;
  };

  // ===== Admin: all orders =====
  let ordersDate = ymd(new Date());
  views.orders = async () => {
    const from = new Date(ordersDate + 'T00:00:00');
    const orders = await fetchOrders({ since: from.toISOString(), until: addDays(from, 1).toISOString(), limit: 1000 });

    $('#view').innerHTML = `
      <h2 class="title">Orders</h2>
      <div class="toolbar"><label>Date<input type="date" id="odate" value="${ordersDate}"></label></div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Time</th><th>Type</th><th>Items</th><th>Cashier</th><th>Chef</th><th>Collected by</th><th>Status</th><th>Time to ready</th><th>Paid</th><th>Total</th><th></th></tr></thead>
        <tbody>${orders.map((o) => `<tr>
          <td><b>${o.order_number}</b></td>
          <td>${fmtTime(o.created_at)}</td>
          <td>${typeTag(o)}</td>
          <td>${o.order_items.map((i) => `${i.quantity}× ${esc(i.name)}`).join(', ')}</td>
          <td>${esc(nameOf(o.cashier_id))}</td>
          <td>${o.chef_id ? esc(nameOf(o.chef_id)) : '-'}</td>
          <td>${o.completed_by ? esc(nameOf(o.completed_by)) : '-'}</td>
          <td>${badge(o.status)}</td>
          <td>${o.ready_at ? Math.round(minsBetween(o.created_at, o.ready_at)) + ' min' : '-'}</td>
          <td>${o.payment_method ? esc(METHODS[o.payment_method]) : '-'}</td>
          <td>${money(o.total)}</td>
          <td>${['pending', 'preparing', 'ready'].includes(o.status)
            ? `<button class="btn btn-outline btn-sm" data-act="status" data-id="${o.id}" data-to="cancelled">Cancel</button>` : ''}
            ${o.status === 'completed' ? `<button class="btn btn-outline btn-sm" data-act="receipt" data-id="${o.id}">Receipt</button>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="12" class="muted">No orders on this day.</td></tr>'}</tbody>
      </table></div></div>`;
    $('#odate').onchange = (e) => { ordersDate = e.target.value || ordersDate; views.orders(); };
    bindStatusButtons();
  };

  // ===== Admin: reports =====
  const rep = { preset: 'today', from: ymd(new Date()), to: ymd(new Date()) };
  function repRange() {
    const t = startOfDay();
    const presets = {
      today: [t, t],
      yesterday: [addDays(t, -1), addDays(t, -1)],
      week: [addDays(t, -6), t],
      month: [new Date(t.getFullYear(), t.getMonth(), 1), t],
      lastmonth: [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)],
    };
    if (rep.preset === 'custom') return [new Date(rep.from + 'T00:00:00'), new Date(rep.to + 'T00:00:00')];
    return presets[rep.preset];
  }

  views.reports = async () => {
    let [from, to] = repRange();
    if (to < from) [from, to] = [to, from];
    const until = addDays(to, 1);
    const all = await fetchAllOrders(from.toISOString(), until.toISOString());
    const paid = all.filter((o) => o.status === 'completed');
    const cancelled = all.filter((o) => o.status === 'cancelled').length;
    const sum = (list, f = (o) => o.total) => list.reduce((s, o) => s + Number(f(o)), 0);
    const total = sum(paid);
    const avgOrder = paid.length ? total / paid.length : 0;

    // by payment method and type
    const groupRows = (keys, labels, pick) => keys.map((k) => {
      const l = paid.filter((o) => pick(o) === k);
      return l.length ? `<tr><td>${esc(labels[k])}</td><td>${l.length}</td><td>${money(sum(l))}</td></tr>` : '';
    }).join('') || '<tr><td colspan="3" class="muted">No paid orders.</td></tr>';

    // per day
    const days = new Map();
    paid.forEach((o) => {
      const k = ymd(o.paid_at || o.completed_at || o.created_at);
      days.set(k, (days.get(k) || 0) + Number(o.total));
    });
    const dayList = [];
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) dayList.push([ymd(d), days.get(ymd(d)) || 0]);
    const maxDay = Math.max(1, ...dayList.map((d) => d[1]));

    // top items (revenue before VAT)
    const items = new Map();
    paid.forEach((o) => o.order_items.forEach((i) => {
      const e = items.get(i.name) || { q: 0, r: 0 };
      e.q += i.quantity; e.r += Number(i.price) * i.quantity;
      items.set(i.name, e);
    }));
    const top = [...items.entries()].sort((a, b) => b[1].q - a[1].q).slice(0, 10);

    // staff
    const staff = [...S.profiles.values()].map((p) => {
      const l = paid.filter((o) => o.cashier_id === p.id);
      return { p, n: l.length, v: sum(l) };
    }).filter((x) => x.n).sort((a, b) => b.v - a.v);

    const sel = (v, t) => `<option value="${v}" ${rep.preset === v ? 'selected' : ''}>${t}</option>`;
    $('#view').innerHTML = `
      <h2 class="title">Reports</h2>
      <div class="toolbar">
        <label>Period<select id="rp">${sel('today', 'Today')}${sel('yesterday', 'Yesterday')}${sel('week', 'Last 7 days')}${sel('month', 'This month')}${sel('lastmonth', 'Last month')}${sel('custom', 'Custom range')}</select></label>
        ${rep.preset === 'custom' ? `<label>From<input type="date" id="rf" value="${rep.from}"></label><label>To<input type="date" id="rt" value="${rep.to}"></label>` : ''}
        <button class="btn btn-outline" id="csv" type="button" ${all.length ? '' : 'disabled'}>Download CSV</button>
        <button class="btn btn-outline" id="rprint" type="button">Print</button>
      </div>
      <p class="muted range">${from.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}${ymd(from) !== ymd(to) ? ' to ' + to.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</p>
      <div class="stats">
        <div class="stat"><b>${money(total)}</b><span>Paid sales${S.settings.vat_enabled ? ' (incl. VAT)' : ''}</span></div>
        <div class="stat"><b>${paid.length}</b><span>Orders paid</span></div>
        <div class="stat"><b>${money(avgOrder)}</b><span>Average order</span></div>
        <div class="stat"><b>${money(sum(paid, (o) => o.vat))}</b><span>VAT collected</span></div>
        <div class="stat"><b>${cancelled}</b><span>Cancelled</span></div>
      </div>
      <div class="two even">
        <div class="card"><h3>Cash up: by payment method</h3><div class="table-wrap"><table>
          <thead><tr><th>Method</th><th>Orders</th><th>Total</th></tr></thead>
          <tbody>${groupRows(Object.keys(METHODS), METHODS, (o) => o.payment_method)}</tbody></table></div></div>
        <div class="card"><h3>By order type</h3><div class="table-wrap"><table>
          <thead><tr><th>Type</th><th>Orders</th><th>Total</th></tr></thead>
          <tbody>${groupRows(Object.keys(TYPES), TYPES, (o) => o.order_type)}</tbody></table></div></div>
      </div>
      ${dayList.length > 1 ? `<div class="card"><h3>Sales per day</h3><div class="bars">${dayList.map(([d, v]) => `
        <div class="bar-row"><span>${new Date(d + 'T00:00:00').toLocaleDateString([], { day: '2-digit', month: 'short' })}</span>
        <div class="bar"><i style="width:${Math.round((v / maxDay) * 100)}%"></i></div><b>${money(v)}</b></div>`).join('')}</div></div>` : ''}
      <div class="two even">
        <div class="card"><h3>Top items</h3><div class="table-wrap"><table>
          <thead><tr><th>Item</th><th>Sold</th><th>Revenue</th></tr></thead>
          <tbody>${top.map(([n, e]) => `<tr><td>${esc(n)}</td><td>${e.q}</td><td>${money(e.r)}</td></tr>`).join('')
            || '<tr><td colspan="3" class="muted">No sales yet.</td></tr>'}</tbody></table></div></div>
        <div class="card"><h3>Sales by cashier</h3><div class="table-wrap"><table>
          <thead><tr><th>Cashier</th><th>Orders</th><th>Total</th></tr></thead>
          <tbody>${staff.map((x) => `<tr><td>${esc(x.p.full_name)}</td><td>${x.n}</td><td>${money(x.v)}</td></tr>`).join('')
            || '<tr><td colspan="3" class="muted">No sales yet.</td></tr>'}</tbody></table></div></div>
      </div>`;

    $('#rp').onchange = (e) => { rep.preset = e.target.value; views.reports(); };
    if (rep.preset === 'custom') {
      $('#rf').onchange = (e) => { rep.from = e.target.value || rep.from; views.reports(); };
      $('#rt').onchange = (e) => { rep.to = e.target.value || rep.to; views.reports(); };
    }
    $('#rprint').onclick = () => window.print();
    $('#csv').onclick = () => {
      const head = ['Order', 'Date', 'Time', 'Type', 'Table', 'Customer', 'Cashier', 'Chef', 'Status', 'Payment', 'Subtotal', 'VAT', 'Total', 'Items'];
      const rows = all.map((o) => [
        o.order_number, ymd(o.created_at), fmtTime(o.created_at), TYPES[o.order_type] || '', o.table_number || '',
        o.customer_name || '', nameOf(o.cashier_id), o.chef_id ? nameOf(o.chef_id) : '', STATUS[o.status] || o.status,
        o.payment_method ? METHODS[o.payment_method] : '', Number(o.subtotal).toFixed(2), Number(o.vat).toFixed(2),
        Number(o.total).toFixed(2), o.order_items.map((i) => `${i.quantity}x ${i.name}`).join('; '),
      ]);
      downloadCsv(`sales-${ymd(from)}-to-${ymd(to)}.csv`, [head, ...rows]);
    };
  };

  // ===== Admin: staff =====
  views.staff = async () => {
    const { data: all, error } = await sb.from('profiles').select('*').order('created_at');
    if (error) throw error;
    S.profiles = new Map(all.map((p) => [p.id, p]));

    // Who has a QR card and when it was last used. Quietly skipped if the v3 upgrade is not installed.
    const cards = new Map();
    try {
      const { data: st } = await sb.rpc('staff_qr_status');
      (st || []).forEach((r) => cards.set(r.user_id, r));
    } catch { /* no card info available */ }
    const cardText = (id) => {
      const c = cards.get(id);
      if (!c) return '<span class="muted">No card</span>';
      return `<span class="muted">Issued ${new Date(c.created_at).toLocaleDateString([], { day: '2-digit', month: 'short' })}${
        c.last_used_at ? ', used ' + ago(c.last_used_at) : ', not used yet'}</span>`;
    };

    $('#view').innerHTML = `
      <h2 class="title">Staff</h2>
      <div class="two">
        <div class="card"><h3>Add staff login</h3>
          <form id="staff-form" class="form">
            <label>Full name<input id="s-name" required maxlength="60"></label>
            <label>Username<input id="s-user" required pattern="[A-Za-z0-9._\\-]{3,30}" autocapitalize="none"></label>
            <label>Password (min 8 characters)<input id="s-pass" type="password" minlength="8" required autocomplete="new-password"></label>
            <label>Role<select id="s-role">
              <option value="cashier">Cashier</option><option value="chef">Chef</option><option value="admin">Admin</option>
            </select></label>
            <button class="btn btn-primary" type="submit">Create login</button>
          </form></div>
        <div class="card"><h3>Team</h3><div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>QR card</th><th></th></tr></thead>
          <tbody>${all.map((p) => {
            const self = p.id === S.me.id;
            return `<tr>
              <td><b>${esc(p.full_name)}</b></td><td>${esc(p.username)}</td>
              <td>${self ? esc(p.role) : `<select data-role-for="${p.id}">${['cashier', 'chef', 'admin'].map((r) =>
                `<option value="${r}" ${p.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>`}</td>
              <td><span class="badge ${p.active ? 'b-on' : 'b-off'}">${p.active ? 'Active' : 'Disabled'}</span></td>
              <td>${cardText(p.id)}</td>
              <td class="row-actions">${self ? '<span class="muted">You</span>' : `
                <button class="btn btn-outline btn-sm" data-toggle="${p.id}" data-active="${p.active}">${p.active ? 'Disable' : 'Enable'}</button>
                <button class="btn btn-outline btn-sm" data-reset="${p.id}">Reset password</button>`}
                <button class="btn btn-outline btn-sm" data-qr="${p.id}">${cards.has(p.id) ? 'New QR card' : 'Make QR card'}</button></td>
            </tr>`;
          }).join('')}</tbody></table></div></div>
      </div>`;

    $('#staff-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      const { data, error } = await sb.functions.invoke('create-staff', {
        body: {
          action: 'create',
          full_name: $('#s-name').value, username: $('#s-user').value,
          password: $('#s-pass').value, role: $('#s-role').value,
        },
      });
      btn.disabled = false;
      if (error) { toast(await fnError(error), 'error', 6000); return; }
      if (data?.error) { toast(data.error, 'error', 6000); return; }
      toast('Login created', 'success');
      await views.staff();
      if (data?.qr_token) {
        showCard({ name: data.full_name, role: data.role, username: data.username, token: data.qr_token });
      } else if (data?.qr_error) {
        toast('Login created, but the QR card could not be made: ' + data.qr_error + '. Use "Make QR card" once this is fixed.', 'error', 10000);
      }
    };

    $('#view').querySelectorAll('[data-qr]').forEach((b) => b.onclick = async () => {
      const p = S.profiles.get(b.dataset.qr);
      if (!p) return;
      if (cards.has(p.id) && !confirm(`Make a new QR card for ${p.full_name}? Their current card will stop working straight away.`)) return;
      b.disabled = true;
      const { data, error } = await sb.functions.invoke('create-staff', { body: { action: 'regenerate_qr', user_id: p.id } });
      b.disabled = false;
      if (error) { toast(await fnError(error), 'error', 6000); return; }
      if (data?.error) { toast(data.error, 'error', 6000); return; }
      await views.staff();
      showCard({ name: data.full_name, role: data.role, username: data.username, token: data.qr_token });
    });

    $('#view').querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => {
      const { error } = await sb.from('profiles').update({ active: b.dataset.active !== 'true' }).eq('id', b.dataset.toggle);
      if (error) toast(error.message, 'error'); else views.staff();
    });
    $('#view').querySelectorAll('[data-role-for]').forEach((s) => s.onchange = async () => {
      const { error } = await sb.from('profiles').update({ role: s.value }).eq('id', s.dataset.roleFor);
      if (error) toast(error.message, 'error'); else toast('Role updated', 'success');
      views.staff();
    });
    $('#view').querySelectorAll('[data-reset]').forEach((b) => b.onclick = async () => {
      const pw = prompt('New password (min 8 characters):');
      if (!pw) return;
      const { data, error } = await sb.functions.invoke('create-staff',
        { body: { action: 'reset_password', user_id: b.dataset.reset, password: pw } });
      if (error) toast(await fnError(error), 'error', 6000);
      else if (data?.error) toast(data.error, 'error', 6000);
      else toast('Password updated', 'success');
    });
  };

  // ===== Admin: menu =====
  views.menu = async () => {
    const { data: items, error } = await sb.from('menu_items').select('*').order('category').order('name');
    if (error) throw error;
    const cats = [...new Set(items.map((i) => i.category))];

    $('#view').innerHTML = `
      <h2 class="title">Menu</h2>
      <div class="two">
        <div class="card"><h3>Add item</h3>
          <form id="menu-form" class="form">
            <label>Name<input id="m-name" required maxlength="60"></label>
            <label>Price (${S.settings.vat_enabled ? 'before VAT, ' : ''}in rand)<input id="m-price" type="number" min="0" step="0.01" required></label>
            <label>Category<input id="m-cat" list="cats" required maxlength="30" value="Mains"></label>
            <datalist id="cats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
            <button class="btn btn-primary" type="submit">Add to menu</button>
          </form></div>
        <div class="card"><h3>Items</h3><div class="table-wrap"><table>
          <thead><tr><th>Item</th><th>Category</th><th>Price</th><th>Available</th><th></th></tr></thead>
          <tbody>${items.map((i) => `<tr>
            <td><b>${esc(i.name)}</b></td><td>${esc(i.category)}</td>
            <td><input type="number" min="0" step="0.01" value="${i.price}" data-price="${i.id}"></td>
            <td><input type="checkbox" ${i.available ? 'checked' : ''} data-avail="${i.id}" style="width:auto"></td>
            <td><button class="btn btn-danger btn-sm" data-del="${i.id}" data-name="${esc(i.name)}">Delete</button></td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">No items yet.</td></tr>'}</tbody>
        </table></div></div>
      </div>`;

    $('#menu-form').onsubmit = async (e) => {
      e.preventDefault();
      const { error } = await sb.from('menu_items').insert({
        name: $('#m-name').value.trim(), price: parseFloat($('#m-price').value), category: $('#m-cat').value.trim(),
      });
      if (error) toast(error.message, 'error'); else { toast('Item added', 'success'); views.menu(); }
    };
    $('#view').querySelectorAll('[data-price]').forEach((inp) => inp.onchange = async () => {
      const price = parseFloat(inp.value);
      if (isNaN(price) || price < 0) { toast('Enter a valid price', 'error'); return; }
      const { error } = await sb.from('menu_items').update({ price }).eq('id', inp.dataset.price);
      if (error) toast(error.message, 'error'); else toast('Price saved', 'success', 1500);
    });
    $('#view').querySelectorAll('[data-avail]').forEach((inp) => inp.onchange = async () => {
      const { error } = await sb.from('menu_items').update({ available: inp.checked }).eq('id', inp.dataset.avail);
      if (error) toast(error.message, 'error'); else toast('Saved', 'success', 1500);
    });
    $('#view').querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      if (!confirm(`Delete "${b.dataset.name}"? Past orders keep their record.`)) return;
      const { error } = await sb.from('menu_items').delete().eq('id', b.dataset.del);
      if (error) toast(error.message, 'error'); else views.menu();
    });
  };

  // ===== Admin: settings and branding =====
  // Shrink an uploaded logo so it stays small enough to store in the settings row
  function readLogo(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Please choose a PNG or JPG image'));
      if (file.size > 8 * 1024 * 1024) return reject(new Error('That image is too large (max 8 MB)'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 360;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
      img.src = url;
    });
  }

  views.settings = async () => {
    await loadSettings();
    const s = S.settings;
    let logo = s.logo_url;
    $('#view').innerHTML = `
      <h2 class="title">Settings</h2>
      <div class="two">
        <div class="card"><h3>Logo</h3>
          <div class="logo-edit">
            <img id="logo-prev" class="logo-prev" src="${esc(safeLogo(logo))}" alt="Logo preview">
            <label class="btn btn-outline">Upload new logo<input id="logo-file" type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
            <button type="button" class="btn btn-ghost btn-sm" id="logo-reset">Use the Sasa logo</button>
            <p class="muted small">Shows on the login page, the top bar and receipts. Save below to keep it.</p>
          </div></div>
        <div class="card"><h3>Business details</h3>
          <form id="set-form" class="form">
            <label>Business name<input id="st-name" required maxlength="60" value="${esc(s.business_name)}"></label>
            <label>Address<input id="st-addr" maxlength="120" value="${esc(s.address)}"></label>
            <label>Phone<input id="st-phone" maxlength="30" value="${esc(s.phone)}"></label>
            <label>VAT number (shown on receipts, leave empty if not registered)<input id="st-vatno" maxlength="30" value="${esc(s.vat_number)}"></label>
            <label class="check"><input id="st-vaton" type="checkbox" ${s.vat_enabled ? 'checked' : ''}> Charge VAT on top of menu prices</label>
            <label>VAT rate (%)<input id="st-vat" type="number" min="0" max="100" step="0.01" value="${Number(s.vat_rate)}"></label>
            <label>Receipt footer<input id="st-foot" maxlength="120" value="${esc(s.receipt_footer)}"></label>
            <button class="btn btn-primary" type="submit">Save settings</button>
            <p class="muted small">VAT changes apply to new orders only. Existing orders keep the VAT they were created with.</p>
          </form></div>
      </div>
      <div class="card"><h3>Screen lock</h3>
        <p class="muted small lock-note">If nobody touches the screen for this long, the person is signed out and the next person must sign in as themselves. A warning shows for the last 15 seconds. Enter 0 to switch it off for a role.</p>
        <form id="lock-form" class="lock-grid">
          <label>Admin (minutes)<input id="lk-admin" type="number" min="0" max="240" step="1" value="${Number(s.idle_minutes_admin)}"></label>
          <label>Cashier (minutes)<input id="lk-cashier" type="number" min="0" max="240" step="1" value="${Number(s.idle_minutes_cashier)}"></label>
          <label>Chef (minutes)<input id="lk-chef" type="number" min="0" max="240" step="1" value="${Number(s.idle_minutes_chef)}"></label>
          <button class="btn btn-primary" type="submit">Save screen lock</button>
        </form>
        <p class="muted small lock-note">The kitchen screen needs to stay signed in to show new orders, so give the chef a longer time than the cashier. While someone is signed out they do not get the ready-order alert.</p>
      </div>`;

    $('#lock-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      const val = (id) => Math.min(240, Math.max(0, Math.round(parseFloat($(id).value) || 0)));
      btn.disabled = true;
      const { error } = await sb.from('settings').update({
        idle_minutes_admin: val('#lk-admin'), idle_minutes_cashier: val('#lk-cashier'), idle_minutes_chef: val('#lk-chef'),
        updated_at: new Date().toISOString(),
      }).eq('id', 1);
      btn.disabled = false;
      if (error) { toast(error.message, 'error', 6000); return; }
      await loadSettings();
      toast('Screen lock saved', 'success');
    };

    $('#logo-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { logo = await readLogo(f); $('#logo-prev').src = logo; toast('Logo ready. Press Save settings.', 'info', 3000); }
      catch (err) { toast(err.message, 'error'); }
    };
    $('#logo-reset').onclick = () => { logo = 'logo.png'; $('#logo-prev').src = 'logo.png'; };

    $('#set-form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      const { error } = await sb.from('settings').update({
        business_name: $('#st-name').value.trim() || DEFAULT_SETTINGS.business_name,
        address: $('#st-addr').value.trim(),
        phone: $('#st-phone').value.trim(),
        vat_number: $('#st-vatno').value.trim(),
        vat_enabled: $('#st-vaton').checked,
        vat_rate: Math.min(100, Math.max(0, parseFloat($('#st-vat').value) || 0)),
        receipt_footer: $('#st-foot').value.trim(),
        logo_url: logo,
        updated_at: new Date().toISOString(),
      }).eq('id', 1);
      btn.disabled = false;
      if (error) { toast(error.message, 'error', 6000); return; }
      await loadSettings();
      toast('Settings saved', 'success');
    };
  };

  // ===== Admin: activity log =====
  const ACTIONS = {
    order_created: 'Created order', order_preparing: 'Started preparing', order_ready: 'Marked order ready',
    order_completed: 'Handed over and took payment', order_cancelled: 'Cancelled order',
    staff_created: 'Created staff login', staff_activated: 'Enabled staff login',
    staff_deactivated: 'Disabled staff login', staff_role_changed: 'Changed staff role',
    staff_password_reset: 'Reset a password', menu_item_added: 'Added menu item',
    menu_price_changed: 'Changed a price', menu_availability_changed: 'Changed availability',
    menu_item_deleted: 'Deleted menu item', settings_changed: 'Changed settings',
    login_password: 'Signed in with password', login_qr: 'Signed in with QR card', logout: 'Signed out',
    auto_logout: 'Signed out automatically (screen idle)', staff_qr_issued: 'Made a QR card',
  };
  function describe(a) {
    const d = a.details || {};
    if (d.order_number) {
      return `#${d.order_number}` + (d.method ? ` paid by ${METHODS[d.method] || d.method}, ${money(d.total)}` : '');
    }
    if (a.action === 'staff_role_changed') return `${d.username}: ${d.from} to ${d.to}`;
    if (d.username) return d.username + (d.role ? ` (${d.role})` : '');
    if (a.action === 'menu_price_changed') return `${d.name}: ${money(d.from)} to ${money(d.to)}`;
    if (a.action === 'menu_availability_changed') return `${d.name}: ${d.available ? 'available' : 'unavailable'}`;
    if (d.name) return d.name + (d.price !== undefined ? ` (${money(d.price)})` : '');
    if (d.business_name) return d.business_name;
    return '';
  }
  views.activity = async () => {
    const { data, error } = await sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    $('#view').innerHTML = `
      <h2 class="title">Activity</h2>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
        <tbody>${data.map((a) => `<tr>
          <td>${fmtDateTime(a.created_at)}</td><td><b>${esc(nameOf(a.user_id))}</b></td>
          <td>${esc(ACTIONS[a.action] || a.action)}</td><td>${esc(describe(a))}</td></tr>`).join('')
          || '<tr><td colspan="4" class="muted">Nothing yet.</td></tr>'}</tbody>
      </table></div></div>`;
  };

  // ---------- start ----------
  (async () => {
    await loadSettings();
    const { data: { session } } = await sb.auth.getSession();
    if (session) { await boot(session.user); return; }
    showLogin();
    let msg = null;
    try { msg = sessionStorage.getItem(MSG_KEY); sessionStorage.removeItem(MSG_KEY); } catch { /* ignore */ }
    if (msg === 'timeout') toast('You were signed out because the screen was idle.', 'info', 7000);
  })();
})();
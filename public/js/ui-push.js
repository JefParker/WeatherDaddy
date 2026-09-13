// WeatherDaddy UI — Push Notifications screen (menu → Push Notifications).
//
// Extends the UI object from ui.js. Loaded after ui-radar.js and before
// app.js in index.html, and listed in sw.js ASSETS_TO_CACHE. The screen
// has one feature today, the morning briefing, laid out as a section so
// severe-alert and rain-nowcast toggles can join it later.
//
// The flow: the switch asks for notification permission, subscribes this
// browser to Web Push with the server's VAPID key, and POSTs the
// subscription plus preferences to /api/push/subscribe (worker/push.js).
// The server row is the source of truth; Storage keeps a copy of the
// preferences so the screen renders instantly and can re-sync after a
// unit change. Notifications themselves are rendered by sw.js.

Object.assign(UI, {
  PUSH_API: '/api/push',
  _push: null,          // element handles, set by _bindPushScreen
  _pushBusy: false,
  _pushSyncTimer: null,

  _bindPushScreen() {
    const $ = (id) => document.getElementById(id);
    const els = {
      screen:      $('push-screen'),
      back:        $('push-back-btn'),
      goto:        $('goto-push-btn'),
      unsupported: $('push-unsupported'),
      iosInstall:  $('push-ios-install'),
      denied:      $('push-denied'),
      toggle:      $('push-briefing-toggle'),
      prefs:       $('push-briefing-prefs'),
      city:        $('push-briefing-city'),
      hour:        $('push-briefing-hour'),
      test:        $('push-briefing-test'),
      status:      $('push-briefing-status'),
    };
    if (!els.screen || !els.toggle || !els.city || !els.hour) return;
    this._push = els;

    if (els.goto) els.goto.addEventListener('click', () => {
      this.toggleScreen('main-menu', false);
      this.toggleScreen('push', true);
    });
    if (els.back) els.back.addEventListener('click', () => this.closeOverlayWithCube('push-screen'));

    els.toggle.addEventListener('click', () => {
      const on = els.toggle.getAttribute('aria-checked') === 'true';
      if (on) this.disableBriefing(); else this.enableBriefing();
    });
    els.city.addEventListener('change', () => this._onBriefingPrefChange());
    els.hour.addEventListener('change', () => this._onBriefingPrefChange());
    if (els.test) els.test.addEventListener('click', () => this.sendBriefingTest());
  },

  // Called by toggleScreen('push', true).
  onShowPushScreen() {
    this.renderPushScreen();
    this._reconcileBriefing();
  },

  // What this browser can do. iOS only exposes PushManager to web apps
  // launched from the Home Screen, so "unsupported on iOS in a tab" is
  // really "install first".
  pushSupport() {
    const ua = navigator.userAgent || '';
    const isIOS = /iP(hone|ad|od)/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone === true ||
      (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    return {
      supported,
      needsInstall: !supported && isIOS && !standalone,
      permission: ('Notification' in window) ? Notification.permission : 'default',
    };
  },

  renderPushScreen() {
    const els = this._push;
    if (!els) return;
    const b = Storage.getPushPrefs().briefing;
    const support = this.pushSupport();
    els.unsupported.hidden = support.supported || support.needsInstall;
    els.iosInstall.hidden  = !support.needsInstall;
    els.denied.hidden      = !(support.supported && support.permission === 'denied');
    const usable = support.supported && support.permission !== 'denied';
    els.toggle.disabled = !usable;
    this._renderPushCityOptions(b);
    this._renderPushHourOptions(b.hour);
    this._setBriefingToggle(usable && b.enabled);
    this._renderBriefingStatus();
  },

  _cityKey(c) {
    return `${Number(c.lat).toFixed(4)},${Number(c.lon).toFixed(4)}`;
  },

  _renderPushCityOptions(b) {
    const els = this._push;
    const cities = [];
    const seen = new Set();
    const add = (c, label) => {
      if (!c || typeof c.lat !== 'number' || typeof c.lon !== 'number') return;
      const key = this._cityKey(c);
      if (seen.has(key)) return;
      seen.add(key);
      const name = c.name || 'Current location';
      cities.push({ lat: c.lat, lon: c.lon, name, label: label || name });
    };
    const current = Storage.getLocation();
    if (current) add(current, `${current.name || 'Current location'} (current)`);
    Storage.getSavedList().forEach(c => add(c));
    // The briefing's city may since have been removed from the list;
    // keep it selectable so the screen shows what is actually set.
    if (b.enabled && typeof b.lat === 'number' && typeof b.lon === 'number') add({ lat: b.lat, lon: b.lon, name: b.name });

    els.city.innerHTML = '';
    if (!cities.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'No saved cities yet';
      els.city.appendChild(o);
      els.city.disabled = true;
      return;
    }
    els.city.disabled = false;
    for (const c of cities) {
      const o = document.createElement('option');
      o.value = this._cityKey(c);
      o.textContent = c.label;
      o.dataset.lat = String(c.lat);
      o.dataset.lon = String(c.lon);
      o.dataset.name = c.name;
      els.city.appendChild(o);
    }
    const want = (typeof b.lat === 'number' && typeof b.lon === 'number') ? this._cityKey(b) : null;
    if (want && Array.from(els.city.options).some(o => o.value === want)) els.city.value = want;
  },

  _renderPushHourOptions(hour) {
    const els = this._push;
    const twentyFour = Storage.getUnits().time === '24h';
    const label = (h) => twentyFour
      ? `${String(h).padStart(2, '0')}:00`
      : `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
    els.hour.innerHTML = '';
    for (let h = 0; h < 24; h++) {
      const o = document.createElement('option');
      o.value = String(h);
      o.textContent = label(h);
      els.hour.appendChild(o);
    }
    els.hour.value = String(Number.isInteger(hour) ? hour : 6);
  },

  _selectedBriefingCity() {
    const o = this._push.city.selectedOptions && this._push.city.selectedOptions[0];
    if (!o || !o.value) return null;
    return { lat: Number(o.dataset.lat), lon: Number(o.dataset.lon), name: o.dataset.name || '' };
  },

  _setBriefingToggle(on) {
    const els = this._push;
    els.toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    els.prefs.hidden = !on;
  },

  // No arguments → the resting text for the current state.
  _renderBriefingStatus(text, isError = false) {
    const els = this._push;
    if (text == null) {
      const b = Storage.getPushPrefs().briefing;
      if (b.enabled) {
        const opt = els.hour.selectedOptions && els.hour.selectedOptions[0];
        text = `Every morning at ${opt ? opt.textContent : ''}`.trim();
        if (b.lastSentDay) text += ` · last sent ${b.lastSentDay}`;
      } else {
        text = '';
      }
    }
    els.status.textContent = text;
    els.status.classList.toggle('is-error', !!isError);
  },

  _briefingPrefsPayload(city, hour) {
    const units = Storage.getUnits();
    let tz = 'UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) {}
    return {
      lat: city.lat, lon: city.lon, name: city.name, tz, hour,
      units: { temp: units.temp, wind: units.wind, precip: units.precip, time: units.time },
    };
  },

  async _pushFetch(path, body) {
    const init = body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(`${this.PUSH_API}/${path}`, init);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `Push service error (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  },

  _b64uToBytes(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  },

  _sameKey(a, b) {
    if (!a) return true; // some browsers don't echo the key back; assume fine
    const x = new Uint8Array(a);
    if (x.length !== b.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== b[i]) return false;
    return true;
  },

  // The browser's PushSubscription. With `create`, subscribes if there
  // is none — or re-subscribes if the existing one was made with a
  // different server key (a VAPID rotation would otherwise fail 403
  // forever on the server side).
  async _getPushSubscription(create) {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!create) return sub;
    const cfg = await this._pushFetch('config');
    if (!cfg || !cfg.configured || !cfg.publicKey) {
      throw new Error('Push notifications aren’t available on this server yet.');
    }
    const key = this._b64uToBytes(cfg.publicKey);
    if (sub && !this._sameKey(sub.options && sub.options.applicationServerKey, key)) {
      try { await sub.unsubscribe(); } catch (_) {}
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    return sub;
  },

  _setPushBusy(busy) {
    this._pushBusy = busy;
    const els = this._push;
    els.toggle.classList.toggle('is-busy', busy);
    if (els.test) els.test.disabled = busy;
  },

  async enableBriefing() {
    const els = this._push;
    if (!els || this._pushBusy) return;
    const city = this._selectedBriefingCity();
    if (!city) {
      this._renderBriefingStatus('Save a city first, then choose it here.', true);
      return;
    }
    this._setPushBusy(true);
    try {
      // First await must be the permission prompt itself: browsers
      // require it to follow the tap without other async work between.
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        this.renderPushScreen();
        this._renderBriefingStatus(
          perm === 'denied' ? 'Notifications are blocked for WeatherDaddy.' : 'Notification permission wasn’t granted.',
          true
        );
        return;
      }
      const sub = await this._getPushSubscription(true);
      const hour = Number(els.hour.value);
      const data = await this._pushFetch('subscribe', {
        subscription: sub.toJSON(),
        prefs: this._briefingPrefsPayload(city, hour),
      });
      Storage.savePushPrefs({ briefing: {
        enabled: true, lat: city.lat, lon: city.lon, name: city.name, hour,
        lastSentDay: (data && data.prefs && data.prefs.lastSentDay) || null,
      } });
      this._setBriefingToggle(true);
      this._renderBriefingStatus();
      this.showToast('Morning briefing is on');
    } catch (err) {
      console.warn('[push] enable failed:', err);
      this._setBriefingToggle(false);
      this._renderBriefingStatus(err && err.message ? err.message : 'Couldn’t turn on notifications.', true);
    } finally {
      this._setPushBusy(false);
    }
  },

  async disableBriefing() {
    const els = this._push;
    if (!els || this._pushBusy) return;
    this._setPushBusy(true);
    const b = Storage.getPushPrefs().briefing;
    try {
      const sub = await this._getPushSubscription(false);
      if (sub) {
        try { await this._pushFetch('unsubscribe', { endpoint: sub.endpoint }); }
        catch (err) { console.warn('[push] server unsubscribe failed:', err); }
        // The briefing is the only push feature today, so drop the
        // browser subscription too; with more features this becomes
        // "only if nothing else is on".
        try { await sub.unsubscribe(); } catch (_) {}
      }
      Storage.savePushPrefs({ briefing: { ...b, enabled: false, lastSentDay: null } });
      this._setBriefingToggle(false);
      this._renderBriefingStatus();
      this.showToast('Morning briefing is off');
    } catch (err) {
      console.warn('[push] disable failed:', err);
      this._renderBriefingStatus(err && err.message ? err.message : 'Couldn’t turn off notifications.', true);
    } finally {
      this._setPushBusy(false);
    }
  },

  // City or hour changed on the screen.
  _onBriefingPrefChange() {
    const els = this._push;
    const b = Storage.getPushPrefs().briefing;
    const city = this._selectedBriefingCity() || { lat: b.lat, lon: b.lon, name: b.name };
    const hour = Number(els.hour.value);
    Storage.savePushPrefs({ briefing: { ...b, lat: city.lat, lon: city.lon, name: city.name, hour } });
    this._renderBriefingStatus();
    if (b.enabled) this.syncPushPrefs();
  },

  // Push the stored preferences (plus current units and timezone) to
  // the server row. Debounced: unit changes come in bursts. Safe to
  // call any time — a no-op unless the briefing is on.
  syncPushPrefs() {
    if (!Storage.getPushPrefs().briefing.enabled) return;
    if (!this.pushSupport().supported) return;
    clearTimeout(this._pushSyncTimer);
    this._pushSyncTimer = setTimeout(() => this._syncPushPrefsNow().catch(err => {
      console.warn('[push] sync failed:', err);
      if (this._push && this._push.screen.classList.contains('open')) {
        this._renderBriefingStatus('Couldn’t save changes — ' + (err && err.message ? err.message : 'offline?'), true);
      }
    }), 400);
  },

  async _syncPushPrefsNow() {
    const b = Storage.getPushPrefs().briefing;
    if (!b.enabled || typeof b.lat !== 'number' || typeof b.lon !== 'number') return;
    const sub = await this._getPushSubscription(false);
    if (!sub) {
      // The browser dropped the subscription behind our back.
      Storage.savePushPrefs({ briefing: { ...b, enabled: false } });
      if (this._push) this.renderPushScreen();
      return;
    }
    const data = await this._pushFetch('subscribe', {
      subscription: sub.toJSON(),
      prefs: this._briefingPrefsPayload({ lat: b.lat, lon: b.lon, name: b.name }, b.hour),
    });
    Storage.savePushPrefs({ briefing: { ...b, lastSentDay: (data && data.prefs && data.prefs.lastSentDay) || b.lastSentDay } });
    if (this._push && this._push.screen.classList.contains('open')) this._renderBriefingStatus();
  },

  // On screen open: make what the screen shows agree with the browser
  // and the server. Offline just leaves the stored state alone.
  async _reconcileBriefing() {
    const els = this._push;
    const support = this.pushSupport();
    if (!support.supported) return;
    const b = Storage.getPushPrefs().briefing;
    try {
      const sub = await this._getPushSubscription(false);
      if (!b.enabled) {
        // Toggle is off here, but if the browser still holds a
        // subscription the server may still be sending: clean up.
        if (sub) {
          try { await this._pushFetch('unsubscribe', { endpoint: sub.endpoint }); } catch (_) {}
          try { await sub.unsubscribe(); } catch (_) {}
        }
        return;
      }
      if (!sub || support.permission !== 'granted') {
        Storage.savePushPrefs({ briefing: { ...b, enabled: false } });
        this.renderPushScreen();
        this._renderBriefingStatus('This device is no longer subscribed. Turn the briefing on again to resume.', true);
        return;
      }
      const st = await this._pushFetch('status', { endpoint: sub.endpoint });
      if (!st || !st.subscribed) {
        // Server lost the row (or never had it): re-create from the
        // stored preferences rather than silently doing nothing.
        await this._syncPushPrefsNow();
        return;
      }
      const p = st.prefs;
      Storage.savePushPrefs({ briefing: {
        enabled: true, lat: p.lat, lon: p.lon, name: p.name, hour: p.hour, lastSentDay: p.lastSentDay || null,
      } });
      this.renderPushScreen();
    } catch (err) {
      console.warn('[push] reconcile skipped:', err);
    }
  },

  async sendBriefingTest() {
    const els = this._push;
    if (!els || this._pushBusy) return;
    this._setPushBusy(true);
    this._renderBriefingStatus('Sending…');
    try {
      const sub = await this._getPushSubscription(false);
      if (!sub) throw new Error('This device isn’t subscribed.');
      await this._pushFetch('test', { endpoint: sub.endpoint });
      this._renderBriefingStatus('Test sent — it should appear in a moment.');
      this.showToast('Test briefing sent');
    } catch (err) {
      console.warn('[push] test failed:', err);
      if (err && err.status === 410) {
        const b = Storage.getPushPrefs().briefing;
        Storage.savePushPrefs({ briefing: { ...b, enabled: false } });
        this.renderPushScreen();
      }
      this._renderBriefingStatus(err && err.message ? err.message : 'Couldn’t send a test.', true);
    } finally {
      this._setPushBusy(false);
    }
  },
});

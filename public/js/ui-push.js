// WeatherDaddy UI — Push Notifications screen (menu → Push Notifications).
//
// Extends the UI object from ui.js. Loaded after ui-radar.js and before
// app.js in index.html, and listed in sw.js ASSETS_TO_CACHE. The screen
// is one city picker followed by a section per feature: morning
// briefing, severe weather alerts, rain nowcast, threshold alerts, full
// moon, sky events, forecast changes. Every feature shares the one city
// and the one browser subscription.
//
// The flow: the first switch turned on asks for notification
// permission, subscribes this browser to Web Push with the server's
// VAPID key, and POSTs the subscription plus the complete preference
// set to /api/push/subscribe (worker/push.js). Later switches re-POST
// the same shape with a different flag; the last switch turned off
// deletes the row and the browser subscription. The server row is the
// source of truth; Storage keeps a copy so the screen renders instantly
// and can re-sync after a unit change. Notifications themselves are
// rendered by sw.js.

Object.assign(UI, {
  PUSH_API: '/api/push',
  PUSH_FEATURES: ['briefing', 'alerts', 'nowcast', 'thresholds', 'moon', 'sky', 'changes'],
  // Bit per threshold item; must match worker/thresholds.js.
  PUSH_THRESHOLDS: [
    { bit: 1,  id: 'freeze', label: 'Freeze',           sub: 'Low at or below 32°F / 0°C' },
    { bit: 2,  id: 'heat',   label: 'Extreme heat',     sub: 'Feels like 100°F / 38°C or more' },
    { bit: 4,  id: 'wind',   label: 'High wind',        sub: 'Gusts of 45 mph / 72 km/h or more' },
    { bit: 8,  id: 'rain',   label: 'Heavy rain',       sub: '1 in / 25 mm or more in 24 hours' },
    { bit: 16, id: 'snow',   label: 'Heavy snow',       sub: '3 in / 7 cm or more in 24 hours' },
    { bit: 32, id: 'aqi',      label: 'Poor air quality', sub: 'US AQI above 100' },
    { bit: 64, id: 'umbrella', label: 'Umbrella',         sub: '50% or better chance of rain at some point' },
  ],
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
      city:        $('push-city'),
      hour:        $('push-briefing-hour'),
      test:        $('push-briefing-test'),
      thresholdHour: $('push-thresholds-hour'),
      thresholdList: $('push-thresholds-list'),
      toggle: {}, prefs: {}, status: {},
    };
    for (const f of this.PUSH_FEATURES) {
      els.toggle[f] = $(`push-${f}-toggle`);
      els.prefs[f]  = $(`push-${f}-prefs`);
      els.status[f] = $(`push-${f}-status`);
    }
    if (!els.screen || !els.city || !els.toggle.briefing || !els.hour) return;
    this._push = els;

    if (els.goto) els.goto.addEventListener('click', () => {
      this.toggleScreen('main-menu', false);
      this.toggleScreen('push', true);
    });
    if (els.back) els.back.addEventListener('click', () => this.closeOverlayWithCube('push-screen'));

    for (const f of this.PUSH_FEATURES) {
      const t = els.toggle[f];
      if (!t) continue;
      t.addEventListener('click', () => {
        const on = t.getAttribute('aria-checked') === 'true';
        this.setPushFeature(f, !on);
      });
    }
    els.city.addEventListener('change', () => this._onPushPrefChange());
    els.hour.addEventListener('change', () => this._onPushPrefChange());
    if (els.thresholdHour) els.thresholdHour.addEventListener('change', () => this._onPushPrefChange());
    if (els.thresholdList) this._renderThresholdList();
    if (els.test) els.test.addEventListener('click', () => this.sendBriefingTest());
  },

  // Called by toggleScreen('push', true).
  onShowPushScreen() {
    this.renderPushScreen();
    this._reconcilePush();
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

  _anyPushEnabled(p = Storage.getPushPrefs()) {
    return this.PUSH_FEATURES.some(f => p[f] && p[f].enabled);
  },

  renderPushScreen() {
    const els = this._push;
    if (!els) return;
    const p = Storage.getPushPrefs();
    const support = this.pushSupport();
    els.unsupported.hidden = support.supported || support.needsInstall;
    els.iosInstall.hidden  = !support.needsInstall;
    els.denied.hidden      = !(support.supported && support.permission === 'denied');
    const usable = support.supported && support.permission !== 'denied';
    this._renderPushCityOptions(p);
    this._renderHourOptions(els.hour, p.briefing.hour, 6);
    if (els.thresholdHour) this._renderHourOptions(els.thresholdHour, p.thresholds.hour, 17);
    if (els.thresholdList) this._renderThresholdChecks(p.thresholds.mask);
    for (const f of this.PUSH_FEATURES) {
      const t = els.toggle[f];
      if (!t) continue;
      t.disabled = !usable;
      this._setPushToggle(f, usable && p[f].enabled);
      this._renderPushStatus(f);
    }
  },

  _cityKey(c) {
    return `${Number(c.lat).toFixed(4)},${Number(c.lon).toFixed(4)}`;
  },

  _renderPushCityOptions(p) {
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
    // The chosen city may since have been removed from the list; keep
    // it selectable so the screen shows what is actually set.
    if (p.city && this._anyPushEnabled(p)) add(p.city);

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
    const want = p.city ? this._cityKey(p.city) : null;
    if (want && Array.from(els.city.options).some(o => o.value === want)) els.city.value = want;
  },

  _renderHourOptions(select, hour, dflt) {
    const twentyFour = Storage.getUnits().time === '24h';
    const label = (h) => twentyFour
      ? `${String(h).padStart(2, '0')}:00`
      : `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
    select.innerHTML = '';
    for (let h = 0; h < 24; h++) {
      const o = document.createElement('option');
      o.value = String(h);
      o.textContent = label(h);
      select.appendChild(o);
    }
    select.value = String(Number.isInteger(hour) ? hour : dflt);
  },

  _renderThresholdList() {
    const list = this._push.thresholdList;
    list.innerHTML = '';
    for (const t of this.PUSH_THRESHOLDS) {
      const label = document.createElement('label');
      label.className = 'push-row push-check';
      label.innerHTML = `
        <span class="push-row-text">
          <span class="push-row-title">${this.esc(t.label)}</span>
          <span class="push-row-sub">${this.esc(t.sub)}</span>
        </span>
        <input type="checkbox" class="push-checkbox" data-bit="${t.bit}" aria-label="${this.esc(t.label)}">`;
      list.appendChild(label);
    }
    list.addEventListener('change', () => this._onPushPrefChange());
  },

  _renderThresholdChecks(mask) {
    this._push.thresholdList.querySelectorAll('input[data-bit]').forEach(cb => {
      cb.checked = (mask & Number(cb.dataset.bit)) !== 0;
    });
  },

  _thresholdMaskFromScreen() {
    let mask = 0;
    this._push.thresholdList.querySelectorAll('input[data-bit]').forEach(cb => {
      if (cb.checked) mask |= Number(cb.dataset.bit);
    });
    return mask;
  },

  _selectedPushCity() {
    const o = this._push.city.selectedOptions && this._push.city.selectedOptions[0];
    if (!o || !o.value) return null;
    return { lat: Number(o.dataset.lat), lon: Number(o.dataset.lon), name: o.dataset.name || '' };
  },

  _setPushToggle(f, on) {
    const els = this._push;
    if (els.toggle[f]) els.toggle[f].setAttribute('aria-checked', on ? 'true' : 'false');
    if (els.prefs[f]) els.prefs[f].hidden = !on;
  },

  // NWS covers US territory only; same loose box as WeatherAPI.getAlerts.
  _inNwsBox(c) {
    return !!c && c.lat >= 17 && c.lat <= 72 && c.lon >= -180 && c.lon <= -65;
  },

  // No `text` → the resting text for the feature's current state.
  _renderPushStatus(f, text, isError = false) {
    const els = this._push;
    const el = els.status[f];
    if (!el) return;
    if (text == null) {
      const p = Storage.getPushPrefs();
      text = '';
      if (p[f].enabled) {
        const hourText = (select) => {
          const opt = select && select.selectedOptions && select.selectedOptions[0];
          return opt ? opt.textContent : '';
        };
        if (f === 'briefing') {
          text = `Every morning at ${hourText(els.hour)}`.trim();
          if (p.briefing.lastSentDay) text += ` · last sent ${p.briefing.lastSentDay}`;
        } else if (f === 'alerts') {
          text = this._inNwsBox(p.city)
            ? 'Checked every 5 minutes'
            : 'Only US locations have National Weather Service alerts.';
          isError = !this._inNwsBox(p.city);
        } else if (f === 'nowcast') {
          text = 'Checked every 5 minutes, 7 AM to 10 PM';
        } else if (f === 'thresholds') {
          text = `Every day at ${hourText(els.thresholdHour)}, for the next 24 hours`.trim();
        } else if (f === 'moon') {
          text = 'Shortly before sunset on the night of each full moon';
        } else if (f === 'sky') {
          text = 'Before sunset on the night of a meteor-shower peak or lunar eclipse; a couple of hours before a solar eclipse';
        } else if (f === 'changes') {
          text = `Checked at ${hourText(els.hour)} and ${hourText(els.thresholdHour)}, only sent when something moved a lot`.trim();
        }
      }
    }
    el.textContent = text;
    el.classList.toggle('is-error', !!isError);
  },

  // The complete preference set, as worker/push.js parsePrefs reads it.
  _pushPrefsPayload(p = Storage.getPushPrefs()) {
    const units = Storage.getUnits();
    let tz = 'UTC';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) {}
    return {
      lat: p.city.lat, lon: p.city.lon, name: p.city.name, tz,
      hour: p.briefing.hour,
      units: { temp: units.temp, wind: units.wind, precip: units.precip, time: units.time },
      features: {
        briefing: p.briefing.enabled, alerts: p.alerts.enabled,
        thresholds: p.thresholds.enabled, moon: p.moon.enabled,
        sky: p.sky.enabled, changes: p.changes.enabled,
        nowcast: p.nowcast.enabled,
      },
      thresholdHour: p.thresholds.hour,
      thresholdMask: p.thresholds.mask,
    };
  },

  // What the screen currently shows, merged over the stored prefs.
  _pushPrefsFromScreen() {
    const els = this._push;
    const p = Storage.getPushPrefs();
    const city = this._selectedPushCity() || p.city;
    p.city = city;
    p.briefing.hour = Number(els.hour.value);
    if (els.thresholdHour) p.thresholds.hour = Number(els.thresholdHour.value);
    if (els.thresholdList) p.thresholds.mask = this._thresholdMaskFromScreen();
    return p;
  },

  // Adopt the server's copy of the preferences (status / subscribe
  // replies) into storage.
  _adoptServerPrefs(sp, base = Storage.getPushPrefs()) {
    if (!sp) return base;
    const f = sp.features || { briefing: !!sp.briefing };
    const p = {
      city: { lat: sp.lat, lon: sp.lon, name: sp.name },
      briefing:   { enabled: !!f.briefing, hour: sp.hour, lastSentDay: sp.lastSentDay || null },
      alerts:     { enabled: !!f.alerts },
      thresholds: {
        enabled: !!f.thresholds,
        hour: Number.isInteger(sp.thresholdHour) ? sp.thresholdHour : base.thresholds.hour,
        mask: Number.isInteger(sp.thresholdMask) ? sp.thresholdMask : base.thresholds.mask,
      },
      moon:       { enabled: !!f.moon },
      sky:        { enabled: !!f.sky },
      changes:    { enabled: !!f.changes },
      nowcast:    { enabled: !!f.nowcast },
    };
    Storage.savePushPrefs(p);
    return p;
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
    for (const f of this.PUSH_FEATURES) if (els.toggle[f]) els.toggle[f].classList.toggle('is-busy', busy);
    if (els.test) els.test.disabled = busy;
  },

  _pushFeatureLabel(f) {
    return {
      briefing: 'Morning briefing', alerts: 'Severe weather alerts', thresholds: 'Threshold alerts',
      moon: 'Full moon alerts', sky: 'Sky event alerts', changes: 'Forecast change alerts',
      nowcast: 'Rain starting soon alerts',
    }[f] || f;
  },

  // Turn one feature on or off. Turning the first one on does the
  // permission prompt and the browser subscription; turning the last
  // one off removes both.
  async setPushFeature(f, on) {
    const els = this._push;
    if (!els || this._pushBusy) return;
    const p = this._pushPrefsFromScreen();
    if (on && !p.city) {
      this._renderPushStatus(f, 'Save a city first, then choose it above.', true);
      return;
    }
    this._setPushBusy(true);
    try {
      if (on) {
        // First await must be the permission prompt itself: browsers
        // require it to follow the tap without other async work between.
        let perm = Notification.permission;
        if (perm === 'default') perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          this.renderPushScreen();
          this._renderPushStatus(f,
            perm === 'denied' ? 'Notifications are blocked for WeatherDaddy.' : 'Notification permission wasn’t granted.',
            true);
          return;
        }
        const sub = await this._getPushSubscription(true);
        p[f].enabled = true;
        const data = await this._pushFetch('subscribe', { subscription: sub.toJSON(), prefs: this._pushPrefsPayload(p) });
        this._adoptServerPrefs(data && data.prefs, p);
        this.showToast(`${this._pushFeatureLabel(f)} on`);
      } else {
        p[f].enabled = false;
        const sub = await this._getPushSubscription(false);
        if (this._anyPushEnabled(p)) {
          if (sub) {
            const data = await this._pushFetch('subscribe', { subscription: sub.toJSON(), prefs: this._pushPrefsPayload(p) });
            this._adoptServerPrefs(data && data.prefs, p);
          } else {
            Storage.savePushPrefs(p);
          }
        } else {
          if (sub) {
            try { await this._pushFetch('unsubscribe', { endpoint: sub.endpoint }); }
            catch (err) { console.warn('[push] server unsubscribe failed:', err); }
            try { await sub.unsubscribe(); } catch (_) {}
          }
          p.briefing.lastSentDay = null;
          Storage.savePushPrefs(p);
        }
        this.showToast(`${this._pushFeatureLabel(f)} off`);
      }
      this.renderPushScreen();
    } catch (err) {
      console.warn('[push] toggle failed:', err);
      this.renderPushScreen();
      this._renderPushStatus(f, err && err.message ? err.message : `Couldn’t change ${this._pushFeatureLabel(f).toLowerCase()}.`, true);
    } finally {
      this._setPushBusy(false);
    }
  },

  // City, hour or checklist changed on the screen.
  _onPushPrefChange() {
    const p = this._pushPrefsFromScreen();
    Storage.savePushPrefs(p);
    for (const f of this.PUSH_FEATURES) this._renderPushStatus(f);
    if (this._anyPushEnabled(p)) this.syncPushPrefs();
  },

  // Push the stored preferences (plus current units and timezone) to
  // the server row. Debounced: unit changes come in bursts. Safe to
  // call any time — a no-op unless something is on.
  syncPushPrefs() {
    if (!this._anyPushEnabled()) return;
    if (!this.pushSupport().supported) return;
    clearTimeout(this._pushSyncTimer);
    this._pushSyncTimer = setTimeout(() => this._syncPushPrefsNow().catch(err => {
      console.warn('[push] sync failed:', err);
      if (this._push && this._push.screen.classList.contains('open')) {
        this._renderPushStatus('briefing', 'Couldn’t save changes — ' + (err && err.message ? err.message : 'offline?'), true);
      }
    }), 400);
  },

  async _syncPushPrefsNow() {
    const p = Storage.getPushPrefs();
    if (!this._anyPushEnabled(p) || !p.city) return;
    const sub = await this._getPushSubscription(false);
    if (!sub) {
      // The browser dropped the subscription behind our back.
      for (const f of this.PUSH_FEATURES) p[f].enabled = false;
      Storage.savePushPrefs(p);
      if (this._push) this.renderPushScreen();
      return;
    }
    const data = await this._pushFetch('subscribe', { subscription: sub.toJSON(), prefs: this._pushPrefsPayload(p) });
    this._adoptServerPrefs(data && data.prefs, p);
    if (this._push && this._push.screen.classList.contains('open')) {
      for (const f of this.PUSH_FEATURES) this._renderPushStatus(f);
    }
  },

  // On screen open: make what the screen shows agree with the browser
  // and the server. Offline just leaves the stored state alone.
  async _reconcilePush() {
    const support = this.pushSupport();
    if (!support.supported) return;
    const p = Storage.getPushPrefs();
    try {
      const sub = await this._getPushSubscription(false);
      if (!this._anyPushEnabled(p)) {
        // Every switch is off here, but if the browser still holds a
        // subscription the server may still be sending: clean up.
        if (sub) {
          try { await this._pushFetch('unsubscribe', { endpoint: sub.endpoint }); } catch (_) {}
          try { await sub.unsubscribe(); } catch (_) {}
        }
        return;
      }
      if (!sub || support.permission !== 'granted') {
        for (const f of this.PUSH_FEATURES) p[f].enabled = false;
        Storage.savePushPrefs(p);
        this.renderPushScreen();
        this._renderPushStatus('briefing', 'This device is no longer subscribed. Turn a notification on again to resume.', true);
        return;
      }
      const st = await this._pushFetch('status', { endpoint: sub.endpoint });
      if (!st || !st.subscribed) {
        // Server lost the row (or never had it): re-create from the
        // stored preferences rather than silently doing nothing.
        await this._syncPushPrefsNow();
        return;
      }
      this._adoptServerPrefs(st.prefs, p);
      this.renderPushScreen();
    } catch (err) {
      console.warn('[push] reconcile skipped:', err);
    }
  },

  async sendBriefingTest() {
    const els = this._push;
    if (!els || this._pushBusy) return;
    this._setPushBusy(true);
    this._renderPushStatus('briefing', 'Sending…');
    try {
      const sub = await this._getPushSubscription(false);
      if (!sub) throw new Error('This device isn’t subscribed.');
      await this._pushFetch('test', { endpoint: sub.endpoint });
      this._renderPushStatus('briefing', 'Test sent — it should appear in a moment.');
      this.showToast('Test briefing sent');
    } catch (err) {
      console.warn('[push] test failed:', err);
      if (err && err.status === 410) {
        const p = Storage.getPushPrefs();
        for (const f of this.PUSH_FEATURES) p[f].enabled = false;
        Storage.savePushPrefs(p);
        this.renderPushScreen();
      }
      this._renderPushStatus('briefing', err && err.message ? err.message : 'Couldn’t send a test.', true);
    } finally {
      this._setPushBusy(false);
    }
  },
});

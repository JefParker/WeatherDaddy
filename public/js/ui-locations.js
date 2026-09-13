// WeatherDaddy UI — the saved-locations list (tap to select, long-press / drag to reorder).
//
// One of the ui-*.js files that extend the UI object defined in ui.js.
// No build step: index.html loads ui.js first, then these in order,
// then app.js. Methods reference each other only at call time, so
// cross-file calls resolve once every script has run. When adding a
// file, list it in index.html AND in sw.js ASSETS_TO_CACHE.

Object.assign(UI, {
  renderSavedLocations(list, onSelect, onDelete, onReorder) {
    if (!list || list.length === 0) {
      this.savedLocationsList.innerHTML = '<div style="color: #a0a0a0; text-align: center; padding: 20px;">No saved locations.</div>';
      return;
    }

    this.savedLocationsList.innerHTML = list.map((item, index) => `
      <div class="location-card" data-index="${index}">
        <div class="location-card-name">${this.esc(this.prettifyLocationName(item.name))}</div>
        <button class="delete-location-btn" data-index="${index}" aria-label="Delete location">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    `).join('');

    this._bindCardInteractions(list, onSelect, onReorder);

    this.savedLocationsList.querySelectorAll('.delete-location-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDelete(parseInt(btn.getAttribute('data-index'), 10));
      });
    });
  },

  // Pointer-Events reorder handler for the saved-locations list.
  //
  // Cards default to CSS `touch-action: pan-y` so the list scrolls
  // normally; `.dragging` switches to `touch-action: none` for the
  // duration of a drag. Drag-to-reorder must be intentionally invoked:
  //   - Mouse: press + move past 6px → drag immediately.
  //   - Touch: press and hold 350ms without significant movement → drag
  //     mode; any earlier movement cancels the timer and lets the
  //     browser scroll.
  // Once drag mode begins, pointermove preventDefault()s to claim the
  // gesture (the browser hasn't committed to a scroll yet because the
  // finger was still during the long-press). Pointer up without ever
  // entering drag mode → tap → select.
  _bindCardInteractions(list, onSelect, onReorder) {
    const DRAG_THRESHOLD = 6; // px before press is treated as drag
    const cards = Array.from(this.savedLocationsList.querySelectorAll('.location-card'));

    const measure = () => cards.map(c => {
      const r = c.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, mid: r.top + r.height / 2, height: r.height };
    });

    cards.forEach(card => {
      const fromIdx = parseInt(card.getAttribute('data-index'), 10);
      let suppressClick = false;
      let dragging = false;

      // Prevent scrolling when dragging is active
      card.addEventListener('touchmove', (e) => {
        if (dragging) e.preventDefault();
      }, { passive: false });

      card.addEventListener('click', (e) => {
        if (e.target.closest('.delete-location-btn')) return;
        if (suppressClick) {
          suppressClick = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        onSelect(list[fromIdx]);
      });

      card.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.delete-location-btn')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;

        const pointerId = e.pointerId;
        const startX    = e.clientX;
        const startY    = e.clientY;
        const isTouch   = e.pointerType !== 'mouse';

        dragging      = false;
        let rects     = null;
        let toIdx     = fromIdx;
        let indicator = null;
        let tiltDeg   = 0;
        let dragTimer = null;

        // Touch pointers are implicitly captured by their starting element,
        // and explicit capture can break native scrolling. Mouse needs it.
        if (!isTouch) {
          try { card.setPointerCapture?.(pointerId); } catch (_) {}
        }

        const enterDragMode = () => {
          if (dragging) return;
          dragging = true;
          rects = measure();
          card.classList.add('dragging');
          // Tilt toward the side being touched for tactile drag feedback.
          const cardRect = card.getBoundingClientRect();
          const cardCenterX = cardRect.left + cardRect.width / 2;
          tiltDeg = startX < cardCenterX ? -1.5 : 1.5;
          indicator = document.createElement('div');
          indicator.className = 'drop-indicator';
          this.savedLocationsList.appendChild(indicator);
          document.body.style.userSelect = 'none';
          if (isTouch && navigator.vibrate) navigator.vibrate(15);
        };

        if (isTouch) {
          dragTimer = setTimeout(() => enterDragMode(), 350);
        }

        const onMove = (ev) => {
          if (ev.pointerId !== pointerId) return;
          const dy = ev.clientY - startY;
          const dx = ev.clientX - startX;

          if (!dragging) {
            if (isTouch) {
              if (Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
                if (dragTimer) clearTimeout(dragTimer);
                dragTimer = null;
              }
              return;
            } else {
              if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
              enterDragMode();
            }
          }

          if (ev.cancelable) ev.preventDefault();

          card.style.transform = `translateY(${dy}px) rotateZ(${tiltDeg}deg)`;

          const y = ev.clientY;
          let insertAt = rects.length;
          for (let i = 0; i < rects.length; i++) {
            if (i === fromIdx) continue;
            if (y < rects[i].mid) { insertAt = i; break; }
          }
          if (insertAt > fromIdx) insertAt -= 1;
          toIdx = insertAt;

          const listRect = this.savedLocationsList.getBoundingClientRect();
          const visualIdx = toIdx >= fromIdx ? toIdx + 1 : toIdx;
          const indicatorY = visualIdx >= rects.length
            ? rects[rects.length - 1].bottom - listRect.top
            : rects[visualIdx].top - listRect.top;
          indicator.style.transform = `translateY(${indicatorY}px)`;
        };

        // The measured rects are viewport coordinates captured at drag
        // start — a wheel/momentum scroll mid-drag would silently shift
        // every drop target. Re-measure whenever any ancestor scrolls
        // (capture catches scrolls on the overlay's scroll container).
        const onAnyScroll = () => { if (dragging) rects = measure(); };
        window.addEventListener('scroll', onAnyScroll, { capture: true, passive: true });

        const cleanup = () => {
          card.removeEventListener('pointermove', onMove);
          card.removeEventListener('pointerup', onUp);
          card.removeEventListener('pointercancel', onCancel);
          window.removeEventListener('scroll', onAnyScroll, { capture: true });
          try { card.releasePointerCapture?.(pointerId); } catch (_) {}
        };

        const onUp = (ev) => {
          if (ev.pointerId !== pointerId) return;
          if (dragTimer) clearTimeout(dragTimer);
          cleanup();

          if (!dragging) return; // tap → click handler runs

          card.style.transform = '';
          card.classList.remove('dragging');
          document.body.style.userSelect = '';
          if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);

          suppressClick = true;
          setTimeout(() => { suppressClick = false; }, 250);

          if (toIdx !== fromIdx) onReorder(fromIdx, toIdx);
        };

        const onCancel = (ev) => {
          if (ev.pointerId !== pointerId) return;
          if (dragTimer) clearTimeout(dragTimer);
          cleanup();
          if (!dragging) return;
          card.style.transform = '';
          card.classList.remove('dragging');
          document.body.style.userSelect = '';
          if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
        };

        card.addEventListener('pointermove', onMove, { passive: false });
        card.addEventListener('pointerup', onUp);
        card.addEventListener('pointercancel', onCancel);
      });
    });
  },
});

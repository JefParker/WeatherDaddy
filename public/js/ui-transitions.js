// WeatherDaddy UI — 3D cube transitions, the FLIP hero-slide and the swipe recogniser.
//
// One of the ui-*.js files that extend the UI object defined in ui.js.
// No build step: index.html loads ui.js first, then these in order,
// then app.js. Methods reference each other only at call time, so
// cross-file calls resolve once every script has run. When adding a
// file, list it in index.html AND in sw.js ASSETS_TO_CACHE.

Object.assign(UI, {
  async closeOverlayWithCube(overlayId) {
    const overlay = document.getElementById(overlayId);
    if (!overlay || !overlay.classList.contains('open')) return;

    // Remove focus to prevent virtual keyboard popping up during transition
    if (document.activeElement) document.activeElement.blur();

    // Hide the overlay immediately so the main app is visible underneath
    // (though our perspective wrapper will cover it)
    overlay.classList.remove('open');

    // Landscape two-column layout: animate each column on its own cube,
    // matching the city-swipe dual-cube transition. Without this branch,
    // the portrait code below renders a single 500px-wide cube anchored
    // at viewport center, which looks like an awkward floating sliver
    // in the middle of a wide landscape dashboard.
    const isTwoColumn = getComputedStyle(this.weatherView).display === 'grid';
    const leftEl  = this.weatherView.querySelector('.dashboard-left');
    const rightEl = this.weatherView.querySelector('.dashboard-right');
    if (isTwoColumn && leftEl && rightEl) {
      return this._closeOverlayWithDualCube(overlay, leftEl, rightEl);
    }

    const overlayClone = overlay.cloneNode(true);
    overlayClone.style.transform = 'none'; // Ensure the clone is visible
    const front = this._makeCubeFace('cube-face-front', true, overlayClone); // clone — strip its duplicated ids

    // Clone the main app to place on the incoming face
    const headerClone = document.querySelector('.app-header').cloneNode(true);
    const mainClone = document.querySelector('.main-content').cloneNode(true);

    const fakeApp = document.createElement('div');
    fakeApp.className = 'app-container';
    fakeApp.style.height = '100%';
    fakeApp.style.overflow = 'hidden';
    fakeApp.style.position = 'relative';

    // Disable position sticky on the clone so it doesn't do anything weird
    headerClone.style.position = 'relative';
    headerClone.style.zIndex = '10';

    // Shift the main content up to match the scroll position
    mainClone.style.transform = `translateY(-${window.scrollY}px)`;

    fakeApp.appendChild(headerClone);
    fakeApp.appendChild(mainClone);
    // We rotate right, so the left face slides in. Clones of the whole
    // header + main content: without stripping, #weather-view /
    // #save-btn / #city-clock etc. are duplicated in document.body and
    // getElementById can resolve to the dead copy.
    const back = this._makeCubeFace('cube-face-left', true, fakeApp);

    const stage = this._makeCubeStage(front, back);
    stage.style.width = '100%';
    stage.style.height = '100%';

    const perspective = this._makeCubePerspective(stage);
    Object.assign(perspective.style, {
      position: 'fixed', top: '0', left: '50%', transform: 'translateX(-50%)',
      width: '100%', maxWidth: '500px', height: '100%', zIndex: '9999'
    });
    document.body.appendChild(perspective);

    await this._spinCube(stage, 'rotate-right');
    perspective.remove();
  },

  // Landscape variant of closeOverlayWithCube: two fixed-position
  // perspectives stacked over the live .dashboard-left / .dashboard-right
  // wrappers, each spinning in parallel like the city-swipe dual cube.
  //
  // Front face of each cube: a full-viewport clone of the overlay, offset
  // so the slice visible through the column-shaped face shows exactly the
  // portion of the overlay that was sitting over that column. Combined,
  // the two front faces look like the unbroken overlay.
  //
  // Back face: a clone of the corresponding column wrapper, so as the
  // cubes rotate, the overlay halves spin away and the column halves of
  // the dashboard spin in.
  async _closeOverlayWithDualCube(overlay, leftEl, rightEl) {
    const leftRect  = leftEl.getBoundingClientRect();
    const rightRect = rightEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const buildSide = (rect, columnEl) => {
      // ----- Front face: full-viewport overlay clone, clipped -----
      const overlayClone = overlay.cloneNode(true);
      // Force the clone into absolute positioning relative to the front
      // face so we can place it deterministically — bypasses any
      // position:fixed-in-transformed-ancestor quirks.
      overlayClone.style.position  = 'absolute';
      overlayClone.style.left      = `${-rect.left}px`;
      overlayClone.style.top       = `${-rect.top}px`;
      overlayClone.style.width     = `${vw}px`;
      overlayClone.style.height    = `${vh}px`;
      overlayClone.style.maxWidth  = 'none';
      overlayClone.style.transform = 'none';
      // Front face already has overflow:hidden via .cube-face CSS, so
      // only the column-shaped slice of the overlay will be visible.
      const front = this._makeCubeFace('cube-face-front', true, overlayClone); // clone — strip its duplicated ids

      // ----- Back face: clone of the column wrapper -----
      const colClone = columnEl.cloneNode(true);
      colClone.style.transform = 'none';
      // Fill the cube face so the clone matches the real column's render.
      const back = this._makeCubeFace('cube-face-left', true, colClone); // rotate-right brings this in

      const stage = this._makeCubeStage(front, back);
      // Cube depth tuned per column so each side's rotation looks correct
      // at its actual width (instead of the global 250px default that's
      // sized for the portrait 500px cube).
      const perspective = this._makeCubePerspective(stage, { cubeHalf: rect.width / 2 });
      Object.assign(perspective.style, {
        position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '9999'
      });
      document.body.appendChild(perspective);
      return { perspective, stage };
    };

    const left  = buildSide(leftRect,  leftEl);
    const right = buildSide(rightRect, rightEl);

    await this._spinCube([left.stage, right.stage], 'rotate-right');
    left.perspective.remove();
    right.perspective.remove();
  },

  // True while a city-swipe cube (either variant) is mid-flight.
  // App.renderAll() checks it and parks the render in _deferredRender
  // instead of wiping #weather-view under the animation; _cubeDone()
  // replays the parked render once the cube resolves.
  _cubeAnimating: false,
  _deferredRender: null,

  _cubeDone() {
    this._cubeAnimating = false;
    const deferred = this._deferredRender;
    this._deferredRender = null;
    if (deferred) deferred();
  },

  // Hygiene for cube faces, applied for the duration of a spin:
  //   - aria-hidden + inert so the face's copy of the app is invisible
  //     to assistive tech and unreachable via the tab order (without
  //     this, a screen reader sees the whole dashboard twice).
  //   - stripIds=true additionally removes every id in the face so
  //     getElementById can't resolve to dead DOM while both faces are
  //     mounted (e.g. the clock timer ticking a stale #city-clock).
  //     MUST stay false for faces holding LIVE nodes (city-cube back
  //     faces — those nodes return to the document when the cube lands)
  //     and for faces whose SVG needs its gradient id to paint.
  _prepCubeFace(face, stripIds) {
    if (stripIds) {
      face.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
    }
    face.setAttribute('aria-hidden', 'true');
    face.inert = true;
  },

  // ── Cube-transition building blocks ─────────────────────────────────
  // Five transitions share this scaffold — overlay close (one cube, or
  // two side by side in landscape), city swipe (likewise), and the
  // element cube behind the graph and the stats pager. Each site only
  // decides what goes on the two faces, where the perspective mounts,
  // and what to do once the spin lands.

  // One face. `content` is a Node, an array of Nodes (moved, not
  // cloned — listeners survive), or an HTML string. stripIds per
  // _prepCubeFace: true for clones, false for live nodes or for markup
  // whose ids must keep working mid-spin (the graph gradient).
  _makeCubeFace(faceClass, stripIds, content) {
    const face = document.createElement('div');
    face.className = 'cube-face ' + faceClass;
    if (typeof content === 'string') {
      face.innerHTML = content;
    } else if (content) {
      for (const node of [].concat(content)) face.appendChild(node);
    }
    this._prepCubeFace(face, stripIds);
    return face;
  },

  _makeCubeStage(front, back) {
    const stage = document.createElement('div');
    stage.className = 'cube-stage';
    stage.appendChild(front);
    stage.appendChild(back);
    return stage;
  },

  // Perspective wrapper around a stage. `height` in px. `cubeHalf`
  // overrides the CSS --cube-half depth — half the face's width, or its
  // height for X-axis spins — where the portrait default (sized for one
  // ~500px cube) would be wrong.
  _makeCubePerspective(stage, { height, cubeHalf } = {}) {
    const perspective = document.createElement('div');
    perspective.className = 'cube-perspective';
    if (height != null) perspective.style.height = `${height}px`;
    if (cubeHalf != null) perspective.style.setProperty('--cube-half', `${cubeHalf}px`);
    perspective.appendChild(stage);
    return perspective;
  },

  // Play the rotation. Forces a layout, then adds the rotate class on
  // the next frame so the transition actually runs instead of collapsing
  // into one frame. Every stage passed gets the class on the SAME frame
  // (the landscape dual cubes spin in lockstep). Resolves on the first
  // stage's transitionend, or after 800ms if that never fires (tab
  // backgrounded) — whichever comes first, exactly once.
  _spinCube(stages, rotateClass) {
    const list = [].concat(stages);
    return new Promise((resolve) => {
      list.forEach(s => { void s.offsetHeight; });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          list.forEach(s => s.classList.add(rotateClass));
        });
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      list[0].addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 800);
    });
  },

  // Run a 3D cube-rotation transition between two dashboards. The current
  // contents of #weather-view (the NEW city, which the caller has already
  // rendered) are moved onto one side of the cube; the supplied snapshot of
  // the OLD city goes on the front face. Resolves once the rotation
  // completes and the new content has been restored to #weather-view with
  // its event listeners intact.
  //
  //   direction = 'next' → cube rotates left, new city was on the right face
  //   direction = 'prev' → cube rotates right, new city was on the left face
  async runCubeTransition(oldClone, direction) {
    if (!this.weatherView.firstChild) return; // nothing new to show

    // Mark the transition in-flight BEFORE any frame/timer work so a
    // concurrent renderAll() (auto-refresh, visibilitychange, refresh
    // button, byok:changed) defers instead of re-rendering mid-spin —
    // its innerHTML swap would detach the cube and finish() would then
    // re-append the animating nodes AFTER the fresh dashboard,
    // duplicating the whole view.
    this._cubeAnimating = true;

    // Landscape two-column layout: animate each column on its own cube,
    // rotating in parallel — looks like two cards flipping side by side
    // instead of one big cube swallowing the whole dashboard.
    const isTwoColumn = getComputedStyle(this.weatherView).display === 'grid';
    if (isTwoColumn) {
      const oldLeft  = oldClone.querySelector('.dashboard-left');
      const oldRight = oldClone.querySelector('.dashboard-right');
      const newLeft  = this.weatherView.querySelector('.dashboard-left');
      const newRight = this.weatherView.querySelector('.dashboard-right');
      if (oldLeft && oldRight && newLeft && newRight) {
        return this._runTwoColumnCubeTransition(oldLeft, oldRight, newLeft, newRight, direction);
      }
      // Fall through to single-cube if the wrappers somehow aren't present
      // (older cached DOM, etc.) — better to play any animation than none.
    }

    const isNext = direction === 'next';

    // Use the taller of the two so neither face gets clipped during the spin.
    const oldHeight = oldClone.offsetHeight ||
      Array.from(oldClone.childNodes).reduce((h, n) => h + (n.offsetHeight || 0), 0);
    const newHeight = this.weatherView.offsetHeight;
    const stageHeight = Math.max(oldHeight, newHeight, 400);

    // Old dashboard (a clone) on the front — strip its duplicated ids.
    const front = this._makeCubeFace('cube-face-front', true, Array.from(oldClone.childNodes));
    // Move (not clone) the freshly-rendered NEW dashboard onto the incoming
    // face so its event listeners survive. LIVE nodes — ids must survive.
    const back = this._makeCubeFace(
      isNext ? 'cube-face-right' : 'cube-face-left', false, Array.from(this.weatherView.childNodes));
    const stage = this._makeCubeStage(front, back);
    const perspective = this._makeCubePerspective(stage, { height: stageHeight });
    this.weatherView.appendChild(perspective);

    await this._spinCube(stage, isNext ? 'rotate-left' : 'rotate-right');

    // Restore the new dashboard's nodes to weather-view so the rest of
    // the app continues to find them via getElementById/querySelector —
    // but only while the cube is still mounted. If something replaced
    // #weather-view's contents mid-spin (showLoading, showError), the
    // nodes held in `back` are stale and re-appending them would
    // duplicate the dashboard.
    if (perspective.isConnected) {
      while (back.firstChild) this.weatherView.appendChild(back.firstChild);
    }
    perspective.remove();
    this._cubeDone();
  },

  // Landscape (two-column) variant of the city-swipe cube. Builds two
  // independent cubes — one per column — and rotates them in parallel,
  // so visually each half of the dashboard spins as its own card.
  //
  //   oldLeft/oldRight  — column wrappers cloned from the OUTGOING DOM
  //                       (detached nodes inside oldClone). Move them
  //                       onto each cube's front face.
  //   newLeft/newRight  — the live wrappers currently mounted under
  //                       #weather-view. Moving them onto the cube backs
  //                       takes them out of the grid while the cube
  //                       animates; we put them back when it's done.
  //
  // Per-column --cube-half is set from the measured wrapper width so
  // the 3D depth math is correct for each column's actual width (rather
  // than the global 50vw / 250px default, which assumes the portrait
  // layout's ~500px-wide single cube).
  async _runTwoColumnCubeTransition(oldLeft, oldRight, newLeft, newRight, direction) {
    const isNext = direction === 'next';
    const rotateClass   = isNext ? 'rotate-left' : 'rotate-right';
    const backFaceClass = isNext ? 'cube-face-right' : 'cube-face-left';

    const buildColumn = (oldCol, newCol, gridColumn) => {
      // Measure BEFORE moving, while the new column is still in the
      // grid — once detached its offsetWidth/Height go to 0.
      const colWidth = newCol.offsetWidth || oldCol.offsetWidth || 300;
      const stageHeight = Math.max(
        oldCol.offsetHeight || 0,
        newCol.offsetHeight || 0,
        200
      );

      const front = this._makeCubeFace('cube-face-front', true, oldCol); // clone — strip its duplicated ids
      const back  = this._makeCubeFace(backFaceClass, false, newCol);    // LIVE nodes — ids must survive
      const stage = this._makeCubeStage(front, back);
      const perspective = this._makeCubePerspective(stage, { height: stageHeight, cubeHalf: colWidth / 2 });
      perspective.style.gridColumn = gridColumn;
      perspective.style.gridRow = '1';
      return { perspective, stage };
    };

    const left  = buildColumn(oldLeft,  newLeft,  '1');
    const right = buildColumn(oldRight, newRight, '2');

    this.weatherView.appendChild(left.perspective);
    this.weatherView.appendChild(right.perspective);

    await this._spinCube([left.stage, right.stage], rotateClass);

    // Restore the new wrappers back into weather-view so the rest
    // of the app continues to find them via querySelector. Grid
    // placement is by class (.dashboard-left → col 1, etc.), so
    // append order doesn't matter. Skip the restore if the cubes
    // were detached mid-spin (see runCubeTransition) — the wrappers
    // are stale then and would duplicate the view.
    if (left.perspective.isConnected || right.perspective.isConnected) {
      this.weatherView.appendChild(newLeft);
      this.weatherView.appendChild(newRight);
    }
    left.perspective.remove();
    right.perspective.remove();
    this._cubeDone();
  },

  // FLIP-style slide shared by the daily-list rows and the hourly tiles:
  // capture the source's temperature + icon (rects, markup, computed type
  // metrics) BEFORE the re-render, and return a continuation that, once
  // the new hero is in the DOM, floats ghost clones from the source up to
  // the hero's temperature and icon slots.
  //
  // The ghost is anchored to the hero's center and animates two things in
  // parallel: a transform translation (centers travel from source → hero)
  // and the *real* font-size / img dimensions (text grows smoothly instead
  // of being scaled bitmap-style). When the transition lands, the ghost is
  // already at the hero's exact computed type metrics, so swapping it for
  // the real hero element produces no visible pop.
  //
  //   src.tempEl / src.iconEl — the small source elements
  //   src.tempRect / src.tempHTML — optional overrides (the Today row
  //                                 flies just its high number)
  //   findNewSource() — the source's counterparts in the re-rendered DOM,
  //                     hidden for the flight so the number isn't seen twice
  _captureForHeroSlide(src, findNewSource) {
    const { tempEl, iconEl } = src;
    // Weather icons render as <img> now (was inline <svg>); the size
    // animation targets that element.
    const iconImg = iconEl && iconEl.querySelector('img, svg');
    if (!tempEl || !iconEl || !iconImg) return null;

    const tempRect = src.tempRect || tempEl.getBoundingClientRect();
    const iconRect = iconEl.getBoundingClientRect();
    const tempHTML = src.tempHTML || tempEl.outerHTML;
    const iconHTML = iconEl.outerHTML;

    const srcTempCS = getComputedStyle(tempEl);
    const srcTempFS     = srcTempCS.fontSize;
    const srcTempWeight = srcTempCS.fontWeight;
    const srcIconSize   = getComputedStyle(iconImg).width; // square

    return () => {
      const heroTemp = this.weatherView.querySelector('.hero-temp-large');
      const heroIcon = this.weatherView.querySelector('.hero-icon-large');
      const heroIconImg = heroIcon && heroIcon.querySelector('img, svg');
      if (!heroTemp || !heroIcon || !heroIconImg) return;

      const destTempRect = heroTemp.getBoundingClientRect();
      const destIconRect = heroIcon.getBoundingClientRect();
      const destTempCS   = getComputedStyle(heroTemp);
      const destTempFS     = destTempCS.fontSize;
      const destTempWeight = destTempCS.fontWeight;
      const destIconSize   = getComputedStyle(heroIconImg).width;

      const hidden = [heroTemp, heroIcon, ...(findNewSource ? findNewSource() : [])].filter(Boolean);
      hidden.forEach(el => el.classList.add('hero-slide-hidden'));

      const tempGhost = this._makeSlideGhost(
        tempHTML, tempRect, destTempRect,
        (inner) => {
          inner.style.fontSize   = srcTempFS;
          inner.style.fontWeight = srcTempWeight;
        },
        (inner) => {
          inner.style.fontSize   = destTempFS;
          inner.style.fontWeight = destTempWeight;
        },
      );

      const iconGhost = this._makeSlideGhost(
        iconHTML, iconRect, destIconRect,
        (inner) => {
          const img = inner.querySelector('img, svg');
          if (img) { img.style.width = srcIconSize; img.style.height = srcIconSize; }
        },
        (inner) => {
          const img = inner.querySelector('img, svg');
          if (img) { img.style.width = destIconSize; img.style.height = destIconSize; }
        },
      );

      setTimeout(() => {
        tempGhost.remove();
        iconGhost.remove();
        hidden.forEach(el => el.classList.remove('hero-slide-hidden'));
      }, 560);
    };
  },

  // Anchor: position the ghost so its center sits exactly on the hero
  // element's center, then translate by (src - dest) to start it on the
  // source. Animating the translation back to (0,0) lands it on the hero
  // regardless of how the ghost's auto-sizing reflows mid-animation.
  _makeSlideGhost(html, srcRect, destRect, applyStart, applyEnd) {
    const ghost = document.createElement('div');
    ghost.className = 'day-slide-ghost';
    const destCX = destRect.left + destRect.width  / 2;
    const destCY = destRect.top  + destRect.height / 2;
    const srcCX  = srcRect.left  + srcRect.width   / 2;
    const srcCY  = srcRect.top   + srcRect.height  / 2;
    ghost.style.left = `${destCX}px`;
    ghost.style.top  = `${destCY}px`;
    ghost.innerHTML = html;
    const inner = ghost.firstElementChild;
    applyStart(inner);
    // Centered on dest, offset back to src for frame 0.
    ghost.style.transform = `translate(calc(-50% + ${srcCX - destCX}px), calc(-50% + ${srcCY - destCY}px))`;
    document.body.appendChild(ghost);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ghost.classList.add('day-slide-ghost--flying');
        ghost.style.transform = 'translate(-50%, -50%)';
        applyEnd(inner);
      });
    });
    return ghost;
  },

  // Daily-list row → hero. See _captureForHeroSlide.
  captureDayRowForHeroSlide(rowEl) {
    if (!rowEl) return null;
    const tempEl = rowEl.querySelector('.daily-temps');
    const iconEl = rowEl.querySelector('.daily-icon');
    if (!tempEl) return null;
    const rowIndex = rowEl.getAttribute('data-index');
    const src = { tempEl, iconEl };

    // The hero shows a single current temp on Today, but two numbers
    // (high / low) on every other day. When the user taps the Today row,
    // flying the row's "hi° / lo°" up and then snapping it into the
    // single hero number looks like a pop. Detect the Today row by its
    // label text and rebuild the ghost source as just the high number,
    // anchored to the high number's actual rect (via Range) so it
    // launches from the right spot instead of the full "hi / lo" left
    // edge.
    const dayLabel = rowEl.querySelector('.daily-day');
    const isTodayRow = !!(dayLabel && dayLabel.textContent.trim() === 'Today');
    if (isTodayRow) {
      const fullText = tempEl.textContent || '';
      // Row format from the renderer is `${max}° / ${min}°` — split on
      // " /" so we keep the degree glyph attached to the high number.
      const sepIdx = fullText.indexOf(' /');
      const highText = sepIdx > -1 ? fullText.slice(0, sepIdx) : fullText;

      const textNode = tempEl.firstChild;
      if (textNode && textNode.nodeType === Node.TEXT_NODE && highText.length > 0) {
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, Math.min(highText.length, textNode.length));
        const r = range.getBoundingClientRect();
        if (r.width > 0) src.tempRect = r;
      }
      src.tempHTML = `<span class="daily-temps">${this.esc(highText)}</span>`;
    }

    return this._captureForHeroSlide(src, () => {
      const newRow = this.weatherView.querySelector(`.daily-item[data-index="${rowIndex}"]`);
      return newRow
        ? [newRow.querySelector('.daily-temps'), newRow.querySelector('.daily-icon')]
        : [];
    });
  },

  // Hourly tile → hero. Same flight as the daily rows, sourced from the
  // small tile in the scroller. The tile itself doesn't change on
  // re-render (it just sprouts a pinned highlight), so it's located by
  // data-dt to hide its real temp/icon for the duration.
  captureHourlyTileForHeroSlide(tileEl) {
    if (!tileEl) return null;
    const tileDt = tileEl.getAttribute('data-dt');
    return this._captureForHeroSlide(
      { tempEl: tileEl.querySelector('.hourly-temp'), iconEl: tileEl.querySelector('.hourly-icon') },
      () => {
        const newTile = this.weatherView.querySelector(`.hourly-tile[data-dt="${tileDt}"]`);
        return newTile
          ? [newTile.querySelector('.hourly-temp'), newTile.querySelector('.hourly-icon')]
          : [];
      }
    );
  },

  // Switch to a different forecast day and play the graph's 3D cube
  // rotation between the outgoing and incoming chart. Used by both the
  // graph swipe gesture, clicks on the daily-list rows, and scroll-driven
  // day changes from the hourly bar.
  //
  // snapHourly = true → after re-render, scroll the hourly bar to frame
  //   the new active day's first tile (right for clicks/swipes from
  //   outside the hourly bar). false → preserve current scroll position
  //   (right for scroll-driven day changes initiated from within the bar).
  changeDayWithGraphCube(newIdx, direction, onDayClick, snapHourly = true) {
    const graphEl = document.getElementById('graph-container');
    // Mid city-swipe (this._cubeAnimating) two things break the cube
    // path: #graph-container resolves to the outgoing clone on the cube
    // face, and onDayClick's renderAll() is parked, so "re-renders
    // dashboard" below doesn't hold. Take the no-animation path — the
    // selection still lands and the deferred render paints the right
    // day once the city cube resolves.
    if (!graphEl || this._graphCubeAnimating || this._cubeAnimating) {
      this._snapHourlyToActiveDay = snapHourly;
      onDayClick(newIdx);
      return;
    }
    const oldGraphHTML = graphEl.innerHTML;
    this._snapHourlyToActiveDay = snapHourly;
    onDayClick(newIdx); // re-renders dashboard; #graph-container now holds the new SVG

    const newEl = document.getElementById('graph-container');
    if (!newEl) return;
    const newGraphHTML = newEl.innerHTML;

    this._graphCubeAnimating = true;
    this.runElementCubeTransition(newEl, oldGraphHTML, newGraphHTML, direction)
      .finally(() => { this._graphCubeAnimating = false; });
  },

  // Cube transition scoped to a single element — used for the temperature
  // graph so that only the chart itself rotates when the user swipes to
  // another day. oldHTML and newHTML are inner-HTML snapshots (pure SVG
  // markup, no event listeners to preserve), so we just swap text content.
  //
  // `direction` picks the rotation axis as well as the way round:
  //   'next' / 'prev' — about the vertical axis (day changes, stats pager)
  //   'up'   / 'down' — about the horizontal axis (the graph's rain/wind
  //                     series flip, so a mode change doesn't read as
  //                     another day change)
  async runElementCubeTransition(targetEl, oldHTML, newHTML, direction) {
    if (!targetEl) return;
    const BACK_FACE = { next: 'cube-face-right', prev: 'cube-face-left', up: 'cube-face-bottom', down: 'cube-face-top' };
    const ROTATE    = { next: 'rotate-left',     prev: 'rotate-right',   up: 'rotate-up',        down: 'rotate-down' };
    const isVerticalAxis = direction === 'up' || direction === 'down';
    const height = targetEl.offsetHeight || 200;

    // Don't strip ids here: the graph SVG needs its (per-render unique)
    // gradient id to paint during the spin. Hide from AT / tab order only.
    const front = this._makeCubeFace('cube-face-front', false, oldHTML);
    const back  = this._makeCubeFace(BACK_FACE[direction] || 'cube-face-right', false, newHTML);
    const stage = this._makeCubeStage(front, back);
    // X-axis rotation: the face depth is half the face HEIGHT — the
    // default --cube-half is sized for the wide Y-axis cubes and would
    // make a 200px-tall graph fly absurdly far out of plane.
    const perspective = this._makeCubePerspective(stage, {
      height,
      cubeHalf: isVerticalAxis ? height / 2 : undefined
    });

    // Replace the element's content with the cube while we animate.
    targetEl.innerHTML = '';
    targetEl.appendChild(perspective);

    await this._spinCube(stage, ROTATE[direction] || 'rotate-left');
    targetEl.innerHTML = newHTML;
  },

  // ── Horizontal-swipe recogniser ─────────────────────────────────────
  // Shared by the city swipe (document-wide), the graph's day swipe and
  // the stats pager. Pointer Events throughout. A press becomes a swipe
  // once |dx| > 10px AND beats |dy| by SLOP — from then on the gesture is
  // claimed (preventDefault) and `onNudge(dx)` follows the finger. On
  // release, |dx| ≥ THRESHOLD fires `onSwipe('next' | 'prev')` ('next'
  // is leftward, like turning a page).
  //
  //   hitEl        — element (or document) that receives the pointer events
  //   shouldStart  — optional predicate on pointerdown; return false to ignore
  //   onStart      — once, when the press is recognised as horizontal
  //   onNudge(dx)  — follow-the-finger feedback while horizontal
  //   onRelease()  — undo the nudge; runs on every up/cancel after a nudge
  //   onSwipe(dir) — the committed gesture
  _bindHorizontalSwipe(hitEl, { shouldStart, onStart, onNudge, onRelease, onSwipe }) {
    const THRESHOLD = 50;  // px of horizontal travel to count as a swipe
    const SLOP      = 1.2; // dx must beat dy by this factor → horizontal
    let startX = 0, startY = 0, pointerId = null, tracking = false, peeking = false;

    hitEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (shouldStart && shouldStart(e) === false) return;
      startX = e.clientX;
      startY = e.clientY;
      pointerId = e.pointerId;
      tracking = true;
      peeking = false;
    });

    hitEl.addEventListener('pointermove', (e) => {
      if (!tracking || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Only take over the gesture once it's clearly horizontal.
      if (!peeking && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * SLOP) {
        peeking = true;
        if (onStart) onStart();
      }
      if (peeking) {
        if (e.cancelable) e.preventDefault();
        if (onNudge) onNudge(dx);
      }
    }, { passive: false });

    const end = (e, cancelled) => {
      if (!tracking || e.pointerId !== pointerId) return;
      tracking = false;
      const wasPeeking = peeking;
      if (wasPeeking && onRelease) onRelease();
      if (cancelled || !wasPeeking) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) < THRESHOLD) return;
      onSwipe(dx < 0 ? 'next' : 'prev');
    };
    hitEl.addEventListener('pointerup', (e) => end(e, false));
    hitEl.addEventListener('pointercancel', (e) => end(e, true));
  },

  // Ease a nudged element back to rest.
  _releaseNudge(el) {
    el.style.transition = 'transform 0.2s ease';
    el.style.transform = '';
    setTimeout(() => { el.style.transition = ''; }, 220);
  },
});

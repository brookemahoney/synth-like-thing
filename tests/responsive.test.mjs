/**
 * responsive.test.mjs — the RENDERED layout, at a phone and at a desktop.
 * `node --test tests/responsive.test.mjs`
 *
 * WHY THIS FILE EXISTS
 *   `paint.test.mjs` claims "the layout cannot overflow", and it passes, and the
 *   page still scrolled 218px sideways at 390px. That test reads the STYLESHEET —
 *   does it say `min-width: 0`? — and the keybed did not exist when it was written.
 *   49 keys at 14px each is 608px of content inside a 390px window, and the whole
 *   document was dragged sideways by it.
 *
 *   So every claim below is a NUMBER READ OUT OF A RENDERED PAGE at a named
 *   viewport. Nothing here reads a stylesheet, and nothing here asserts that a
 *   string is present: if the layout regresses, a number moves and this goes red.
 *
 * WHAT IT CLAIMS
 *   at 390x844
 *     - the document does not scroll sideways, and it is not `overflow: hidden`
 *       on <html> or <body> to achieve that (hiding it makes keys unreachable,
 *       which is worse than the defect it hides);
 *     - every element that pokes past the viewport is inside a scroll container
 *       that can reach it;
 *     - all eight regions are present, in REGION_ORDER, top to bottom, and none is
 *       clipped or hidden;
 *     - the keybed is its own horizontal scroll container, holds all KEY_COUNT
 *       keys, and every one of the 49 is reachable by scrolling it;
 *     - the black keys still sit on the boundary between the two white keys they
 *       belong to — the one piece of geometry a scroll container can break, since
 *       keyboard.js places them with `left: 50%` of a grid area — and they still do
 *       after the bed is scrolled;
 *     - a mouse drag across a SCROLLED keybed still retargets the note, and the
 *       sounding note is read from the engine's own held-note registry rather than
 *       from a class name.
 *   at 1600x1000
 *     - nothing regressed: the keybed does not scroll at all, all 49 keys are
 *       visible at once, and no narrow-viewport rule is in force up there.
 *
 * HOW IT RUNS
 *   It drives a real browser through `playwright-cli`, the same tool
 *   scripts/verify.mjs uses: no node_modules, no bundler, nothing added to the
 *   docroot. A browser is an ENVIRONMENT, not a dependency. Where there is no
 *   browser or no served docroot — CI runs `node --test` on a bare runner, for the
 *   reason CONTRIBUTING.md gives — the file skips with a printed reason instead of
 *   going red for something that is not the code's fault. Once the page has opened,
 *   nothing here is allowed to skip: a broken page is a failure, not an excuse.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { KEY_COUNT, KEY_HIGH, KEY_LOW } from '../web/ui/keyboard.js';
import { REGION_ORDER } from '../web/ui/surface.js';

const SITE = process.env.SITE_URL ?? 'https://soc.ddev.site/';
const SESSION = `responsive-${process.pid}`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1600, height: 1000 };

/* ------------------------------------------------------------------ the driver --- */

function cli(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('playwright-cli', ['-s', SESSION, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch (error) {
    if (allowFailure) return '';
    const said = `${error.stderr ?? ''}\n${error.stdout ?? ''}`.trim() || error.message;
    throw new Error(`playwright-cli ${args[0]} failed: ${said.split('\n').slice(-4).join(' | ')}`);
  }
}

/**
 * The last line of the output that parses as JSON, unwrapped one level if it is a
 * string. Every expression below returns `JSON.stringify(...)` rather than an object:
 * playwright-cli pretty-prints an object result across many lines, and this parses
 * one line at a time.
 */
function cliJson(args) {
  const out = cli(args).trim();
  for (const line of out.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
  throw new Error(`no JSON on stdout from playwright-cli ${args[0]}`);
}

/** Flattened to one line: playwright-cli echoes a multi-line function's source. */
const oneLine = (body) => body.replace(/(^|\s)\/\/[^\n]*/g, '$1').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

/* ------------------------------------------------------------- the measurement --- */

/**
 * One measurement pass, run in the page. It is deliberately defensive — every
 * lookup is optional-chained — so a missing keybed reads as `null` in the numbers
 * and fails the assertion that cares, rather than throwing here and looking like
 * a broken harness.
 */
const MEASURE = `() => {
  const de = document.documentElement;
  const px = (n) => Math.round(n * 100) / 100;
  const box = (el) => { const r = el.getBoundingClientRect(); return { left: px(r.left), right: px(r.right), top: px(r.top), bottom: px(r.bottom), width: px(r.width), height: px(r.height) }; };
  const name = (el) => (el.getAttribute && el.getAttribute('class')) || '';
  const CONTROL = 'button, input, select, textarea, [role="slider"]';
  const canScrollX = (el) => { const o = getComputedStyle(el).overflowX; return o === 'auto' || o === 'scroll'; };
  const scrollsX = (el) => canScrollX(el) && el.scrollWidth > el.clientWidth + 1;
  const reachingScroller = (el) => { for (let p = el.parentElement; p && p !== de; p = p.parentElement) if (scrollsX(p)) return p; return null; };
  const scrollerAbove = (el) => { for (let p = el && el.parentElement; p && p !== de; p = p.parentElement) if (canScrollX(p)) return p; return null; };

  /* Past the RIGHT edge only: that is the only direction content creates a
     horizontal scrollbar in this document. An element parked off the left — the
     skip link waits at left: -100vw until it is focused — is not an overflow. */
  const overflowing = [...document.querySelectorAll('body *')]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.right > de.clientWidth + 0.5)
    .map(({ el, r }) => ({ tag: el.tagName, cls: name(el).slice(0, 48), left: px(r.left), right: px(r.right), reachable: reachingScroller(el) !== null }));

  const regions = [...document.querySelectorAll('[data-region]')].map((el) => {
    const r = box(el);
    return {
      id: el.getAttribute('data-region'),
      ...r,
      docTop: px(r.top + window.scrollY),
      visible: typeof el.checkVisibility === 'function' ? el.checkVisibility() : true,
      controls: el.querySelectorAll(CONTROL).length,
      clippedControls: [...el.querySelectorAll(CONTROL)].filter((c) => { const b = c.getBoundingClientRect(); return b.right > de.clientWidth + 0.5 && reachingScroller(c) === null; }).length,
    };
  });

  const bed = document.querySelector('[data-keybed]');
  const keys = bed
    ? [...bed.querySelectorAll('[data-key-note]')]
        .map((k) => ({ note: Number(k.getAttribute('data-note')), kind: k.getAttribute('data-kind'), label: k.getAttribute('aria-label'), pressed: k.getAttribute('aria-pressed'), ...box(k) }))
        .sort((a, b) => a.note - b.note)
    : [];
  const whites = keys.filter((k) => k.kind === 'white');
  const blacks = keys.filter((k) => k.kind === 'black');
  const scroller = scrollerAbove(bed);
  const sBox = scroller ? box(scroller) : null;
  const sLeft = scroller ? scroller.scrollLeft : 0;
  /* How far each black key's centre sits from the midpoint of the two white keys it
     straddles. Zero means left: 50% of the grid area is still doing its job. */
  const misalignment = blacks.map((b) => {
    const below = whites.filter((w) => w.note < b.note).pop();
    const above = whites.find((w) => w.note > b.note);
    if (!below || !above) return { note: b.note, offset: null };
    return { note: b.note, offset: px(Math.abs((b.left + b.right) / 2 - (below.right + above.left) / 2)) };
  });

  return JSON.stringify({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    page: {
      ready: Boolean(window.__instrument && window.__instrument.ready),
      errors: window.__instrument ? window.__instrument.errorCount() : null,
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      scrollHeight: de.scrollHeight,
      overflowX: { html: getComputedStyle(de).overflowX, body: getComputedStyle(document.body).overflowX },
    },
    overflowing,
    regions,
    keybed: bed && {
      bed: { ...box(bed), clientWidth: bed.clientWidth, scrollWidth: bed.scrollWidth, touchAction: getComputedStyle(bed).touchAction, width: getComputedStyle(bed).width },
      scroller: scroller && {
        attrs: [...scroller.attributes].map((a) => a.name),
        ...sBox,
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        scrollLeft: px(sLeft),
        maxScroll: scroller.scrollWidth - scroller.clientWidth,
        overflowX: getComputedStyle(scroller).overflowX,
      },
      count: keys.length,
      whiteCount: whites.length,
      blackCount: blacks.length,
      range: keys.length ? [keys[0].note, keys[keys.length - 1].note] : null,
      keys: keys.map((k) => ({ ...k, contentLeft: sBox ? px(k.left - sBox.left + sLeft) : null })),
      misalignment,
    },
  });
}`;

/** Glissando across a bed that is scrolled away from zero. */
const GLISSANDO = `async (page) => {
  const plan = await page.evaluate(async () => {
    const de = document.documentElement;
    const bed = document.querySelector('[data-keybed]');
    let scroller = null;
    for (let p = bed.parentElement; p && p !== de; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll') { scroller = p; break; }
    }
    /* Bring the keybed into the window first. elementFromPoint and every mouse
       coordinate below are viewport-relative, and on a phone the keybed is the
       last of eight regions — measured at its document position they would all be
       tens of thousands of pixels below the fold. Only the page is scrolled here;
       scrollIntoView would also pan the keybed, which is the thing under test. */
    const at = bed.getBoundingClientRect();
    const want = Math.max(0, Math.round(window.scrollY + at.top - (window.innerHeight - at.height) / 2));
    if (Math.abs(window.scrollY - want) > 1) window.scrollTo(0, want);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const sr = scroller.getBoundingClientRect();
    const visible = [...bed.querySelectorAll('[data-key-note]')].filter((k) => {
      const r = k.getBoundingClientRect();
      return r.left >= sr.left - 0.5 && r.right <= sr.right + 0.5 && r.top >= 0 && r.bottom <= window.innerHeight;
    });
    const whites = visible.filter((k) => k.dataset.kind === 'white');
    const blacks = visible.filter((k) => k.dataset.kind === 'black');
    const aim = (k) => {
      const r = k.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height * (k.dataset.kind === 'black' ? 0.5 : 0.85);
      const hit = document.elementFromPoint(x, y);
      return { x, y, want: Number(k.getAttribute('data-note')), hit: hit ? Number(hit.getAttribute('data-note')) : null };
    };
    return {
      pageScrollY: window.scrollY,
      scrollLeft: scroller.scrollLeft,
      maxScroll: scroller.scrollWidth - scroller.clientWidth,
      visibleWhites: whites.length,
      visibleBlacks: blacks.length,
      from: aim(whites[0]),
      to: aim(blacks[blacks.length - 1]),
    };
  });
  const sounding = () => page.evaluate(() => window.__instrument.heldNotes().map((n) => n.note));
  const pressed = () => page.evaluate(() => [...document.querySelectorAll('[data-key-note][aria-pressed="true"]')].map((k) => Number(k.getAttribute('data-note'))));
  await page.mouse.move(plan.from.x, plan.from.y);
  await page.mouse.down();
  const onDown = await sounding();
  await page.mouse.move(plan.to.x, plan.to.y, { steps: 12 });
  const onMove = await sounding();
  const onMovePressed = await pressed();
  await page.mouse.up();
  const onUp = await sounding();
  return JSON.stringify({ plan, onDown, onMove, onMovePressed, onUp });
}`;

/** Scroll the keybed's own scroller and report the state before and after. */
const SCROLL_TO = (fraction) => `(page) => page.evaluate(async (f) => {
  const de = document.documentElement;
  const bed = document.querySelector('[data-keybed]');
  let scroller = null;
  for (let p = bed.parentElement; p && p !== de; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX;
    if (o === 'auto' || o === 'scroll') { scroller = p; break; }
  }
  const max = scroller.scrollWidth - scroller.clientWidth;
  scroller.scrollLeft = Math.round(max * f);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const px = (n) => Math.round(n * 100) / 100;
  const key = (n) => {
    const k = bed.querySelector('[data-note="' + n + '"]');
    const r = k.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    return { note: n, left: px(r.left), right: px(r.right), inside: r.left >= sr.left - 0.5 && r.right <= sr.right + 0.5 };
  };
  const whites = [...bed.querySelectorAll('[data-key-note][data-kind="white"]')].map((k) => Number(k.getAttribute('data-note')));
  const blacks = [...bed.querySelectorAll('[data-key-note][data-kind="black"]')].map((k) => Number(k.getAttribute('data-note')));
  const last = whites[whites.length - 1];
  const first = whites[0];
  const worst = blacks.map((n) => {
    const k = bed.querySelector('[data-note="' + n + '"]').getBoundingClientRect();
    const below = whites.filter((w) => w < n).pop();
    const above = whites.find((w) => w > n);
    const b = bed.querySelector('[data-note="' + below + '"]').getBoundingClientRect();
    const a = bed.querySelector('[data-note="' + above + '"]').getBoundingClientRect();
    return px(Math.abs((k.left + k.right) / 2 - (b.right + a.left) / 2));
  });
  return JSON.stringify({
    scrollLeft: px(scroller.scrollLeft),
    maxScroll: max,
    docScrollWidth: de.scrollWidth,
    docClientWidth: de.clientWidth,
    firstKey: key(first),
    lastKey: key(last),
    worstBlackOffset: Math.max(...worst),
  });
}, ${fraction})`;

/**
 * A real finger: CDP touch events, not a script writing scrollLeft. The bed's own
 * inline style says `touch-action: none`, so a swipe starting on a key is claimed
 * by the instrument and the far octaves are unreachable by touch — which is why the
 * narrow-viewport rule hands a horizontal pan back to the browser. A script cannot
 * see that difference, so the swipe has to be a gesture.
 *
 * `block: 'pan'` re-applies `touch-action: none` to the bed, which is the control:
 * the same swipe, same place, same finger, and it must not pan. If the rule ever
 * stops being load-bearing this fails rather than passing quietly.
 */
const TOUCH_PAN = (block) => `async (page) => {
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const aim = () => page.evaluate(async (blockIt) => {
    const de = document.documentElement;
    const bed = document.querySelector('[data-keybed]');
    let scroller = null;
    for (let p = bed.parentElement; p && p !== de; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll') { scroller = p; break; }
    }
    if (blockIt) bed.style.setProperty('touch-action', 'none', 'important');
    else bed.style.removeProperty('touch-action');
    scroller.scrollLeft = 0;
    window.scrollTo(0, 0);
    const r = bed.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, Math.round(window.scrollY + r.top - (window.innerHeight - r.height) / 2)));
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const at = bed.getBoundingClientRect();
    const x = Math.round(Math.min(at.right, window.innerWidth) - 50);
    const y = Math.round(at.top + at.height / 2);
    const el = document.elementFromPoint(x, y);
    return {
      x, y,
      target: el ? (el.getAttribute('class') || el.tagName) : null,
      touchAction: getComputedStyle(bed).touchAction,
      maxScroll: scroller.scrollWidth - scroller.clientWidth,
      scrollLeft: scroller.scrollLeft,
    };
  }, ${block});
  const start = await aim();
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start.x, y: start.y, id: 1 }] });
  for (let i = 1; i <= 12; i += 1) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(start.x - (220 * i) / 12), y: start.y, id: 1 }] });
    await new Promise((r) => setTimeout(r, 16));
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise((r) => setTimeout(r, 400));
  const end = await page.evaluate(() => {
    const de = document.documentElement;
    const bed = document.querySelector('[data-keybed]');
    let scroller = null;
    for (let p = bed.parentElement; p && p !== de; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll') { scroller = p; break; }
    }
    bed.style.removeProperty('touch-action');
    return { scrollLeft: scroller.scrollLeft, pageScrollX: window.scrollX, pageScrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
  });
  return JSON.stringify({ start, end, pannedBy: end.scrollLeft - start.scrollLeft });
}`;

/* ------------------------------------------------------------------- the setup --- */

let env = { ok: false, reason: 'not started' };
let phone = null;
let desktop = null;

try {
  cli(['open', SITE]);
  // The same real click verify.mjs makes. Layout is the same either way, but the
  // page under test should be the page a player is looking at.
  cli(['click', '#ctl-global-power']);
  const measure = (size) => {
    cli(['resize', String(size.width), String(size.height)]);
    return cliJson(['--raw', 'eval', MEASURE]);
  };
  desktop = measure(DESKTOP);
  phone = measure(PHONE);
  env = { ok: true, reason: null };
} catch (error) {
  env = { ok: false, reason: String(error.message).split('\n')[0] };
  cli(['close'], { allowFailure: true });
}

const SKIP = env.ok ? false : `no rendered page available (${env.reason}) — set SITE_URL and run with playwright-cli on PATH`;
if (SKIP) console.log(`# responsive.test.mjs SKIPPED: ${SKIP}`);

after(() => {
  cli(['close'], { allowFailure: true });
});

/* --------------------------------------------------------------------- the tests --- */

test('the page under test is the whole instrument, with nothing thrown', { skip: SKIP }, () => {
  for (const [name, m] of [['phone', phone], ['desktop', desktop]]) {
    assert.equal(m.viewport.width, name === 'phone' ? PHONE.width : DESKTOP.width, `${name}: the viewport is not the one under test`);
    assert.equal(m.page.ready, true, `${name}: the page is not armed — __instrument.ready is false`);
    assert.equal(m.page.errors, 0, `${name}: the page logged ${m.page.errors} error(s) while loading`);
  }
});

test(`at ${PHONE.width}px the document does not scroll sideways`, { skip: SKIP }, () => {
  const { page: doc } = phone;
  assert.ok(
    doc.scrollWidth <= doc.clientWidth,
    `the document scrolls horizontally: scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth} (${doc.scrollWidth - doc.clientWidth}px)`,
  );
  assert.equal(doc.overflowX.html, 'visible', 'the overflow may not be hidden on <html>: that makes the far keys unreachable');
  assert.equal(doc.overflowX.body, 'visible', 'the overflow may not be hidden on <body>: that makes the far keys unreachable');
});

test(`at ${PHONE.width}px nothing pokes past the viewport unless a scroller can reach it`, { skip: SKIP }, () => {
  const stranded = phone.overflowing.filter((el) => !el.reachable);
  assert.deepEqual(
    stranded,
    [],
    `these stick out of the document with no scroll container that can reach them: ${JSON.stringify(stranded.slice(0, 6))}`,
  );
  assert.ok(phone.page.scrollHeight > PHONE.height, 'the page is not scrolling vertically, so the regions have not stacked');
});

test(`at ${PHONE.width}px all ${REGION_ORDER.length} regions are present, in order, and none is clipped`, { skip: SKIP }, () => {
  const found = phone.regions.map((r) => r.id);
  assert.deepEqual(found, REGION_ORDER, `the regions are ${JSON.stringify(found)}, and the agreed order is ${JSON.stringify(REGION_ORDER)}`);
  for (const region of phone.regions) {
    assert.equal(region.visible, true, `${region.id} is not visible (display, visibility or content-visibility)`);
    assert.ok(region.width > 0 && region.height > 0, `${region.id} has no box: ${region.width}x${region.height}`);
    assert.ok(region.left >= -0.5, `${region.id} starts off the left edge at ${region.left}`);
    assert.ok(region.right <= phone.page.clientWidth + 0.5, `${region.id} runs off the right edge at ${region.right} of ${phone.page.clientWidth}`);
    assert.equal(region.clippedControls, 0, `${region.id} has ${region.clippedControls} control(s) clipped out of reach`);
  }
  const tops = phone.regions.map((r) => r.docTop);
  for (let i = 1; i < tops.length; i += 1) {
    assert.ok(tops[i] > tops[i - 1], `${phone.regions[i].id} starts at ${tops[i]}, above ${phone.regions[i - 1].id} at ${tops[i - 1]} — the stack is out of order`);
  }
});

test(`at ${PHONE.width}px the keybed scrolls inside itself and holds all ${KEY_COUNT} keys`, { skip: SKIP }, () => {
  const { keybed } = phone;
  assert.ok(keybed, 'there is no keybed on the page at all');
  assert.ok(keybed.scroller, `no ancestor of the keybed scrolls sideways, so the ${KEY_COUNT} keys drag the whole document: keybed.clientWidth ${keybed.bed.clientWidth}, keybed.scrollWidth ${keybed.bed.scrollWidth}`);
  assert.equal(keybed.scroller.overflowX, 'auto');
  assert.ok(
    keybed.scroller.clientWidth <= PHONE.width,
    `the keybed's scroll container is ${keybed.scroller.clientWidth}px wide inside a ${PHONE.width}px viewport`,
  );
  assert.ok(
    keybed.scroller.scrollWidth > keybed.scroller.clientWidth,
    `the keybed does not scroll: scrollWidth ${keybed.scroller.scrollWidth} <= clientWidth ${keybed.scroller.clientWidth} — the keys have been squeezed instead`,
  );
  assert.equal(keybed.count, KEY_COUNT, `the keybed has ${keybed.count} keys, not ${KEY_COUNT}`);
  assert.deepEqual(keybed.range, [KEY_LOW, KEY_HIGH], `the keys run ${JSON.stringify(keybed.range)}, not ${KEY_LOW}..${KEY_HIGH}`);
  assert.equal(keybed.whiteCount + keybed.blackCount, KEY_COUNT);
  /* Reachable = there is a scrollLeft that puts the key inside the visible box. The
     content coordinates come from the measurement, so this is arithmetic on the
     rendered layout rather than a claim about a stylesheet. */
  const { clientWidth: view, scrollWidth: content, maxScroll } = keybed.scroller;
  for (const key of keybed.keys) {
    assert.ok(key.contentLeft >= -0.5, `note ${key.note} starts at ${key.contentLeft}, left of the scroller's content`);
    assert.ok(key.contentLeft + key.width <= content + 0.5, `note ${key.note} ends at ${Math.round(key.contentLeft + key.width)}, past the scrollable content ${content}`);
    const lo = Math.max(0, key.contentLeft + key.width - view);
    const hi = Math.min(maxScroll, key.contentLeft);
    assert.ok(
      lo <= hi + 0.5,
      `note ${key.note} (${key.label}) cannot be scrolled into view: it needs scrollLeft in ${lo}..${hi} and the range is 0..${maxScroll}`,
    );
  }
});

test(`at ${PHONE.width}px the white keys stay a playable width`, { skip: SKIP }, () => {
  const whites = phone.keybed.keys.filter((k) => k.kind === 'white');
  const narrowest = Math.min(...whites.map((k) => k.width));
  assert.ok(
    narrowest >= 20,
    `the narrowest white key is ${narrowest}px — a 49-key bed squeezed to fit is not an instrument, and ${whites.length} keys of ${narrowest}px is the failure this file exists for`,
  );
  const visible = whites.filter((k) => k.left >= phone.keybed.scroller.left - 0.5 && k.right <= phone.keybed.scroller.right + 0.5);
  assert.ok(visible.length >= 12, `only ${visible.length} white keys are visible without scrolling; a player wants at least two octaves (14)`);
});

test(`at ${PHONE.width}px the black keys still straddle their two white keys, scrolled or not`, { skip: SKIP }, async () => {
  const worst = Math.max(...phone.keybed.misalignment.filter((m) => m.offset !== null).map((m) => m.offset));
  assert.ok(worst <= 0.6, `a black key sits ${worst}px off the boundary between its white keys: ${JSON.stringify(phone.keybed.misalignment.filter((m) => m.offset > 0.6).slice(0, 4))}`);
  /* The same geometry after the bed has been scrolled to its far end: `left: 50%` is
     a percentage of a grid area, so a scrolled container must move the two layers
     together or every black key lands on the wrong white. */
  for (const fraction of [0.5, 1]) {
    const scrolled = cliJson(['--raw', 'run-code', oneLine(SCROLL_TO(fraction))]);
    assert.ok(scrolled.scrollLeft > 0, `the keybed did not scroll to ${fraction} of its range (scrollLeft ${scrolled.scrollLeft} of ${scrolled.maxScroll})`);
    assert.ok(scrolled.docScrollWidth <= scrolled.docClientWidth, `scrolling the keybed to ${fraction} made the document scroll: ${scrolled.docScrollWidth} > ${scrolled.docClientWidth}`);
    assert.ok(scrolled.worstBlackOffset <= 0.6, `at scrollLeft ${scrolled.scrollLeft} a black key is ${scrolled.worstBlackOffset}px off its boundary`);
  }
  const atEnd = cliJson(['--raw', 'run-code', oneLine(SCROLL_TO(1))]);
  assert.equal(atEnd.lastKey.inside, true, 'the top key is still unreachable at the far end of the scroll');
  await cliJson(['--raw', 'run-code', oneLine(SCROLL_TO(0))]);
});

test(`at ${PHONE.width}px a drag across a scrolled keybed retargets the note`, { skip: SKIP }, async () => {
  await cliJson(['--raw', 'run-code', oneLine(SCROLL_TO(0.4))]);
  const drag = cliJson(['--raw', 'run-code', oneLine(GLISSANDO)]);
  const { plan, onDown, onMove, onMovePressed, onUp } = drag;
  assert.ok(plan.scrollLeft > 0, `the keybed was not scrolled before the drag (scrollLeft ${plan.scrollLeft} of ${plan.maxScroll}) — this is the scrolled case or nothing`);
  assert.equal(plan.from.hit, plan.from.want, `the press at (${plan.from.x}, ${plan.from.y}) hit note ${plan.from.hit}, not ${plan.from.want}`);
  assert.equal(plan.to.hit, plan.to.want, `the drag ended on note ${plan.to.hit}, not ${plan.to.want}`);
  assert.notEqual(plan.from.want, plan.to.want, 'the drag did not cross to another key, so it proves nothing');
  assert.deepEqual(onDown, [plan.from.want], `pointerdown on note ${plan.from.want} sounded ${JSON.stringify(onDown)}`);
  assert.deepEqual(onMove, [plan.to.want], `dragging to note ${plan.to.want} sounded ${JSON.stringify(onMove)} — the glissando did not retarget across the scrolled bed`);
  assert.deepEqual(onMovePressed, [plan.to.want], `the pressed key readout says ${JSON.stringify(onMovePressed)}, not ${plan.to.want}`);
  assert.deepEqual(onUp, [], 'the note is still sounding after the pointer came up');
  await cliJson(['--raw', 'run-code', oneLine(SCROLL_TO(0))]);
});

test(`at ${PHONE.width}px a finger pans the keybed, and nothing else does`, { skip: SKIP }, async () => {
  const panned = cliJson(['--raw', 'run-code', oneLine(TOUCH_PAN(false))]);
  assert.match(panned.start.target ?? '', /^key /, `the swipe did not land on a key: ${JSON.stringify(panned.start)}`);
  assert.equal(panned.start.touchAction, 'pan-x', `the bed's touch-action is ${panned.start.touchAction}, so a finger is claimed by the instrument and cannot pan the keybed`);
  assert.ok(panned.start.maxScroll > 0, 'the keybed has nothing to pan to');
  assert.ok(panned.pannedBy > 0, `a 220px touch swipe over a key panned the keybed by ${panned.pannedBy}px — the far octaves are unreachable by finger`);
  assert.equal(panned.end.pageScrollX, 0, 'the pan leaked into the document');
  assert.ok(panned.end.pageScrollWidth <= panned.end.clientWidth, 'the pan made the document scroll horizontally');
  /* The control: the same finger, the same place, with the bed's own inline
     `touch-action: none` back in force. It must NOT pan — which is what makes the
     rule above load-bearing rather than decorative. */
  const blocked = cliJson(['--raw', 'run-code', oneLine(TOUCH_PAN(true))]);
  assert.equal(blocked.start.touchAction, 'none');
  assert.equal(blocked.pannedBy, 0, 'with touch-action: none the keybed panned anyway, so the narrow rule is not what allows the pan');
  await cliJson(['--raw', 'run-code', oneLine(SCROLL_TO(0))]);
});

test(`at ${DESKTOP.width}px the keybed fits, shows every key, and scrolls not at all`, { skip: SKIP }, () => {
  const { keybed, page: doc } = desktop;
  assert.ok(doc.scrollWidth <= doc.clientWidth, `the document scrolls horizontally at ${DESKTOP.width}px: ${doc.scrollWidth} > ${doc.clientWidth}`);
  assert.ok(keybed, 'there is no keybed on the page at all');
  assert.equal(keybed.scroller, null, 'a narrow-viewport rule is in force above the breakpoint: the keybed has a sideways scroller it does not need');
  assert.ok(keybed.bed.scrollWidth <= keybed.bed.clientWidth, `the keybed scrolls at ${DESKTOP.width}px: ${keybed.bed.scrollWidth} > ${keybed.bed.clientWidth}`);
  assert.equal(keybed.count, KEY_COUNT, `the keybed has ${keybed.count} keys, not ${KEY_COUNT}`);
  for (const key of keybed.keys) {
    assert.ok(key.left >= keybed.bed.left - 0.5, `note ${key.note} hangs off the left of the bed at ${keybed.width}px`);
    assert.ok(key.right <= keybed.bed.right + 0.5, `note ${key.note} hangs off the right of the bed at ${keybed.width}px`);
    assert.ok(key.width > 0, `note ${key.note} has no width at ${DESKTOP.width}px`);
  }
  const worst = Math.max(...keybed.misalignment.filter((m) => m.offset !== null).map((m) => m.offset));
  assert.ok(worst <= 0.6, `a black key sits ${worst}px off its boundary at ${DESKTOP.width}px`);
  assert.deepEqual(desktop.regions.map((r) => r.id), REGION_ORDER, 'the desktop region order changed');
  assert.equal(desktop.overflowing.length, 0, `elements stick out at ${DESKTOP.width}px: ${JSON.stringify(desktop.overflowing.slice(0, 4))}`);
});

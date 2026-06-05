import { chromium, Page } from 'playwright-core';
import { getNextAction, generateFeedback } from './llm';
import type { ActionPlan, HistoryEntry, DomElement } from './types';
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────

const goal = process.argv.slice(2).join(' ');
if (!goal) {
    console.error('Usage: npx tsx agent.ts "Your goal here"');
    process.exit(1);
}

const logsDir        = path.join(process.cwd(), 'logs');
const screenshotsDir = path.join(logsDir, 'screenshots');
[logsDir, screenshotsDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

const sleep       = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const randomRange = (min: number, max: number) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

async function humanMouseMove(page: Page, x: number, y: number) {
    const steps = randomRange(8, 14);
    for (let i = 1; i <= steps; i++) {
        await page.mouse.move(
            x * (i / steps) + randomRange(-2, 2),
            y * (i / steps) + randomRange(-2, 2)
        );
        await sleep(randomRange(6, 16));
    }
    await page.mouse.move(x, y);
}

async function humanClick(page: Page, x: number, y: number, clickType?: 'left' | 'right' | 'double') {
    await humanMouseMove(page, x, y);
    await sleep(randomRange(40, 100));
    if (clickType === 'right') {
        await page.mouse.click(x, y, { button: 'right' });
    } else if (clickType === 'double') {
        await page.mouse.click(x, y, { clickCount: 2 });
    } else {
        await page.mouse.down();
        await sleep(randomRange(30, 60));
        await page.mouse.up();
    }
}

async function humanType(page: Page, text: string) {
    for (const char of text) {
        await page.keyboard.press(char);
        await sleep(randomRange(30, 80));
    }
}

// ─────────────────────────────────────────────
// Set-of-Mark (SoM) Visual Grounding Engine v3
//
// Injects color-coded numbered boxes over every
// interactive element. 8 categories:
//
//   RED    #ef4444 → BTN LNK CLK   — Buttons, links     → CLICK
//   AMBER  #f59e0b → INP LBL       — Text inputs         → TYPE
//   GREEN  #22c55e → SEL           — Native <select>     → SELECT_OPTION
//   PURPLE #a855f7 → CHK RDO TGL   — Checkboxes, radios  → CLICK
//   ORANGE #f97316 → RNG FILE DATE  — Sliders, pickers   → SET_VALUE / UPLOAD_FILE
//   BLUE   #3b82f6 → DRG           — Draggable items     → DRAG_AND_DROP
//   TEAL   #14b8a6 → NAV CELL      — Tabs, menus, cells  → CLICK
//   PINK   #ec4899 → TXT           — Textareas, editors  → TYPE
//
// Elements are scored and deduplicated. Top 80 by
// priority are rendered. Results include tag, type,
// text, selector, value, and placeholder metadata.
// ─────────────────────────────────────────────

// NOTE: plain string — do NOT convert to a function.
// page.evaluate() runs this as raw browser JavaScript.
const SOM_INJECTOR = `(() => {
  var results = [];
  var seen    = new Set();

  // ── 1. Element type classifier ─────────────────────────
  var classify = function(el) {
    var tag  = el.tagName.toUpperCase();
    var type = (el.type  || '').toLowerCase();
    var role = (el.getAttribute('role') || '').toLowerCase();

    if (tag === 'INPUT') {
      if (type === 'checkbox' || role === 'checkbox') return { cat: 'CHK',  color: '#a855f7' };
      if (type === 'radio'    || role === 'radio')    return { cat: 'RDO',  color: '#a855f7' };
      if (type === 'range'    || role === 'slider')   return { cat: 'RNG',  color: '#f97316' };
      if (type === 'file')                            return { cat: 'FILE', color: '#f97316' };
      if (type === 'color')                           return { cat: 'CLR',  color: '#f97316' };
      if (['date','datetime-local','time','month','week'].indexOf(type) > -1) return { cat: 'DATE', color: '#f97316' };
      if (['submit','button','reset','image'].indexOf(type) > -1)            return { cat: 'BTN',  color: '#ef4444' };
      if (type === 'hidden') return null;
      return { cat: 'INP', color: '#f59e0b' };
    }
    if (tag === 'TEXTAREA') return { cat: 'TXT', color: '#ec4899' };
    if (tag === 'SELECT' || role === 'listbox' || role === 'combobox') return { cat: 'SEL', color: '#22c55e' };
    if (el.getAttribute('contenteditable') === 'true') return { cat: 'TXT', color: '#ec4899' };
    
    var cls = (typeof el.className === 'string') ? el.className.toLowerCase() : '';
    var c = window.getComputedStyle(el).cursor;
    if (el.getAttribute('draggable') === 'true' || el.getAttribute('aria-grabbed') !== null || 
        c === 'grab' || c === 'grabbing' || 
        cls.indexOf('drag') > -1 || cls.indexOf('sortable') > -1) {
      return { cat: 'DRG', color: '#3b82f6' };
    }
    if (role === 'switch') return { cat: 'TGL', color: '#a855f7' };
    if (role === 'slider') return { cat: 'RNG', color: '#f97316' };
    if (['tab','menuitem','menuitemcheckbox','menuitemradio','treeitem'].indexOf(role) > -1)           return { cat: 'NAV',  color: '#14b8a6' };
    if (['gridcell','row','option','columnheader','rowheader'].indexOf(role) > -1)                     return { cat: 'CELL', color: '#14b8a6' };
    if (tag === 'BUTTON' || role === 'button') return { cat: 'BTN', color: '#ef4444' };
    if (tag === 'A' && el.href)                return { cat: 'LNK', color: '#ef4444' };
    if (tag === 'LABEL')                       return { cat: 'LBL', color: '#f59e0b' };
    if (tag === 'SUMMARY')                     return { cat: 'BTN', color: '#ef4444' };
    return { cat: 'CLK', color: '#ef4444' };
  };

  // ── 2. Smart selector builder ──────────────────────────
  var buildSelector = function(el) {
    if (el.id) return '#' + el.id;
    var testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy');
    if (testId) return '[data-testid="' + testId + '"]';
    var aria = el.getAttribute('aria-label');
    if (aria) return '[aria-label="' + aria.replace(/"/g, '\\\\"') + '"]';
    var name = el.getAttribute('name');
    if (name && ['INPUT','SELECT','TEXTAREA'].indexOf(el.tagName) > -1)
      return el.tagName.toLowerCase() + '[name="' + name + '"]';
    var text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (el.tagName === 'A' && el.href &&
        el.href.indexOf('javascript:') === -1 && el.href.indexOf('void(0)') === -1) {
      var rel = el.href.replace(location.origin, '').split('?')[0];
      if (rel && rel.length > 1 && rel !== '/') return 'a[href*="' + rel + '"]';
    }
    if (text && text.length >= 2 && text.length <= 60) return 'text=' + JSON.stringify(text);
    var parent = el.parentElement;
    if (parent) {
      var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === el.tagName; });
      var sIdx = siblings.indexOf(el);
      var ps   = parent.id ? '#' + parent.id : parent.tagName.toLowerCase();
      return ps + ' > ' + el.tagName.toLowerCase() + ':nth-of-type(' + (sIdx + 1) + ')';
    }
    return el.tagName.toLowerCase();
  };

  // ── 3. Comprehensive element query ────────────────────
  var Q = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'label',
    '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="option"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="slider"]',
    '[role="combobox"]', '[role="listbox"]', '[role="menuitem"]',
    '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="treeitem"]',
    '[role="gridcell"]', '[role="columnheader"]', '[role="rowheader"]',
    '[draggable="true"]', '[onclick]', 'summary', 'video[controls]', 'audio[controls]',
    // Modern framework hooks & generic classes
    '[class*="drag"]', '[class*="drop"]', '[class*="sortable"]', '[class*="handle"]',
    '[class*="btn"]', '[class*="button"]', '[class*="action"]',
    '[class*="arrow"]', '[class*="icon"]', '[class*="fa-"]', '[class*="fas"]',
    'svg', 'path'
  ].join(',');

  // ── 4. Walk DOM + Shadow DOM + iFrames ───────────────
  var allEls = [];
  var walk = function(root) {
    if (!root || !root.querySelectorAll) return;
    
    // Traverse same-origin iframes
    root.querySelectorAll('iframe').forEach(function(iframe) {
      try {
        if (iframe.contentDocument) walk(iframe.contentDocument);
      } catch (e) { /* ignore cross-origin */ }
    });

    root.querySelectorAll(Q).forEach(function(el) {
      if (allEls.indexOf(el) === -1) allEls.push(el);
    });
    root.querySelectorAll('*').forEach(function(el) {
      var s = window.getComputedStyle(el);
      if ((s.cursor === 'pointer' || s.cursor === 'grab' || s.cursor === 'grabbing') && allEls.indexOf(el) === -1)
        allEls.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    });
  };
  walk(document);

  // ── 5. Overlay container ───────────────────────────────
  var old = document.getElementById('__som_overlay__');
  if (old) old.remove();
  var container = document.createElement('div');
  container.id                  = '__som_overlay__';
  container.style.position      = 'absolute';
  container.style.top           = '0';
  container.style.left          = '0';
  container.style.width         = '100%';
  container.style.pointerEvents = 'none';
  container.style.zIndex        = '2147483647';
  document.body.appendChild(container);

  // ── 6. Score, filter, deduplicate ─────────────────────
  var INPUT_CATS = ['INP','TXT','SEL','FILE','RNG','DATE','CLR'];
  var candidates = [];

  allEls.forEach(function(el) {
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom < 0 || r.top > window.innerHeight) return;
    var clsf = classify(el);
    if (!clsf) return;

    var rawText = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    var ariaLbl = el.getAttribute('aria-label') || '';
    var ph      = el.getAttribute('placeholder') || '';
    var val     = el.value || el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || '';
    var text    = rawText || ariaLbl || ph || val || '';

    var curs = window.getComputedStyle(el).cursor;
    if (!text && INPUT_CATS.indexOf(clsf.cat) === -1 && curs !== 'pointer' && curs !== 'grab' && curs !== 'grabbing') return;

    var key = el.tagName + '|' + (Math.round(r.top / 5) * 5) + '|' + (Math.round(r.left / 5) * 5);
    if (seen.has(key)) return;
    seen.add(key);

    var score = 0;
    if (INPUT_CATS.indexOf(clsf.cat) > -1)              score = 3;
    else if (['BTN','CHK','RDO','TGL'].indexOf(clsf.cat) > -1) score = 2;
    else if (['LNK','NAV','SEL'].indexOf(clsf.cat) > -1)      score = 1;

    candidates.push({ el: el, r: r, cat: clsf.cat, color: clsf.color,
                      text: text, val: val, ph: ph, score: score });
  });

  // Sort: high-priority first, then top-to-bottom. Cap at 80.
  candidates.sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (a.r.top  !== b.r.top)  return a.r.top  - b.r.top;
    return a.r.left - b.r.left;
  });
  var top80 = candidates.slice(0, 80);
  // Re-sort by visual position for natural sequential indexing
  top80.sort(function(a, b) {
    if (a.r.top  !== b.r.top)  return a.r.top  - b.r.top;
    return a.r.left - b.r.left;
  });

  // ── 7. Render boxes + collect results ─────────────────
  top80.forEach(function(item, idx) {
    var el    = item.el,  r    = item.r;
    var cat   = item.cat, color = item.color;
    var text  = item.text, val = item.val, ph = item.ph;

    var entry = {
      tag:         el.tagName.toLowerCase(),
      type:        cat.toLowerCase(),
      text:        (text || '(empty)').slice(0, 80),
      selector:    buildSelector(el),
      value:       (val || '').slice(0, 40),
      placeholder: (ph  || '').slice(0, 40)
    };
    if (el.tagName === 'A' && el.href) entry.href = el.href.replace(location.origin, '');
    results.push(entry);

    var box = document.createElement('div');
    box.style.position        = 'absolute';
    box.style.left            = (r.left + window.scrollX) + 'px';
    box.style.top             = (r.top  + window.scrollY) + 'px';
    box.style.width           = r.width  + 'px';
    box.style.height          = r.height + 'px';
    box.style.border          = '2px solid ' + color;
    box.style.boxSizing       = 'border-box';
    box.style.backgroundColor = color + '1a';
    box.style.pointerEvents   = 'none';

    var lbl = document.createElement('div');
    lbl.textContent           = cat + ' ' + idx;
    lbl.style.position        = 'absolute';
    lbl.style.top             = '-16px';
    lbl.style.left            = '-2px';
    lbl.style.backgroundColor = color;
    lbl.style.color           = '#fff';
    lbl.style.padding         = '0 4px';
    lbl.style.fontSize        = '10px';
    lbl.style.fontWeight      = 'bold';
    lbl.style.fontFamily      = 'monospace';
    lbl.style.borderRadius    = '3px';
    lbl.style.lineHeight      = '16px';
    lbl.style.whiteSpace      = 'nowrap';
    lbl.style.pointerEvents   = 'none';

    box.appendChild(lbl);
    container.appendChild(box);
  });

  return results;
})()`;

const SOM_CLEANUP = `(() => {
  var c = document.getElementById('__som_overlay__');
  if (c) c.remove();
})()`;

const TEXT_SCRAPER = `document.body.innerText.replace(/\\s+/g,' ').trim()`;

const FOCUSED_SCRAPER = `(() => {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body) return '';
    var text = (el.innerText || el.value || el.placeholder || '').replace(/\\s+/g, ' ').trim().substring(0, 40);
    return el.tagName.toLowerCase() + (text ? ' "' + text + '"' : '');
})()`;

// Lightweight DOM fingerprint — detects whether any fields changed after an action
const DOM_HASH_SCRAPER = `(() => {
    var h = '';
    var els = document.querySelectorAll('input,select,textarea,button,a');
    els.forEach(function(el) { h += el.tagName[0] + (el.value || '') + (el.innerText || '').slice(0, 8); });
    return h.slice(0, 500);
})()`;

// ─────────────────────────────────────────────
// State Extraction
// ─────────────────────────────────────────────

interface PageState {
    screenshot:     string;
    screenshotPath: string;
    textSnippet:    string;
    focused:        string;
    elements:       DomElement[];
    url:            string;
    title:          string;
    domHash:        string;
}

async function extractState(page: Page, step: number): Promise<PageState> {
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // 1. Inject SoM overlays and extract element metadata
    const elements = await page.evaluate(SOM_INJECTOR) as DomElement[];

    // 2. Brief pause so overlays render before screenshot
    await sleep(150);

    // 3. Screenshot with boxes visible
    const buf   = await page.screenshot({ type: 'jpeg', quality: 75 });
    const spath = path.join(screenshotsDir, `step_${String(step).padStart(3, '0')}.jpg`);
    fs.writeFileSync(spath, buf);

    // 4. Remove overlays so they don't interfere with clicks
    await page.evaluate(SOM_CLEANUP).catch(() => {});

    // 5. Collect page text, focus state, and DOM fingerprint in parallel
    const [text, focused, domHash] = await Promise.all([
        page.evaluate(TEXT_SCRAPER)    as Promise<string>,
        page.evaluate(FOCUSED_SCRAPER) as Promise<string>,
        page.evaluate(DOM_HASH_SCRAPER) as Promise<string>
    ]);

    return {
        screenshot:     buf.toString('base64'),
        screenshotPath: spath,
        textSnippet:    text,
        focused,
        elements,
        url:     page.url(),
        title:   await page.title(),
        domHash
    };
}

// ─────────────────────────────────────────────
// Click Target Resolution
// Priority: element_index → selector → throw
// ─────────────────────────────────────────────

async function resolveClickTarget(
    page: Page,
    plan: ActionPlan,
    elements: DomElement[]
): Promise<{ x: number; y: number }> {

    if (plan.element_index !== undefined) {
        if (plan.element_index < 0 || plan.element_index >= elements.length) {
            throw new Error(
                `element_index ${plan.element_index} out of range. ` +
                `List has ${elements.length} elements (0–${elements.length - 1}).`
            );
        }
        const el    = elements[plan.element_index];
        const loc   = page.locator(el.selector).filter({ visible: true });
        const count = await loc.count();

        if (count === 0) {
            throw new Error(
                `Element [${plan.element_index}] "${el.text}" (${el.selector}) ` +
                `is no longer visible. Try a different element_index or SCROLL.`
            );
        }

        const box = await loc.first().boundingBox();
        if (!box) throw new Error(`Element [${plan.element_index}] "${el.text}" has no bounding box.`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }

    if (plan.selector) {
        const loc   = page.locator(plan.selector).filter({ visible: true });
        const count = await loc.count();

        if (count === 0) throw new Error(`Selector "${plan.selector}" matched no visible elements.`);
        if (count > 1 && plan.index === undefined) {
            throw new Error(
                `Selector "${plan.selector}" matched ${count} elements. ` +
                `Add "index": 0–${count - 1} or use element_index from the list.`
            );
        }

        const box = await loc.nth(plan.index ?? 0).boundingBox();
        if (!box) throw new Error(`Selector "${plan.selector}" element has no bounding box.`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }

    throw new Error('Action requires element_index, selector, or coordinates.');
}

// ─────────────────────────────────────────────
// Action Executor
// ─────────────────────────────────────────────

async function executeAction(page: Page, plan: ActionPlan, elements: DomElement[]): Promise<void> {
    switch (plan.action) {

        // ── Navigation ──────────────────────────────────
        case 'NAVIGATE': {
            if (!plan.navigate_url) throw new Error('NAVIGATE requires navigate_url');
            console.log(`  [Act] Navigate → ${plan.navigate_url}`);
            await page.goto(plan.navigate_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(1000);
            break;
        }

        case 'NAVIGATE_BACK': {
            console.log('  [Act] Navigate back…');
            await page.goBack({ waitUntil: 'domcontentloaded' });
            await sleep(800);
            break;
        }

        // ── Timing ──────────────────────────────────────
        case 'WAIT': {
            const ms = plan.wait_duration_ms ?? 1500;
            console.log(`  [Act] Wait ${ms}ms…`);
            await sleep(ms);
            break;
        }

        // ── Scrolling ────────────────────────────────────
        case 'SCROLL': {
            const dir = plan.scroll_direction || 'DOWN';
            console.log(`  [Act] Scroll page: ${dir}`);
            // Use behavior:'instant' to prevent mid-scroll screenshots
            await page.evaluate((direction) => {
                var dy = 500;
                if (direction === 'DOWN')   window.scrollBy({ top:  dy, behavior: 'instant' } as any);
                else if (direction === 'UP') window.scrollBy({ top: -dy, behavior: 'instant' } as any);
                else if (direction === 'TOP')    window.scrollTo({ top: 0, behavior: 'instant' } as any);
                else if (direction === 'BOTTOM') window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' } as any);
            }, dir);
            await sleep(400);
            break;
        }

        case 'SCROLL_ELEMENT': {
            if (plan.element_index === undefined) throw new Error('SCROLL_ELEMENT requires element_index');
            const el  = elements[plan.element_index];
            if (!el) throw new Error(`Element [${plan.element_index}] not found`);
            const dir = plan.scroll_direction || 'DOWN';
            console.log(`  [Act] Scroll container [${plan.element_index}] "${el.text}" → ${dir}`);
            await page.evaluate(([sel, direction]) => {
                var el = document.querySelector(sel as string) as Element;
                if (!el) return;
                var dy = 300;
                if (direction === 'DOWN')   el.scrollBy({ top:  dy, behavior: 'instant' } as any);
                else if (direction === 'UP') el.scrollBy({ top: -dy, behavior: 'instant' } as any);
                else if (direction === 'TOP')    el.scrollTo({ top: 0, behavior: 'instant' } as any);
                else if (direction === 'BOTTOM') el.scrollTo({ top: el.scrollHeight, behavior: 'instant' } as any);
            }, [el.selector, dir]);
            await sleep(400);
            break;
        }

        // ── Click / Hover ────────────────────────────────
        case 'CLICK': {
            if (plan.element_index === undefined && !plan.selector && !plan.coordinates)
                throw new Error('CLICK requires "element_index", "selector", or "coordinates".');

            const clickType = plan.click_type || 'left';
            const clickCount = clickType === 'double' ? 2 : 1;
            const btn = clickType === 'right' ? 'right' : 'left';
            
            const selector = plan.selector || (plan.element_index !== undefined ? elements[plan.element_index]?.selector : undefined);

            if (selector) {
                try {
                    await page.locator(selector).click({ button: btn, clickCount, timeout: 2000 });
                    console.log(`  [Act] Native Click [${plan.element_index}]`);
                } catch (e: any) {
                    console.log(`  [Warn] Native click failed (${e.message.split('\n')[0]}). Falling back to coordinates.`);
                    const { x, y } = await resolveClickTarget(page, plan, elements);
                    await humanClick(page, x, y, clickCount, btn);
                    console.log(`  [Act] Coord Click [${plan.element_index}] at ${x},${y}`);
                }
            } else if (plan.coordinates) {
                await humanClick(page, plan.coordinates.x, plan.coordinates.y, clickCount, btn);
            }
            break;
        }

        case 'HOVER': {
            const selector = plan.selector || (plan.element_index !== undefined ? elements[plan.element_index]?.selector : undefined);
            if (selector) {
                try {
                    await page.locator(selector).hover({ timeout: 2000 });
                    console.log(`  [Act] Native Hover [${plan.element_index}]`);
                } catch (e: any) {
                    console.log(`  [Warn] Native hover failed (${e.message.split('\n')[0]}). Falling back to coordinates.`);
                    const { x, y } = await resolveClickTarget(page, plan, elements);
                    await page.mouse.move(x, y, { steps: 5 });
                }
            } else if (plan.coordinates) {
                await page.mouse.move(plan.coordinates.x, plan.coordinates.y, { steps: 5 });
            }
            break;
        }

        // ── Keyboard ─────────────────────────────────────
        case 'KEY_PRESS': {
            if (!plan.key) throw new Error('KEY_PRESS requires "key".');
            console.log(`  [Act] Key: "${plan.key}"`);
            await page.keyboard.press(plan.key);
            await sleep(randomRange(300, 600));
            break;
        }

        // ── Typing ───────────────────────────────────────
        case 'TYPE': {
            if (!plan.text_to_type) throw new Error('TYPE requires "text_to_type".');

            let usedFill = false;

            // Fast path: page.fill() for input/textarea elements
            if (plan.element_index !== undefined) {
                const el = elements[plan.element_index];
                if (el && ['input', 'textarea'].includes(el.tag)) {
                    try {
                        await page.fill(el.selector, plan.text_to_type);
                        usedFill = true;
                        console.log(`  [Act] Fill: "${plan.text_to_type}" → ${el.selector}`);
                    } catch { /* fall through to manual keystroke */ }
                }
            }

            if (!usedFill) {
                // Focus the target first
                if (plan.coordinates) {
                    await humanClick(page, plan.coordinates.x, plan.coordinates.y);
                } else if (plan.element_index !== undefined || plan.selector) {
                    try {
                        const { x, y } = await resolveClickTarget(page, plan, elements);
                        await humanClick(page, x, y);
                        // Clear existing text to match page.fill semantics
                        await sleep(100);
                        await page.keyboard.press('Control+a');
                        await sleep(50);
                        await page.keyboard.press('Delete');
                        await sleep(50);
                    } catch (e: any) {
                        console.warn(`  [Warn] Focus failed: ${e.message}`);
                    }
                }
                console.log(`  [Act] Type: "${plan.text_to_type}"`);
                await humanType(page, plan.text_to_type);
            }

            if (plan.press_enter) {
                console.log('  [Act] Press Enter');
                await page.keyboard.press('Enter');
                await sleep(randomRange(500, 1000));
            }
            break;
        }

        case 'CLEAR_INPUT': {
            if (plan.element_index === undefined) throw new Error('CLEAR_INPUT requires element_index');
            const el = elements[plan.element_index];
            if (!el) throw new Error(`Element [${plan.element_index}] not found`);
            console.log(`  [Act] Clear [${plan.element_index}] "${el.text}"`);
            await page.fill(el.selector, '').catch(async () => {
                // Fallback: triple-click select-all then delete
                const { x, y } = await resolveClickTarget(page, plan, elements);
                await page.mouse.click(x, y, { clickCount: 3 });
                await page.keyboard.press('Control+a');
                await page.keyboard.press('Delete');
            });
            // Optionally type new text right after clearing
            if (plan.text_to_type) {
                await sleep(200);
                await page.fill(el.selector, plan.text_to_type).catch(async () => {
                    await humanType(page, plan.text_to_type!);
                });
                console.log(`  [Act] Typed after clear: "${plan.text_to_type}"`);
                if (plan.press_enter) {
                    await page.keyboard.press('Enter');
                    await sleep(500);
                }
            }
            await sleep(400);
            break;
        }

        // ── Form Controls ────────────────────────────────
        case 'SELECT_OPTION': {
            if (plan.element_index === undefined || !plan.dropdown_value) {
                throw new Error('SELECT_OPTION requires element_index and dropdown_value');
            }
            const el = elements[plan.element_index];
            if (!el) throw new Error(`Element [${plan.element_index}] not found`);
            console.log(`  [Act] Select "${plan.dropdown_value}" from [${plan.element_index}]`);
            // Try by value, then by label
            await page.selectOption(el.selector, plan.dropdown_value)
                .catch(() => page.selectOption(el.selector, { label: plan.dropdown_value! }))
                .catch(() => { console.warn(`  [Warn] SELECT_OPTION: option not found — check dropdown_value.`); });
            await sleep(500);
            break;
        }

        case 'SET_VALUE': {
            if (plan.element_index === undefined || !plan.input_value) {
                throw new Error('SET_VALUE requires element_index and input_value');
            }
            const el = elements[plan.element_index];
            if (!el) throw new Error(`Element [${plan.element_index}] not found`);
            console.log(`  [Act] Set value "${plan.input_value}" → [${plan.element_index}] "${el.text}"`);
            // Use native property setter to trigger React/Vue/Angular reactivity
            await page.evaluate(([sel, val]) => {
                var input = document.querySelector(sel as string) as HTMLInputElement | null;
                if (!input) return;
                var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (nativeSetter) {
                    nativeSetter.call(input, val);
                } else {
                    input.value = val as string;
                }
                input.dispatchEvent(new Event('input',  { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }, [el.selector, plan.input_value]);
            await sleep(400);
            break;
        }

        case 'UPLOAD_FILE': {
            if (plan.element_index === undefined || !plan.file_path) {
                throw new Error('UPLOAD_FILE requires element_index and file_path');
            }
            const el = elements[plan.element_index];
            if (!el) throw new Error(`Element [${plan.element_index}] not found`);
            console.log(`  [Act] Upload "${plan.file_path}" → [${plan.element_index}]`);
            await page.setInputFiles(el.selector, plan.file_path);
            await sleep(600);
            break;
        }

        // ── Drag & Drop ──────────────────────────────────
        case 'DRAG_AND_DROP': {
            if (plan.source_index === undefined || plan.target_index === undefined) {
                throw new Error('DRAG_AND_DROP requires source_index and target_index');
            }
            console.log(`  [Act] Drag [${plan.source_index}] → [${plan.target_index}]`);
            const src = await resolveClickTarget(page, { element_index: plan.source_index } as ActionPlan, elements);
            const tgt = await resolveClickTarget(page, { element_index: plan.target_index } as ActionPlan, elements);
            await humanMouseMove(page, src.x, src.y);
            await sleep(120);
            await page.mouse.down();
            await sleep(250);
            // Move in steps for smooth drag
            const steps = 12;
            for (let i = 1; i <= steps; i++) {
                const px = src.x + (tgt.x - src.x) * (i / steps);
                const py = src.y + (tgt.y - src.y) * (i / steps);
                await page.mouse.move(px, py);
                await sleep(20);
            }
            await sleep(150);
            await page.mouse.up();
            await sleep(600);
            break;
        }

        // ── Data Extraction ──────────────────────────────
        case 'EXTRACT_DATA': {
            if (!plan.extract_query) throw new Error('EXTRACT_DATA requires extract_query');
            console.log(`  [Act] Extract: "${plan.extract_query}"`);
            const extracted = await page.evaluate(() => {
                // Prefer structured data: tables first, then lists
                var tables = document.querySelectorAll('table');
                if (tables.length > 0) {
                    return Array.from(tables).slice(0, 3)
                        .map(function(t) { return (t as HTMLElement).innerText; })
                        .join('\n\n---\n\n');
                }
                var lists = document.querySelectorAll('ul, ol');
                if (lists.length > 0 && (lists[0] as HTMLElement).innerText.length > 50) {
                    return Array.from(lists).slice(0, 5)
                        .map(function(l) { return (l as HTMLElement).innerText; })
                        .join('\n');
                }
                return document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 3000);
            });

            const ts    = new Date().toISOString().replace(/[:.]/g, '-');
            const fname = path.join(logsDir, `extract_${ts}.txt`);
            fs.writeFileSync(fname, `Query: ${plan.extract_query}\n\n${extracted}`);

            console.log('\n╔══════════════════════════════════════════╗');
            console.log('║  EXTRACTED DATA                          ║');
            console.log('╚══════════════════════════════════════════╝');
            console.log(`Query: "${plan.extract_query}"`);
            console.log(extracted.slice(0, 1200));
            console.log(`[Saved → ${fname}]`);
            console.log('══════════════════════════════════════════\n');
            await sleep(400);
            break;
        }

        default:
            throw new Error(`Unknown action: ${(plan as any).action}`);
    }
}

// ─────────────────────────────────────────────
// Session History
// ─────────────────────────────────────────────

const sessionHistory: HistoryEntry[] = [];

function saveHistory() {
    if (!sessionHistory.length) return;
    const ts    = new Date().toISOString().replace(/[:.]/g, '-');
    const fpath = path.join(logsDir, `session_${ts}.json`);
    fs.writeFileSync(fpath, JSON.stringify(sessionHistory, null, 2));
    console.log(`\n[Info] Session saved → ${fpath}`);
}

function loadPriorMemory(): string {
    try {
        const files = fs.readdirSync(logsDir)
            .filter(f => f.endsWith('.json'))
            .sort((a, b) =>
                fs.statSync(path.join(logsDir, b)).mtimeMs -
                fs.statSync(path.join(logsDir, a)).mtimeMs
            );
        if (!files.length) return '';
        const raw: HistoryEntry[] = JSON.parse(
            fs.readFileSync(path.join(logsDir, files[0]), 'utf-8')
        );
        const lines = raw.filter(h => h.success)
            .map(h => `${h.action} ${h.target ?? ''} on ${h.url}`)
            .slice(-10);
        return lines.length ? `Prior session hints:\n${lines.join('\n')}` : '';
    } catch { return ''; }
}

// ─────────────────────────────────────────────
// Main Loop
// ─────────────────────────────────────────────

async function main() {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║  Browser Agent  v3  —  starting          ║`);
    console.log(`╚══════════════════════════════════════════╝`);
    console.log(`Goal: "${goal}"\n`);

    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>>;
    try {
        browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    } catch (e: any) {
        console.error(`[Fatal] Cannot connect to Chrome: ${e.message}`);
        console.error('Start Chrome with:  chrome.exe --remote-debugging-port=9222');
        process.exit(1);
    }

    const contexts = browser.contexts();
    if (!contexts.length) { console.error('[Fatal] No browser contexts.'); process.exit(1); }
    const page = contexts[0].pages()[0];
    if (!page) { console.error('[Fatal] No open tabs.'); process.exit(1); }

    process.on('SIGINT', () => { saveHistory(); browser.close(); process.exit(0); });

    const priorMemory = loadPriorMemory();
    if (priorMemory) console.log('[Agent] Prior session hints loaded.\n');

    let lastText    = '';
    let lastUrl     = '';
    let lastFocus   = '';
    let lastDomHash = '';
    let step        = 0;
    const MAX       = 40;
    let lastElements: DomElement[] = [];

    while (step < MAX) {
        step++;
        console.log(`\n──── Step ${step}/${MAX} ─────────────────────────`);

        // 1. Observe
        let state: PageState;
        try {
            console.log('[Observe] Capturing state…');
            state = await extractState(page, step);
        } catch (e: any) {
            console.error(`[Error] State capture failed: ${e.message}`);
            await sleep(2000);
            continue;
        }

        const { screenshot, screenshotPath, textSnippet, focused, elements, url, title, domHash } = state;
        lastElements = elements;

        // Breakdown by type for informative logging
        const btnCount = elements.filter(e => ['btn','lnk','clk'].includes(e.type)).length;
        const inpCount = elements.filter(e => ['inp','txt','sel','rng','file','date','clr'].includes(e.type)).length;
        const chkCount = elements.filter(e => ['chk','rdo','tgl'].includes(e.type)).length;

        console.log(`  URL:        ${url}`);
        console.log(`  Title:      ${title}`);
        if (focused) console.log(`  Focused:    ${focused}`);
        console.log(`  Elements:   ${elements.length} found  [${btnCount} buttons/links · ${inpCount} inputs · ${chkCount} checks]`);
        console.log(`  Screenshot: logs/screenshots/${path.basename(screenshotPath)}`);

        // 2. Dead-action detection (enhanced: URL + text + focus + DOM hash)
        if (sessionHistory.length > 0) {
            const last = sessionHistory[sessionHistory.length - 1];
            if (last.success && ['CLICK', 'TYPE', 'KEY_PRESS', 'HOVER'].includes(last.action)) {
                const pageUnchanged = textSnippet === lastText && url === lastUrl && focused === lastFocus;
                const domUnchanged  = domHash === lastDomHash;
                if (pageUnchanged && domUnchanged) {
                    last.success = false;
                    last.error   =
                        'PAGE DID NOT CHANGE (URL, text, focus, and DOM all identical) — dead action. ' +
                        'MUST change strategy: pick a different element_index, HOVER first, or SCROLL to reveal the target.';
                    console.warn('  [Warn] Dead action detected — marked failed.');
                }
            }
        }
        lastText    = textSnippet;
        lastUrl     = url;
        lastFocus   = focused;
        lastDomHash = domHash;

        // 3. Plan
        let plan: ActionPlan;
        try {
            console.log('[Plan]  Querying LLM…');
            plan = await getNextAction(
                goal, screenshot, textSnippet,
                elements, url, title,
                sessionHistory, priorMemory, focused
            );
            
            console.log(`  Analysis:  ${plan.current_state_analysis}`);
            console.log(`  Next Goal: ${plan.next_subgoal}`);
            console.log(`  Action:    ${plan.action}`);
            console.log(`  Reasoning: ${plan.reasoning}`);
        } catch (e: any) {
            console.error(`[Error] LLM call failed: ${e.message}`);
            sessionHistory.push({ step, url, action: 'LLM_ERROR', success: false, error: e.message });
            await sleep(2000);
            continue;
        }

        const target = plan.element_index !== undefined
            ? `element[${plan.element_index}] "${elements[plan.element_index]?.text}" (${elements[plan.element_index]?.type})`
            : plan.selector
                ? `selector "${plan.selector}"`
                : plan.coordinates
                    ? `coords (${plan.coordinates.x},${plan.coordinates.y})`
                    : '';

        console.log(`  Action:    ${plan.action}`);
        console.log(`  Reasoning: ${plan.reasoning}`);
        if (target) console.log(`  Target:    ${target}`);
        if (plan.navigate_url)   console.log(`  URL:       ${plan.navigate_url}`);
        if (plan.dropdown_value) console.log(`  Value:     "${plan.dropdown_value}"`);
        if (plan.input_value)    console.log(`  Value:     "${plan.input_value}"`);

        // 4. Complete
        if (plan.action === 'COMPLETE') {
            sessionHistory.push({ step, url, action: 'COMPLETE', success: true });
            console.log('\n[Agent] Goal achieved! Generating report…');
            const report = await generateFeedback(goal, sessionHistory);
            console.log('\n╔══════════════════════════════════════════╗');
            console.log('║  AGENT REPORT                            ║');
            console.log('╚══════════════════════════════════════════╝');
            console.log(report);
            console.log('══════════════════════════════════════════\n');
            break;
        }

        // 5. Execute
        await sleep(randomRange(600, 1200));
        try {
            await executeAction(page, plan, lastElements);
            sessionHistory.push({ step, url, action: plan.action, target, success: true });
        } catch (e: any) {
            console.error(`  [Error] ${e.message}`);
            sessionHistory.push({ step, url, action: plan.action, target, success: false, error: e.message });
            await sleep(1000);
        }
    }

    if (step >= MAX) console.warn(`\n[Agent] Reached max step limit (${MAX}).`);
    saveHistory();
    await browser.close();
}

main().catch(e => {
    console.error('[Fatal]', e);
    saveHistory();
    process.exit(1);
});

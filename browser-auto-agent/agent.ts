import { chromium, Page, BrowserContext } from 'playwright-core';
import { getNextAction, generateFeedback } from './llm';
import { getCredential, loadPriorSessionHints } from './memory';
import type { ActionPlan, HistoryEntry, DomElement } from './types';
import * as fs   from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────
// Human-like Interaction Helpers
// ─────────────────────────────────────────────────────────

const sleep       = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const randomRange = (min: number, max: number) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

/** Moves mouse in a natural arc toward (x, y) with micro-jitter. */
async function humanMouseMove(page: Page, x: number, y: number): Promise<void> {
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

/**
 * Fires a human-like click at (x, y).
 * @param button  'left' (default) | 'right' | 'left' with clickCount=2 for double
 * @param clickCount  1 (default) | 2 for double-click
 */
async function humanClick(
    page: Page,
    x: number,
    y: number,
    button: 'left' | 'right' = 'left',
    clickCount: number = 1
): Promise<void> {
    await humanMouseMove(page, x, y);
    await sleep(randomRange(40, 100));
    await page.mouse.click(x, y, { button, clickCount });
}

/** Types text with random inter-key delays to simulate human typing. */
async function humanType(page: Page, text: string): Promise<void> {
    for (const char of text) {
        await page.keyboard.type(char, { delay: randomRange(30, 80) });
    }
}

/** Wait for network to be idle (max 3s), then an extra settle delay. */
async function waitForNetworkIdle(page: Page, timeout = 3000): Promise<void> {
    try {
        await page.waitForLoadState('networkidle', { timeout });
    } catch {
        // Timeout is fine — page might use long-polling
    }
    await sleep(300);
}

// ─────────────────────────────────────────────────────────
// Set-of-Mark (SoM) Visual Grounding Engine v4
//
// Injects color-coded numbered boxes over every interactive
// element. 8 color categories drive the LLM's action choice.
//
//   RED    #ef4444 → BTN LNK CLK   — Buttons, links     → CLICK
//   AMBER  #f59e0b → INP LBL       — Text inputs         → TYPE
//   GREEN  #22c55e → SEL           — Native <select>     → SELECT_OPTION
//   PURPLE #a855f7 → CHK RDO TGL   — Checkboxes, radios  → CLICK
//   ORANGE #f97316 → RNG FILE DATE  — Sliders, pickers   → SET_VALUE
//   BLUE   #3b82f6 → DRG           — Draggable items     → DRAG_AND_DROP
//   TEAL   #14b8a6 → NAV CELL      — Tabs, menus, cells  → CLICK
//   PINK   #ec4899 → TXT           — Textareas, editors  → TYPE
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// Set-of-Mark (SoM) Visual Grounding Engine v5 (Omni-DOM)
//
// Extracts elements across all frames, NMS filters overlaps,
// and renders boxes strictly on the main viewport to bypass CSP.
// ─────────────────────────────────────────────────────────

const SOM_COLLECTOR = `(() => {
  var candidates = [];
  var seen = new Set();

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
    if (cls.indexOf('monaco-editor') > -1 || cls.indexOf('cm-editor') > -1 || cls.indexOf('react-codemirror2') > -1) {
        return { cat: 'TXT', color: '#ec4899' };
    }

    var c = window.getComputedStyle(el).cursor;
    if (el.getAttribute('draggable') === 'true' || el.getAttribute('aria-grabbed') !== null ||
        c === 'grab' || c === 'grabbing' ||
        cls.indexOf('drag') > -1 || cls.indexOf('sortable') > -1) {
      return { cat: 'DRG', color: '#3b82f6' };
    }
    if (role === 'switch') return { cat: 'TGL', color: '#a855f7' };
    if (role === 'slider') return { cat: 'RNG', color: '#f97316' };
    if (['tab','menuitem','menuitemcheckbox','menuitemradio','treeitem'].indexOf(role) > -1) return { cat: 'NAV',  color: '#14b8a6' };
    if (['gridcell','row','option','columnheader','rowheader'].indexOf(role) > -1)          return { cat: 'CELL', color: '#14b8a6' };
    if (tag === 'BUTTON' || role === 'button') return { cat: 'BTN', color: '#ef4444' };
    if (tag === 'A' && el.href)                return { cat: 'LNK', color: '#ef4444' };
    if (tag === 'LABEL')                       return { cat: 'LBL', color: '#f59e0b' };
    if (tag === 'SUMMARY')                     return { cat: 'BTN', color: '#ef4444' };
    return { cat: 'CLK', color: '#ef4444' };
  };

  var buildSelector = function(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy');
    if (testId) return '[data-testid="' + testId + '"]';
    var aria = el.getAttribute('aria-label');
    if (aria) return '[aria-label="' + aria.replace(/"/g, '\\"') + '"]';
    var name = el.getAttribute('name');
    if (name && ['INPUT','SELECT','TEXTAREA'].indexOf(el.tagName) > -1)
      return el.tagName.toLowerCase() + '[name="' + name + '"]';
    var text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (el.tagName === 'A' && el.href && el.href.indexOf('javascript:') === -1 && el.href.indexOf('void(0)') === -1) {
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

  var Q = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'label',
    '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="option"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="slider"]',
    '[role="combobox"]', '[role="listbox"]', '[role="menuitem"]',
    '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="treeitem"]',
    '[role="gridcell"]', '[role="columnheader"]', '[role="rowheader"]',
    '[draggable="true"]', '[onclick]', 'summary', 'video[controls]', 'audio[controls]',
    '[class*="drag"]', '[class*="drop"]', '[class*="sortable"]', '[class*="handle"]',
    '[class*="btn"]', '[class*="button"]', '[class*="action"]',
    '[class*="arrow"]', '.monaco-editor', '.cm-editor', '.react-codemirror2'
  ].join(',');

  var allEls = [];
  var walk = function(root) {
    if (!root || !root.querySelectorAll) return;
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

  var INPUT_CATS = ['INP','TXT','SEL','FILE','RNG','DATE','CLR'];

  allEls.forEach(function(el) {
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.width < 5 || r.height < 5 || r.bottom < 0 || r.top > window.innerHeight) return;
    
    // Strict visibility check
    var style = window.getComputedStyle(el);
    if (style.opacity === '0' || style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') return;

    var clsf = classify(el);
    if (!clsf) return;

    var rawText = (el.innerText || '').replace(/\s+/g, ' ').trim();
    var ariaLbl = el.getAttribute('aria-label') || '';
    var ph      = el.getAttribute('placeholder') || '';
    var val     = el.value || el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || '';
    var nameAttr= el.getAttribute('name') || '';
    var text    = rawText || ariaLbl || ph || nameAttr || val || '';

    var curs = style.cursor;
    if (!text && INPUT_CATS.indexOf(clsf.cat) === -1 && curs !== 'pointer' && curs !== 'grab' && curs !== 'grabbing') return;

    var key = el.tagName + '|' + (Math.round(r.top / 5) * 5) + '|' + (Math.round(r.left / 5) * 5);
    if (seen.has(key)) return;
    seen.add(key);

    var score = 0;
    if (INPUT_CATS.indexOf(clsf.cat) > -1)              score = 3;
    else if (['BTN','CHK','RDO','TGL'].indexOf(clsf.cat) > -1) score = 2;
    else if (['LNK','NAV','SEL'].indexOf(clsf.cat) > -1)      score = 1;

    candidates.push({
      r: { x: r.left, y: r.top, w: r.width, h: r.height },
      cat: clsf.cat, color: clsf.color, score: score,
      text: text.slice(0, 80),
      val: val.slice(0, 40),
      ph: ph.slice(0, 40),
      nameAttr: nameAttr,
      ariaLbl: ariaLbl,
      tag: el.tagName.toLowerCase(),
      sel: buildSelector(el),
      href: el.tagName === 'A' ? el.href : undefined
    });
  });

  return candidates;
})();`;

const SOM_RENDERER = (candidates: any[]) => {
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

  candidates.forEach(function(c, idx) {
    var box = document.createElement('div');
    box.style.position        = 'absolute';
    box.style.left            = (c.r.x + window.scrollX) + 'px';
    box.style.top             = (c.r.y + window.scrollY) + 'px';
    box.style.width           = c.r.w + 'px';
    box.style.height          = c.r.h + 'px';
    box.style.border          = '2px solid ' + c.color;
    box.style.boxSizing       = 'border-box';
    box.style.backgroundColor = c.color + '1a'; // 10% opacity
    box.style.pointerEvents   = 'none';

    var lbl = document.createElement('div');
    lbl.textContent           = c.cat + ' ' + idx;
    lbl.style.position        = 'absolute';
    
    // NMS/Aesthetics: If box is too small, put label outside
    if (c.r.h < 20) {
        lbl.style.top = '-16px';
    } else {
        lbl.style.top = '0px';
    }
    
    lbl.style.left            = '-2px';
    lbl.style.backgroundColor = c.color;
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
};

const SOM_CLEANUP     = `(() => { var c = document.getElementById('__som_overlay__'); if (c) c.remove(); })()`;
const TEXT_SCRAPER    = `document.body.innerText.replace(/\s+/g,' ').trim()`;
const FOCUSED_SCRAPER = `(() => {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body) return '';
    var text = (el.innerText || el.value || el.placeholder || '').replace(/\s+/g, ' ').trim().substring(0, 40);
    return el.tagName.toLowerCase() + (text ? ' "' + text + '"' : '');
})()`;
const DOM_HASH_SCRAPER = `(() => {
    var h = '';
    document.querySelectorAll('input,select,textarea,button,a,[class*="active"]').forEach(function(el) {
        h += el.tagName[0] + (el.value||'') + (el.innerText||'').slice(0,10) + (el.className||'').slice(0,8);
    });
    return h.slice(0, 800);
})()`;

// ─────────────────────────────────────────────────────────
// State Extraction
// ─────────────────────────────────────────────────────────

interface PageState {
    screenshot:     string;
    screenshotPath: string;
    textSnippet:    string;
    focused:        string;
    elements:       DomElement[];
    url:            string;
    title:          string;
    domHash:        string;
    iframeCount:    number;
}

// Check if box a is mostly contained within box b
function isContained(a: any, b: any) {
    const overlapW = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const overlapH = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const areaA = a.w * a.h;
    if (areaA === 0) return false;
    return (overlapW * overlapH) / areaA > 0.8;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        promise.then(res => {
            clearTimeout(timer);
            resolve(res);
        }).catch(() => {
            clearTimeout(timer);
            resolve(fallback);
        });
    });
}

async function extractState(page: Page, step: number): Promise<PageState> {
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    let allCandidates = [];

    // 1. Collect from main page and all iframes
    for (const frame of page.frames()) {
        try {
            // Get iframe absolute offset if it's not the main frame
            let offsetX = 0, offsetY = 0;
            if (frame.parentFrame()) {
                const fEl = await withTimeout(frame.frameElement(), 1000, null);
                if (fEl) {
                    const b = await fEl.boundingBox();
                    if (b) { offsetX = b.x; offsetY = b.y; }
                }
            }

            const cands = await withTimeout(frame.evaluate(SOM_COLLECTOR) as Promise<any[]>, 1500, []);
            for (const c of cands) {
                c.r.x += offsetX;
                c.r.y += offsetY;
                allCandidates.push(c);
            }
        } catch (e) {
            // CSP or cross-origin boundary blocked evaluate, or frame detached. 
            // Playwright can evaluate in out-of-process iframes natively!
        }
    }

    // 2. Non-Maximum Suppression (Remove boxes contained within other boxes of same/similar category)
    let filtered = [];
    for (let i = 0; i < allCandidates.length; i++) {
        const a = allCandidates[i];
        let contained = false;
        for (let j = 0; j < allCandidates.length; j++) {
            if (i === j) continue;
            const b = allCandidates[j];
            if (isContained(a.r, b.r) && b.score >= a.score) {
                contained = true;
                break;
            }
        }
        if (!contained) filtered.push(a);
    }

    // Sort and limit to 50
    filtered.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.r.y !== b.r.y) return a.r.y - b.r.y;
        return a.r.x - b.r.x;
    });
    filtered = filtered.slice(0, 50);
    
    // Sort spatially for reading order
    filtered.sort((a, b) => {
        if (Math.abs(a.r.y - b.r.y) > 20) return a.r.y - b.r.y;
        return a.r.x - b.r.x;
    });

    // 3. Render overlays on main page
    await page.evaluate(SOM_RENDERER, filtered).catch(() => {});
    await sleep(120);

    // 4. Map back to DomElement[]
    const elements: DomElement[] = filtered.map(c => ({
        tag: c.tag,
        type: c.cat.toLowerCase(),
        text: c.text || '(empty)',
        selector: c.sel,
        name: c.nameAttr || undefined,
        ariaLabel: c.ariaLbl || undefined,
        value: c.val || undefined,
        placeholder: c.ph || undefined,
        href: c.href || undefined,
        center: { x: c.r.x + c.r.w / 2, y: c.r.y + c.r.h / 2 }
    }));

    const buf   = await page.screenshot({ type: 'jpeg', quality: 80 });
    const spath = path.join(screenshotsDir, `step_${String(step).padStart(3, '0')}.jpg`);
    fs.writeFileSync(spath, buf);

    await page.evaluate(SOM_CLEANUP).catch(() => {});

    const [text, focused, domHash] = await Promise.all([
        page.evaluate(TEXT_SCRAPER).catch(()=>'')     as Promise<string>,
        page.evaluate(FOCUSED_SCRAPER).catch(()=>'')  as Promise<string>,
        page.evaluate(DOM_HASH_SCRAPER).catch(()=>'') as Promise<string>
    ]);

    // Count non-main frames (iframes)
    const iframeCount = page.frames().length - 1;

    return {
        screenshot:     buf.toString('base64'),
        screenshotPath: spath,
        textSnippet:    text,
        focused,
        elements,
        url:     page.url(),
        title:   await page.title().catch(()=>''),
        domHash,
        iframeCount
    };
}

// ─────────────────────────────────────────────────────────
// Click Target Resolution
// ─────────────────────────────────────────────────────────

async function resolveClickCoords(
    page: Page,
    plan: ActionPlan,
    elements: DomElement[]
): Promise<{ x: number; y: number }> {

    if (plan.element_index !== undefined) {
        if (plan.element_index < 0 || plan.element_index >= elements.length)
            throw new Error(`element_index ${plan.element_index} out of range (0–${elements.length - 1})`);

        const el = elements[plan.element_index];

        // Prefer pre-computed center coords (absolute, iframe-aware) for robustness
        if (el.center) {
            return el.center;
        }

        const sel = el.selector;
        const loc = page.locator(sel).filter({ visible: true });

        if (await loc.count() === 0)
            throw new Error(`Element [${plan.element_index}] "${el.text}" no longer visible.`);

        const box = await loc.first().boundingBox();
        if (!box)
            throw new Error(`Element [${plan.element_index}] "${el.text}" has no bounding box.`);

        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }

    if (plan.selector) {
        const loc   = page.locator(plan.selector).filter({ visible: true });
        const count = await loc.count();
        if (count === 0)
            throw new Error(`Selector "${plan.selector}" matched no visible elements.`);
        const box = await loc.nth(plan.index ?? 0).boundingBox();
        if (!box)
            throw new Error(`Selector "${plan.selector}" has no bounding box.`);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }

    throw new Error('CLICK requires element_index, selector, or coordinates.');
}

// ─────────────────────────────────────────────────────────
// Skill Engine — atomic multi-step capabilities
// ─────────────────────────────────────────────────────────

async function runSkill(
    page: Page,
    skillName: string,
    params: Record<string, string> = {},
    elements: DomElement[]
): Promise<void> {

    switch (skillName.toUpperCase()) {

        // ── LOGIN ────────────────────────────────────────
        case 'LOGIN': {
            const url  = page.url();
            const cred = getCredential(params.domain || url);

            if (!cred) {
                throw new Error(
                    `No credential found for "${params.domain || url}". ` +
                    `Add one to logs/memory.json: { "credentials": [{ "domain": "...", "username": "...", "password": "..." }] }`
                );
            }

            console.log(`  [Skill:LOGIN] Using credential for domain: ${cred.domain}`);

            // Find username field — prefer name/id/placeholder containing "user"/"email"/"login"
            const uField = elements.find(el =>
                ['inp'].includes(el.type) && (
                    (el.name  && /user|email|login|id/i.test(el.name)) ||
                    (el.placeholder && /user|email|login|id/i.test(el.placeholder)) ||
                    (el.ariaLabel && /user|email|login|id/i.test(el.ariaLabel))
                )
            ) ?? elements.find(el => el.type === 'inp');

            // Find password field
            const pField = elements.find(el =>
                el.type === 'inp' && (
                    (el.name && /pass/i.test(el.name)) ||
                    (el.placeholder && /pass/i.test(el.placeholder)) ||
                    (el.ariaLabel && /pass/i.test(el.ariaLabel))
                )
            ) ?? elements.find(el =>
                el.type === 'inp' && el !== uField
            );

            if (!uField) throw new Error('LOGIN skill: could not find username input.');
            if (!pField) throw new Error('LOGIN skill: could not find password input.');

            console.log(`  [Skill:LOGIN] Username field: ${uField.selector} (name="${uField.name}")`);
            console.log(`  [Skill:LOGIN] Password field: ${pField.selector} (name="${pField.name}")`);

            // Fill username
            await page.fill(uField.selector, cred.username);
            await sleep(randomRange(300, 600));

            // Fill password
            await page.fill(pField.selector, cred.password);
            await sleep(randomRange(300, 600));

            // Find and click submit button
            const submitBtn = elements.find(el =>
                ['btn','lnk','clk'].includes(el.type) && /log.?in|sign.?in|submit|enter/i.test(el.text)
            );

            if (submitBtn) {
                console.log(`  [Skill:LOGIN] Clicking submit: "${submitBtn.text}"`);
                await page.locator(submitBtn.selector).click({ timeout: 5000 });
            } else {
                console.log(`  [Skill:LOGIN] No submit button found — pressing Enter.`);
                await page.keyboard.press('Enter');
            }

            await waitForNetworkIdle(page, 5000);
            console.log(`  [Skill:LOGIN] Done. Current URL: ${page.url()}`);
            break;
        }

        // ── SCROLL_TO_TEXT ───────────────────────────────
        case 'SCROLL_TO_TEXT': {
            const text    = params.text;
            const maxScrl = parseInt(params.maxScrolls || '10', 10);
            if (!text) throw new Error('SCROLL_TO_TEXT requires skill_params.text');

            console.log(`  [Skill:SCROLL_TO_TEXT] Scrolling to find: "${text}"`);

            for (let i = 0; i < maxScrl; i++) {
                const found = await page.evaluate((t) =>
                    document.body.innerText.toLowerCase().includes(t.toLowerCase()),
                    text
                );
                if (found) {
                    console.log(`  [Skill:SCROLL_TO_TEXT] Found after ${i} scrolls.`);
                    // Try to scroll the element into view
                    await page.evaluate((t) => {
                        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                        var node: Node | null;
                        while ((node = walker.nextNode())) {
                            if (node.textContent?.toLowerCase().includes(t.toLowerCase())) {
                                (node.parentElement as HTMLElement)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                break;
                            }
                        }
                    }, text);
                    await sleep(500);
                    return;
                }
                await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'instant' } as any));
                await sleep(400);
            }
            throw new Error(`SCROLL_TO_TEXT: "${text}" not found after ${maxScrl} scrolls.`);
        }

        // ── WAIT_FOR_TEXT ────────────────────────────────
        case 'WAIT_FOR_TEXT': {
            const text    = params.text;
            const timeout = parseInt(params.timeout || '8000', 10);
            if (!text) throw new Error('WAIT_FOR_TEXT requires skill_params.text');
            console.log(`  [Skill:WAIT_FOR_TEXT] Waiting for: "${text}" (${timeout}ms)`);
            await page.waitForFunction(
                (t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()),
                text,
                { timeout }
            );
            console.log(`  [Skill:WAIT_FOR_TEXT] Found.`);
            break;
        }

        // ── CLOSE_MODAL ──────────────────────────────────
        case 'CLOSE_MODAL': {
            console.log(`  [Skill:CLOSE_MODAL] Attempting to dismiss modal/overlay…`);

            // Strategy 1: Look for a close button
            const closeBtn = elements.find(el =>
                /close|dismiss|cancel|×|✕|skip/i.test(el.text) &&
                ['btn','lnk','clk'].includes(el.type)
            );
            if (closeBtn) {
                await page.locator(closeBtn.selector).click({ timeout: 3000 }).catch(() => {});
                await sleep(500);
                return;
            }

            // Strategy 2: Press Escape
            await page.keyboard.press('Escape');
            await sleep(500);

            // Strategy 3: Click outside modal (top-left corner of page)
            await page.mouse.click(10, 10);
            await sleep(300);
            console.log(`  [Skill:CLOSE_MODAL] Done.`);
            break;
        }

        // ── SWITCH_TAB ───────────────────────────────────
        case 'SWITCH_TAB': {
            const targetTitle = params.title || '';
            const idx         = params.index !== undefined ? parseInt(params.index, 10) : -1;
            const ctx         = page.context();
            const pages       = ctx.pages();

            let targetPage: Page | undefined;
            if (idx >= 0 && idx < pages.length) {
                targetPage = pages[idx];
            } else if (targetTitle) {
                for (const p of pages) {
                    const t = await p.title();
                    if (t.toLowerCase().includes(targetTitle.toLowerCase())) {
                        targetPage = p;
                        break;
                    }
                }
            }

            if (!targetPage) throw new Error(`SWITCH_TAB: no tab found matching "${targetTitle || idx}"`);
            await targetPage.bringToFront();
            console.log(`  [Skill:SWITCH_TAB] Switched to: "${await targetPage.title()}"`);
            break;
        }

        // ── WEB_SEARCH ───────────────────────────────────
        case 'WEB_SEARCH': {
            const query = params.query;
            const engine = params.engine || 'google';
            if (!query) throw new Error('WEB_SEARCH requires skill_params.query');
            console.log(`  [Skill:WEB_SEARCH] Searching ${engine} for: "${query}"`);
            
            let searchUrl = '';
            if (engine.toLowerCase() === 'youtube') {
                searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
            } else if (engine.toLowerCase() === 'duckduckgo') {
                searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
            } else {
                searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
            }
            
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await sleep(1000);
            console.log(`  [Skill:WEB_SEARCH] Search loaded.`);
            break;
        }

        default:
            throw new Error(`Unknown skill: "${skillName}". Valid skills: LOGIN, SCROLL_TO_TEXT, WAIT_FOR_TEXT, CLOSE_MODAL, SWITCH_TAB, WEB_SEARCH`);
    }
}

// ─────────────────────────────────────────────────────────
// Action Executor
// ─────────────────────────────────────────────────────────

async function executeAction(page: Page, plan: ActionPlan, elements: DomElement[]): Promise<void> {
    const act = plan.action;

    switch (act) {

        // ── Navigation ──────────────────────────────────
        case 'NAVIGATE': {
            if (!plan.navigate_url) throw new Error('NAVIGATE requires navigate_url');
            let url = plan.navigate_url.trim();
            if (!url.startsWith('http')) url = 'https://' + url;
            console.log(`  [Act] Navigate → ${url}`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await waitForNetworkIdle(page);
            break;
        }

        case 'NAVIGATE_BACK': {
            console.log('  [Act] Navigate back');
            await page.goBack({ waitUntil: 'domcontentloaded' });
            await waitForNetworkIdle(page);
            break;
        }

        // ── Timing & Waiting ────────────────────────────
        case 'WAIT': {
            const ms = plan.wait_duration_ms ?? 1500;
            console.log(`  [Act] Wait ${ms}ms`);
            await sleep(ms);
            break;
        }

        case 'WAIT_FOR_TEXT': {
            if (!plan.target_text) throw new Error('WAIT_FOR_TEXT requires target_text');
            const ms = plan.wait_duration_ms ?? 10000;
            console.log(`  [Act] Wait for text: "${plan.target_text}" (up to ${ms}ms)`);
            try {
                await page.waitForFunction(
                    (t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()),
                    plan.target_text,
                    { timeout: ms }
                );
            } catch {
                console.log(`  [Warn] Wait for text timed out.`);
            }
            break;
        }

        case 'WAIT_FOR_ELEMENT': {
            if (!plan.target_selector) throw new Error('WAIT_FOR_ELEMENT requires target_selector');
            const ms = plan.wait_duration_ms ?? 10000;
            console.log(`  [Act] Wait for element: "${plan.target_selector}" (up to ${ms}ms)`);
            try {
                await page.waitForSelector(plan.target_selector, { timeout: ms });
            } catch {
                console.log(`  [Warn] Wait for element timed out.`);
            }
            break;
        }

        // ── Scrolling ────────────────────────────────────
        case 'SCROLL': {
            const dir = plan.scroll_direction || 'DOWN';
            console.log(`  [Act] Scroll ${dir}`);
            await page.evaluate((d) => {
                var dy = 600;
                if (d === 'DOWN')   window.scrollBy({ top:  dy, behavior: 'instant' } as any);
                else if (d === 'UP') window.scrollBy({ top: -dy, behavior: 'instant' } as any);
                else if (d === 'TOP')    window.scrollTo({ top: 0,                         behavior: 'instant' } as any);
                else if (d === 'BOTTOM') window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' } as any);
            }, dir);
            await sleep(400);
            break;
        }

        case 'SCROLL_ELEMENT': {
            if (plan.element_index === undefined) throw new Error('SCROLL_ELEMENT requires element_index');
            const el  = elements[plan.element_index];
            if (!el) throw new Error(`Element [${plan.element_index}] not found`);
            const dir = plan.scroll_direction || 'DOWN';
            console.log(`  [Act] Scroll element [${plan.element_index}] → ${dir}`);
            await page.evaluate(([sel, d]) => {
                var e = document.querySelector(sel as string) as Element;
                if (!e) return;
                var dy = 300;
                if (d === 'DOWN')   e.scrollBy({ top:  dy, behavior: 'instant' } as any);
                else if (d === 'UP') e.scrollBy({ top: -dy, behavior: 'instant' } as any);
                else if (d === 'TOP')    e.scrollTo({ top: 0,              behavior: 'instant' } as any);
                else if (d === 'BOTTOM') e.scrollTo({ top: e.scrollHeight, behavior: 'instant' } as any);
            }, [el.selector, dir]);
            await sleep(400);
            break;
        }

        // ── Click ────────────────────────────────────────
        case 'CLICK': {
            if (plan.element_index === undefined && !plan.selector && !plan.coordinates)
                throw new Error('CLICK requires element_index, selector, or coordinates.');

            const ct         = plan.click_type || 'left';
            const button     = ct === 'right' ? 'right' : 'left';
            const clickCount = ct === 'double' ? 2 : 1;

            if (plan.coordinates && plan.element_index === undefined && !plan.selector) {
                // Coordinate-only click (unlabeled element)
                const { x, y } = plan.coordinates;
                console.log(`  [Act] Click coords (${x}, ${y}) [${ct}]`);
                await humanClick(page, x, y, button, clickCount);
            } else {
                // Resolve element and try native click first, fall back to coords
                const el       = plan.element_index !== undefined ? elements[plan.element_index] : undefined;
                const selector = plan.selector ?? el?.selector;

                if (selector) {
                    try {
                        const loc = page.locator(selector).first();
                        await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
                        await loc.click({ button, clickCount, timeout: 3000, force: false });
                        console.log(`  [Act] Click [${plan.element_index ?? 'sel'}] "${el?.text ?? selector}" [${ct}]`);
                    } catch (e: any) {
                        console.log(`  [Warn] Native click failed: ${e.message.split('\n')[0]}`);
                        console.log(`  [Warn] Falling back to coordinate click.`);
                        const { x, y } = await resolveClickCoords(page, plan, elements);
                        await humanClick(page, x, y, button, clickCount);
                        console.log(`  [Act] Coord-click [${plan.element_index}] at (${Math.round(x)},${Math.round(y)})`);
                    }
                } else if (plan.coordinates) {
                    await humanClick(page, plan.coordinates.x, plan.coordinates.y, button, clickCount);
                }
            }
            await waitForNetworkIdle(page, 2500);
            break;
        }

        case 'CLICK_TEXT': {
            if (!plan.target_text) throw new Error('CLICK_TEXT requires target_text');
            console.log(`  [Act] Semantic Click Text: "${plan.target_text}"`);
            const loc = page.getByText(plan.target_text, { exact: false }).first();
            try {
                await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
                await loc.click({ timeout: 3000 });
            } catch (e: any) {
                console.log(`  [Warn] CLICK_TEXT failed: ${e.message.split('\n')[0]}`);
            }
            await waitForNetworkIdle(page, 2500);
            break;
        }

        // ── Hover ────────────────────────────────────────
        case 'HOVER': {
            const el       = plan.element_index !== undefined ? elements[plan.element_index] : undefined;
            const selector = plan.selector ?? el?.selector;

            if (selector) {
                try {
                    await page.locator(selector).first().hover({ timeout: 2000 });
                    console.log(`  [Act] Hover [${plan.element_index ?? 'sel'}] "${el?.text ?? selector}"`);
                } catch {
                    const { x, y } = await resolveClickCoords(page, plan, elements);
                    await page.mouse.move(x, y, { steps: 8 });
                }
            } else if (plan.coordinates) {
                await page.mouse.move(plan.coordinates.x, plan.coordinates.y, { steps: 8 });
            }
            await sleep(randomRange(400, 800));
            break;
        }

        // ── Keyboard ─────────────────────────────────────
        case 'KEY_PRESS': {
            if (!plan.key) throw new Error('KEY_PRESS requires "key".');
            console.log(`  [Act] KeyPress "${plan.key}"`);
            await page.keyboard.press(plan.key);
            await sleep(randomRange(300, 600));
            break;
        }

        case 'KEYBOARD_COMBO': {
            if (!plan.key) throw new Error('KEYBOARD_COMBO requires "key" (e.g. "Control+Shift+P")');
            console.log(`  [Act] Keyboard Combo "${plan.key}"`);
            const keys = plan.key.split('+');
            for (const k of keys.slice(0, -1)) await page.keyboard.down(k);
            await page.keyboard.press(keys[keys.length - 1]);
            for (const k of keys.slice(0, -1).reverse()) await page.keyboard.up(k);
            await sleep(randomRange(400, 800));
            break;
        }

        // ── Typing ───────────────────────────────────────
        case 'TYPE': {
            if (!plan.text_to_type) throw new Error('TYPE requires text_to_type.');

            const el = plan.element_index !== undefined ? elements[plan.element_index] : undefined;
            const sel = plan.selector ?? el?.selector;

            const isCodeEditor = (sel && (sel.includes('monaco') || sel.includes('inputarea') || sel.includes('cm-') || sel.includes('editor'))) || (el && el.tag === 'textarea') || page.url().includes('leetcode');
            const isMultiline = plan.text_to_type.includes('\n');

            if (isCodeEditor || isMultiline) {
                // Robust editor typing (Monaco / CodeMirror)
                console.log(`  [Act] Code/Editor Type: [${plan.element_index}]`);
                if (sel) {
                    try {
                        await page.locator(sel).first().click({ timeout: 2000 });
                    } catch {
                        if (plan.element_index !== undefined) {
                            const { x, y } = await resolveClickCoords(page, plan, elements);
                            await humanClick(page, x, y);
                        }
                    }
                }
                // Playwright's insertText handles chunked code pasting flawlessly without triggering auto-close brackets
                await page.keyboard.insertText(plan.text_to_type);
                console.log(`  [Act] Inserted text (${plan.text_to_type.length} chars)`);
            }
            else if (sel && el && ['input','textarea'].includes(el.tag)) {
                // Fast path: page.fill() for standard inputs
                try {
                    await page.locator(sel).first().fill(plan.text_to_type);
                    console.log(`  [Act] Fill "${plan.text_to_type}" → [${plan.element_index}] "${el.text}"`);
                } catch {
                    console.log(`  [Warn] Native fill failed, falling back to humanType`);
                    if (plan.element_index !== undefined) {
                        const { x, y } = await resolveClickCoords(page, plan, elements);
                        await humanClick(page, x, y);
                    }
                    await humanType(page, plan.text_to_type);
                }
            } else {
                // Click to focus, then type
                if (sel) {
                    try {
                        await page.locator(sel).first().click({ timeout: 2000 });
                    } catch {
                        if (plan.element_index !== undefined) {
                            const { x, y } = await resolveClickCoords(page, plan, elements);
                            await humanClick(page, x, y);
                        }
                    }
                }
                console.log(`  [Act] Type "${plan.text_to_type}"`);
                await humanType(page, plan.text_to_type);
            }

            if (plan.press_enter) {
                console.log(`  [Act] Press Enter`);
                await page.keyboard.press('Enter');
                await waitForNetworkIdle(page, 3000);
            }
            break;
        }

        case 'CLEAR_INPUT': {
            if (plan.element_index === undefined && !plan.selector)
                throw new Error('CLEAR_INPUT requires element_index or selector');
            const el  = plan.element_index !== undefined ? elements[plan.element_index] : undefined;
            const sel = plan.selector ?? el?.selector;
            if (!sel) throw new Error('CLEAR_INPUT: could not resolve selector');
            
            const isCodeEditor = (sel && (sel.includes('monaco') || sel.includes('inputarea') || sel.includes('cm-') || sel.includes('editor'))) || (el && el.tag === 'textarea') || page.url().includes('leetcode');
            
            console.log(`  [Act] Clear [${plan.element_index ?? 'sel'}] "${el?.text ?? sel}"`);
            
            if (isCodeEditor) {
                // Robust editor clear: Click -> Select All -> Backspace
                await page.locator(sel).first().click({ timeout: 2000 }).catch(() => {});
                const isMac = process.platform === 'darwin';
                await page.keyboard.down(isMac ? 'Meta' : 'Control');
                await page.keyboard.press('A');
                await page.keyboard.up(isMac ? 'Meta' : 'Control');
                await page.keyboard.press('Backspace');
                await sleep(300);
            } else {
                try {
                    await page.locator(sel).first().fill('');
                } catch {
                    console.log(`  [Warn] Native clear failed, falling back to Select-All + Backspace`);
                    if (plan.element_index !== undefined) {
                        const { x, y } = await resolveClickCoords(page, plan, elements);
                        await humanClick(page, x, y);
                    } else {
                        await page.locator(sel).first().click({ timeout: 2000 }).catch(() => {});
                    }
                    const isMac = process.platform === 'darwin';
                    await page.keyboard.down(isMac ? 'Meta' : 'Control');
                    await page.keyboard.press('A');
                    await page.keyboard.up(isMac ? 'Meta' : 'Control');
                    await page.keyboard.press('Backspace');
                    await sleep(300);
                }
            }
            
            if (plan.text_to_type) {
                await sleep(200);
                if (isCodeEditor || plan.text_to_type.includes('\n')) {
                    await page.keyboard.insertText(plan.text_to_type);
                } else {
                    await page.locator(sel).first().fill(plan.text_to_type);
                }
                console.log(`  [Act] Typed after clear: "${plan.text_to_type.substring(0, 40)}..."`);
                if (plan.press_enter) {
                    await page.keyboard.press('Enter');
                    await waitForNetworkIdle(page, 3000);
                }
            }
            await sleep(300);
            break;
        }

        // ── Form Controls ────────────────────────────────
        case 'SELECT_OPTION': {
            if (!plan.dropdown_value)
                throw new Error('SELECT_OPTION requires dropdown_value');
            const el  = plan.element_index !== undefined ? elements[plan.element_index] : undefined;
            const sel = plan.selector ?? el?.selector;
            if (!sel) throw new Error('SELECT_OPTION: could not resolve selector');
            console.log(`  [Act] SelectOption "${plan.dropdown_value}" in [${plan.element_index ?? 'sel'}]`);
            await page.selectOption(sel, plan.dropdown_value)
                .catch(() => page.selectOption(sel, { label: plan.dropdown_value! }))
                .catch(() => { throw new Error(`Option "${plan.dropdown_value}" not found in select.`); });
            await sleep(400);
            break;
        }

        case 'SET_VALUE': {
            if (!plan.input_value)
                throw new Error('SET_VALUE requires input_value');
            const el  = plan.element_index !== undefined ? elements[plan.element_index] : undefined;
            const sel = plan.selector ?? el?.selector;
            if (!sel) throw new Error('SET_VALUE: could not resolve selector');
            console.log(`  [Act] SetValue "${plan.input_value}" → [${plan.element_index ?? 'sel'}]`);
            await page.evaluate(([s, v]) => {
                var input = document.querySelector(s as string) as HTMLInputElement;
                if (!input) return;
                var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (nativeSetter) nativeSetter.call(input, v);
                else input.value = v as string;
                input.dispatchEvent(new Event('input',  { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }, [sel, plan.input_value]);
            await sleep(400);
            break;
        }

        case 'UPLOAD_FILE': {
            if (!plan.file_path) throw new Error('UPLOAD_FILE requires file_path');
            const el  = plan.element_index !== undefined ? elements[plan.element_index] : undefined;
            const sel = plan.selector ?? el?.selector;
            if (!sel) throw new Error('UPLOAD_FILE: could not resolve selector');
            console.log(`  [Act] Upload "${plan.file_path}" → [${plan.element_index ?? 'sel'}]`);
            await page.setInputFiles(sel, plan.file_path);
            await sleep(600);
            break;
        }

        // ── Drag & Drop ──────────────────────────────────
        case 'DRAG_AND_DROP': {
            if (plan.source_index === undefined || plan.target_index === undefined)
                throw new Error('DRAG_AND_DROP requires source_index and target_index');
            console.log(`  [Act] DragAndDrop [${plan.source_index}] → [${plan.target_index}]`);
            const src = await resolveClickCoords(page, { ...plan, element_index: plan.source_index } as ActionPlan, elements);
            const tgt = await resolveClickCoords(page, { ...plan, element_index: plan.target_index } as ActionPlan, elements);
            await humanMouseMove(page, src.x, src.y);
            await sleep(100);
            await page.mouse.down();
            await sleep(200);
            const steps = 12;
            for (let i = 1; i <= steps; i++) {
                await page.mouse.move(
                    src.x + (tgt.x - src.x) * (i / steps),
                    src.y + (tgt.y - src.y) * (i / steps)
                );
                await sleep(18);
            }
            await sleep(150);
            await page.mouse.up();
            await sleep(600);
            break;
        }

        case 'DRAG_TO_COORDS': {
            if (plan.source_index === undefined) throw new Error('DRAG_TO_COORDS requires source_index');
            if (!plan.drop_coordinates) throw new Error('DRAG_TO_COORDS requires drop_coordinates');
            console.log(`  [Act] DragToCoords [${plan.source_index}] → (${plan.drop_coordinates.x}, ${plan.drop_coordinates.y})`);
            const src = await resolveClickCoords(page, { ...plan, element_index: plan.source_index } as ActionPlan, elements);
            const tgt = plan.drop_coordinates;
            await humanMouseMove(page, src.x, src.y);
            await sleep(100);
            await page.mouse.down();
            await sleep(200);
            const steps = 12;
            for (let i = 1; i <= steps; i++) {
                await page.mouse.move(
                    src.x + (tgt.x - src.x) * (i / steps),
                    src.y + (tgt.y - src.y) * (i / steps)
                );
                await sleep(18);
            }
            await sleep(150);
            await page.mouse.up();
            await sleep(600);
            break;
        }

        // ── Data Extraction ──────────────────────────────
        case 'EXTRACT_DATA': {
            if (!plan.extract_query) throw new Error('EXTRACT_DATA requires extract_query');
            console.log(`  [Act] ExtractData: "${plan.extract_query}"`);
            const extracted = await page.evaluate(() => {
                var tables = document.querySelectorAll('table');
                if (tables.length > 0) {
                    return Array.from(tables).slice(0, 3)
                        .map(t => (t as HTMLElement).innerText).join('\n\n---\n\n');
                }
                var lists = document.querySelectorAll('ul, ol');
                if (lists.length > 0 && (lists[0] as HTMLElement).innerText.length > 50) {
                    return Array.from(lists).slice(0, 5)
                        .map(l => (l as HTMLElement).innerText).join('\n');
                }
                return document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 4000);
            });
            const ts    = new Date().toISOString().replace(/[:.]/g, '-');
            const fname = path.join(logsDir, `extract_${ts}.txt`);
            fs.writeFileSync(fname, `Query: ${plan.extract_query}\n\n${extracted}`);
            console.log('\n╔══════════════════════════════════════╗');
            console.log('║  EXTRACTED DATA                      ║');
            console.log('╚══════════════════════════════════════╝');
            console.log(extracted.slice(0, 1500));
            console.log(`[Saved → ${fname}]\n`);
            break;
        }

        case 'EXTRACT_TEXT': {
            let extracted = '';
            if (plan.target_selector) {
                console.log(`  [Act] ExtractText from selector: "${plan.target_selector}"`);
                extracted = await page.evaluate((s) => {
                    const el = document.querySelector(s);
                    return el ? (el as HTMLElement).innerText : '';
                }, plan.target_selector);
            } else if (plan.element_index !== undefined) {
                const el = elements[plan.element_index];
                if (!el) throw new Error(`Element [${plan.element_index}] not found`);
                console.log(`  [Act] ExtractText from [${plan.element_index}]`);
                extracted = await page.evaluate((s) => {
                    const node = document.querySelector(s);
                    return node ? (node as HTMLElement).innerText : '';
                }, el.selector);
            } else {
                console.log(`  [Act] ExtractText from full page`);
                extracted = await page.evaluate(() => document.body.innerText);
            }
            console.log(`\n=== EXTRACTED TEXT ===\n${extracted.slice(0, 1000)}\n======================\n`);
            break;
        }

        // ── Skill ────────────────────────────────────────
        case 'SKILL': {
            if (!plan.skill_name) throw new Error('SKILL requires skill_name');
            console.log(`  [Act] Skill: ${plan.skill_name}`);
            await runSkill(page, plan.skill_name, plan.skill_params ?? {}, elements);
            break;
        }

        // ── Touch / Gesture ─────────────────────────────────
        case 'TOUCH_TAP': {
            // Simulate a genuine touch event sequence (touchstart/touchend)
            // Works on canvas-based games and mobile-first web apps
            let tx: number, ty: number;
            if (plan.element_index !== undefined) {
                const coords = await resolveClickCoords(page, plan, elements);
                tx = coords.x; ty = coords.y;
            } else if (plan.coordinates) {
                tx = plan.coordinates.x; ty = plan.coordinates.y;
            } else {
                throw new Error('TOUCH_TAP requires element_index or coordinates');
            }
            console.log(`  [Act] TouchTap at (${Math.round(tx)}, ${Math.round(ty)})`);
            await page.touchscreen.tap(tx, ty);
            await sleep(randomRange(200, 400));
            break;
        }

        case 'SWIPE': {
            if (!plan.swipe_from || !plan.swipe_to)
                throw new Error('SWIPE requires swipe_from and swipe_to coordinates');
            const { swipe_from: sf, swipe_to: st, swipe_duration_ms: dur = 400 } = plan;
            const swipeSteps = Math.max(8, Math.round(dur / 16)); // ~60fps steps
            console.log(`  [Act] Swipe (${sf.x},${sf.y}) → (${st.x},${st.y}) over ${dur}ms`);
            // Use CDP touch events for maximum compatibility with canvas games
            const cdpSession = await page.context().newCDPSession(page);
            try {
                await cdpSession.send('Input.dispatchTouchEvent', {
                    type: 'touchStart',
                    touchPoints: [{ x: sf.x, y: sf.y, id: 0 }],
                    modifiers: 0
                });
                for (let i = 1; i <= swipeSteps; i++) {
                    const t  = i / swipeSteps;
                    // ease-in-out curve for natural feel
                    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
                    await cdpSession.send('Input.dispatchTouchEvent', {
                        type: 'touchMove',
                        touchPoints: [{
                            x: Math.round(sf.x + (st.x - sf.x) * ease),
                            y: Math.round(sf.y + (st.y - sf.y) * ease),
                            id: 0
                        }],
                        modifiers: 0
                    });
                    await sleep(Math.round(dur / swipeSteps));
                }
                await cdpSession.send('Input.dispatchTouchEvent', {
                    type: 'touchEnd',
                    touchPoints: [{ x: st.x, y: st.y, id: 0 }],
                    modifiers: 0
                });
            } finally {
                await cdpSession.detach();
            }
            await sleep(400);
            break;
        }

        case 'SCROLL_TO_ELEMENT': {
            const el  = plan.element_index !== undefined ? elements[plan.element_index] : undefined;
            const sel = plan.target_selector ?? plan.selector ?? el?.selector;
            if (!sel) throw new Error('SCROLL_TO_ELEMENT requires element_index, target_selector, or selector');
            console.log(`  [Act] ScrollToElement: "${sel}"`);
            try {
                await page.locator(sel).first().scrollIntoViewIfNeeded({ timeout: 4000 });
            } catch {
                // Fallback: JS-based smooth scroll into view
                await page.evaluate((s) => {
                    const node = document.querySelector(s);
                    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, sel);
            }
            await sleep(500);
            break;
        }

        case 'EXECUTE_JS': {
            if (!plan.js_code) throw new Error('EXECUTE_JS requires js_code');
            console.log(`  [Act] ExecuteJS: ${plan.js_code.slice(0, 100)}${plan.js_code.length > 100 ? '...' : ''}`);
            const result = await page.evaluate(plan.js_code);
            if (result !== undefined) {
                const r = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                console.log(`  [Act] ExecuteJS result: ${r.slice(0, 500)}`);
            }
            await sleep(300);
            break;
        }

        default:
            throw new Error(`Unknown action: ${(plan as any).action}`);
    }
}

// ─────────────────────────────────────────────────────────
// Session History + Persistence
// ─────────────────────────────────────────────────────────

const sessionHistory: HistoryEntry[] = [];

function saveHistory(): void {
    if (!sessionHistory.length) return;
    const ts    = new Date().toISOString().replace(/[:.]/g, '-');
    const fpath = path.join(logsDir, `session_${ts}.json`);
    fs.writeFileSync(fpath, JSON.stringify(sessionHistory, null, 2));
    console.log(`\n[Info] Session saved → ${fpath}`);
}

// ─────────────────────────────────────────────────────────
// Main Agent Loop
// ─────────────────────────────────────────────────────────

async function main() {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║  Browser Agent  v5 Omni-DOM  —  starting ║`);
    console.log(`╚══════════════════════════════════════════╝`);
    console.log(`Goal: "${goal}"\n`);

    // Connect to running Chrome via CDP
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

    // Load prior session memory
    const priorMemory = loadPriorSessionHints(logsDir);
    if (priorMemory) console.log('[Agent] Prior session hints loaded.\n');

    const MAX = 80;
    let step  = 0;

    // Dead-action tracking
    let lastDomHash  = '';
    let lastUrl      = '';
    let lastText     = '';
    let deadCount    = 0;  // consecutive dead actions
    const DEAD_GRACE = 2;  // allow 2 identical snapshots (async pages)

    while (step < MAX) {
        step++;
        console.log(`\n──── Step ${step}/${MAX} ─────────────────────────`);

        // ── 1. Observe ───────────────────────────────────
        let state: PageState;
        try {
            console.log('[Observe] Capturing state…');
            state = await extractState(page, step);
        } catch (e: any) {
            console.error(`[Error] State capture failed: ${e.message}`);
            await sleep(2000);
            continue;
        }

        const { screenshot, screenshotPath, textSnippet, focused, elements, url, title, domHash, iframeCount } = state;

        const btnCount = elements.filter(e => ['btn','lnk','clk'].includes(e.type)).length;
        const inpCount = elements.filter(e => ['inp','txt','sel','rng','file','date','clr'].includes(e.type)).length;
        const chkCount = elements.filter(e => ['chk','rdo','tgl'].includes(e.type)).length;

        console.log(`  URL:        ${url}`);
        console.log(`  Title:      ${title}`);
        if (focused) console.log(`  Focused:    ${focused}`);
        console.log(`  Elements:   ${elements.length} found  [${btnCount} btns · ${inpCount} inputs · ${chkCount} checks]`);
        console.log(`  Screenshot: logs/screenshots/${path.basename(screenshotPath)}`);

        // ── 2. Dead-action detection ──────────────────────
        // Give async pages DEAD_GRACE steps before marking dead
        if (sessionHistory.length > 0) {
            const last = sessionHistory[sessionHistory.length - 1];
            if (last.success && ['CLICK','CLICK_TEXT','TYPE','KEY_PRESS','KEYBOARD_COMBO','HOVER','NAVIGATE','TOUCH_TAP','SWIPE'].includes(last.action)) {
                const pageUnchanged = domHash === lastDomHash && url === lastUrl && textSnippet === lastText;
                if (pageUnchanged) {
                    deadCount++;
                    if (deadCount >= DEAD_GRACE) {
                        last.success = false;
                        last.error   = `PAGE DID NOT CHANGE (URL, DOM, text all identical for ${deadCount} steps). MUST change strategy.`;
                        console.warn('  [Warn] Dead action detected — marked failed.');
                        deadCount = 0;
                    } else {
                        console.warn(`  [Warn] Page unchanged (grace ${deadCount}/${DEAD_GRACE})…`);
                    }
                } else {
                    deadCount = 0;  // page changed — reset counter
                }
            }
        }

        lastDomHash = domHash;
        lastUrl     = url;
        lastText    = textSnippet;

        // ── 3. Plan ──────────────────────────────────────
        let plan: ActionPlan;
        try {
            console.log('[Plan]  Querying LLM…');
            plan = await getNextAction(
                goal, screenshot, textSnippet,
                elements, url, title,
                sessionHistory, priorMemory, focused, iframeCount
            );
        } catch (e: any) {
            console.error(`[Error] LLM call failed: ${e.message}`);
            sessionHistory.push({ step, url, action: 'LLM_ERROR', success: false, error: e.message });
            await sleep(2000);
            continue;
        }

        // Print chain-of-thought
        if (plan.current_state_analysis) console.log(`  Analysis:  ${plan.current_state_analysis}`);
        if (plan.next_subgoal)           console.log(`  SubGoal:   ${plan.next_subgoal}`);
        console.log(`  Action:    ${plan.action}`);
        console.log(`  Reasoning: ${plan.reasoning}`);

        const target =
            plan.element_index !== undefined
                ? `element[${plan.element_index}] "${elements[plan.element_index]?.text ?? '?'}" (${elements[plan.element_index]?.type ?? '?'})`
                : plan.target_text
                    ? `text "${plan.target_text}"`
                : plan.target_selector || plan.selector
                    ? `selector "${plan.target_selector || plan.selector}"`
                : plan.drop_coordinates
                    ? `drop_coords (${plan.drop_coordinates.x},${plan.drop_coordinates.y})`
                : plan.coordinates
                    ? `coords (${plan.coordinates.x},${plan.coordinates.y})`
                : plan.skill_name
                    ? `skill:${plan.skill_name}`
                    : '';

        if (target)                 console.log(`  Target:    ${target}`);
        if (plan.navigate_url)      console.log(`  URL:       ${plan.navigate_url}`);
        if (plan.text_to_type)      console.log(`  Text:      "${plan.text_to_type}"`);
        if (plan.dropdown_value)    console.log(`  Value:     "${plan.dropdown_value}"`);
        if (plan.skill_params)      console.log(`  Params:    ${JSON.stringify(plan.skill_params)}`);

        // ── 4. Complete ──────────────────────────────────
        if (plan.action === 'COMPLETE') {
            sessionHistory.push({ step, url, action: 'COMPLETE', success: true });
            console.log('\n[Agent] ✅ Goal achieved! Generating report…');
            const report = await generateFeedback(goal, sessionHistory);
            console.log('\n╔══════════════════════════════════════╗');
            console.log('║  AGENT REPORT                        ║');
            console.log('╚══════════════════════════════════════╝');
            console.log(report);
            console.log('══════════════════════════════════════\n');
            break;
        }

        // ── 5. Execute ───────────────────────────────────
        await sleep(randomRange(400, 800));
        try {
            await executeAction(page, plan, elements);
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
    console.error('[Fatal]', e.message);
    saveHistory();
    process.exit(1);
});

const fs = require('fs');

let code = fs.readFileSync('agent.ts', 'utf-8');

// We will replace everything from const SOM_INJECTOR to the end of extractState
const startMarker = "const SOM_INJECTOR = `(() => {";
const endMarker = "    };\n}";

const startIndex = code.indexOf(startMarker);
const endIndex = code.indexOf(endMarker, startIndex) + endMarker.length;

if (startIndex === -1 || endIndex < startIndex) {
    console.error('Failed to find markers.');
    process.exit(1);
}

const replacement = `// ─────────────────────────────────────────────────────────
// Set-of-Mark (SoM) Visual Grounding Engine v5 (Omni-DOM)
//
// Extracts elements across all frames, NMS filters overlaps,
// and renders boxes strictly on the main viewport to bypass CSP.
// ─────────────────────────────────────────────────────────

const SOM_COLLECTOR = \`(() => {
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
    if (aria) return '[aria-label="' + aria.replace(/"/g, '\\\\"') + '"]';
    var name = el.getAttribute('name');
    if (name && ['INPUT','SELECT','TEXTAREA'].indexOf(el.tagName) > -1)
      return el.tagName.toLowerCase() + '[name="' + name + '"]';
    var text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
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

    var rawText = (el.innerText || '').replace(/\\s+/g, ' ').trim();
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
})();\`;

const SOM_RENDERER = \`(candidates) => {
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
}\`;

const SOM_CLEANUP     = \`(() => { var c = document.getElementById('__som_overlay__'); if (c) c.remove(); })()\`;
const TEXT_SCRAPER    = \`document.body.innerText.replace(/\\s+/g,' ').trim()\`;
const FOCUSED_SCRAPER = \`(() => {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body) return '';
    var text = (el.innerText || el.value || el.placeholder || '').replace(/\\s+/g, ' ').trim().substring(0, 40);
    return el.tagName.toLowerCase() + (text ? ' "' + text + '"' : '');
})()\`;
const DOM_HASH_SCRAPER = \`(() => {
    var h = '';
    document.querySelectorAll('input,select,textarea,button,a,[class*="active"]').forEach(function(el) {
        h += el.tagName[0] + (el.value||'') + (el.innerText||'').slice(0,10) + (el.className||'').slice(0,8);
    });
    return h.slice(0, 800);
})()\`;

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
}

// Check if box a is mostly contained within box b
function isContained(a, b) {
    const overlapW = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const overlapH = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const areaA = a.w * a.h;
    if (areaA === 0) return false;
    return (overlapW * overlapH) / areaA > 0.8;
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
                const fEl = await frame.frameElement();
                const b = await fEl.boundingBox();
                if (b) { offsetX = b.x; offsetY = b.y; }
            }

            const cands = await frame.evaluate(SOM_COLLECTOR) as any[];
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

    // Sort and limit to 80
    filtered.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.r.y !== b.r.y) return a.r.y - b.r.y;
        return a.r.x - b.r.x;
    });
    filtered = filtered.slice(0, 80);
    
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
    const spath = path.join(screenshotsDir, \`step_\${String(step).padStart(3, '0')}.jpg\`);
    fs.writeFileSync(spath, buf);

    await page.evaluate(SOM_CLEANUP).catch(() => {});

    const [text, focused, domHash] = await Promise.all([
        page.evaluate(TEXT_SCRAPER).catch(()=>'')     as Promise<string>,
        page.evaluate(FOCUSED_SCRAPER).catch(()=>'')  as Promise<string>,
        page.evaluate(DOM_HASH_SCRAPER).catch(()=>'') as Promise<string>
    ]);

    return {
        screenshot:     buf.toString('base64'),
        screenshotPath: spath,
        textSnippet:    text,
        focused,
        elements,
        url:     page.url(),
        title:   await page.title().catch(()=>''),
        domHash
    };
}`;

const newCode = code.substring(0, startIndex) + replacement + code.substring(endIndex);
fs.writeFileSync('agent.ts', newCode, 'utf-8');
console.log('Successfully patched agent.ts');

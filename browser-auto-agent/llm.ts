import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { config } from './config';
import type { ActionPlan, HistoryEntry, DomElement } from './types';

// ─────────────────────────────────────────────────────────
// JSON Parser — 4-stage resilient pipeline
// Handles: unquoted keys, single quotes, trailing commas,
//          markdown fences, truncated responses.
// ─────────────────────────────────────────────────────────

function structuralRepair(raw: string): string {
    let s = raw;

    // Strip markdown fences
    s = s.replace(/```(?:json)?\s*([\s\S]*?)\s*```/ig, '$1').trim();

    // Extract outermost { ... } block
    const start = s.indexOf('{');
    const end   = s.lastIndexOf('}');
    if (start === -1 || end <= start)
        throw new Error(`No JSON object found. Raw: ${raw.slice(0, 200)}`);
    s = s.slice(start, end + 1);

    // Fix missing "y": key  { "x": 864, 539 }  →  { "x": 864, "y": 539 }
    s = s.replace(/"x"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*}/g,
                  '"x": $1, "y": $2 }');

    // Fix unquoted y key:  { "x": 863, y: 541 }
    s = s.replace(/"x"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*y\s*:\s*(-?\d+(?:\.\d+)?)/gi,
                  '"x": $1, "y": $2');

    // Remove trailing commas before } or ]
    s = s.replace(/,\s*([}\]])/g, '$1');

    // Convert single-quoted strings to double-quoted
    s = s.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');

    return s;
}

// Stage 4 — field-by-field regex extraction (last resort)
function fieldExtract(raw: string): ActionPlan {
    const num = (key: string): number | undefined => {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
        return m ? Number(m[1]) : undefined;
    };

    const str = (key: string): string | undefined => {
        // Quoted string
        const m1 = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'));
        if (m1) return m1[1];
        // Unquoted value (boolean / null)
        const m2 = raw.match(new RegExp(`"${key}"\\s*:\\s*([\\w.-]+)`, 'i'));
        if (m2) return m2[1];
        return undefined;
    };

    // Reasoning may contain unescaped quotes — special handling
    let reasoning = 'Proceeding with goal.';
    const rm = raw.match(/"reasoning"\s*:\s*"([\s\S]*?)"(?:\s*[}\]]|\s*$)/i);
    if (rm) reasoning = rm[1].replace(/"[\s\S]*$/, '').trim() || reasoning;

    // Coordinates — tolerates missing "y": key and unquoted y
    let coordinates: { x: number; y: number } | undefined;
    const cm = raw.match(/"coordinates"\s*:\s*\{[^}]*?"x"\s*:\s*(-?\d+(?:\.\d+)?)[^}]*?[,\s](?:"?y"?\s*:\s*)?(-?\d+(?:\.\d+)?)/i);
    if (cm) coordinates = { x: Number(cm[1]), y: Number(cm[2]) };

    // ── Wait & Fallbacks
    const targetText = str('target_text');
    const targetSel  = str('target_selector');
    
    // ── Drag & Drop To Coords
    let dropCoords: { x: number; y: number } | undefined;
    const dcm = raw.match(/"drop_coordinates"\s*:\s*\{[^}]*?"x"\s*:\s*(-?\d+(?:\.\d+)?)[^}]*?[,\s](?:"?y"?\s*:\s*)?(-?\d+(?:\.\d+)?)/i);
    if (dcm) dropCoords = { x: Number(dcm[1]), y: Number(dcm[2]) };

    const elementIndex = num('element_index');
    const action       = (str('action') ?? 'WAIT') as ActionPlan['action'];
    const plan: ActionPlan = {
        current_state_analysis: str('current_state_analysis') || '',
        next_subgoal:           str('next_subgoal')           || '',
        action,
        reasoning
    };

    if (elementIndex !== undefined) {
        plan.element_index = elementIndex;
    } else if (coordinates) {
        plan.coordinates = coordinates;
    }

    const waitMs      = num('wait_duration_ms');
    const textToType  = str('text_to_type');
    const selector    = str('selector');
    const index       = num('index');
    const key         = str('key');
    const scrollDir   = str('scroll_direction');
    const sourceIdx   = num('source_index');
    const targetIdx   = num('target_index');
    const clickType   = str('click_type');
    const extractQ    = str('extract_query');
    const dropVal     = str('dropdown_value');
    const inputVal    = str('input_value');
    const filePath    = str('file_path');
    const navigateUrl = str('navigate_url');
    const skillName   = str('skill_name');

    const pressEnterMatch = raw.match(/"press_enter"\s*:\s*(true|false)/i);
    if (pressEnterMatch) plan.press_enter = pressEnterMatch[1].toLowerCase() === 'true';

    if (waitMs      !== undefined) plan.wait_duration_ms  = waitMs;
    if (textToType)                plan.text_to_type      = textToType;
    if (selector)                  plan.selector          = selector;
    if (index       !== undefined) plan.index             = index;
    if (key)                       plan.key               = key;
    if (scrollDir)                 plan.scroll_direction  = scrollDir as any;
    if (sourceIdx   !== undefined) plan.source_index      = sourceIdx;
    if (targetIdx   !== undefined) plan.target_index      = targetIdx;
    if (clickType)                 plan.click_type        = clickType as any;
    if (extractQ)                  plan.extract_query     = extractQ;
    if (dropVal)                   plan.dropdown_value    = dropVal;
    if (inputVal)                  plan.input_value       = inputVal;
    if (filePath)                  plan.file_path         = filePath;
    if (navigateUrl)               plan.navigate_url      = navigateUrl;
    if (skillName)                 plan.skill_name        = skillName as any;
    if (targetText)                plan.target_text       = targetText;
    if (targetSel)                 plan.target_selector   = targetSel;
    if (dropCoords)                plan.drop_coordinates  = dropCoords;

    // ── Swipe gesture coords
    const sfm = raw.match(/"swipe_from"\s*:\s*\{[^}]*?"x"\s*:\s*(-?\d+(?:\.\d+)?)[^}]*?[,\s](?:"?y"?\s*:\s*)?(-?\d+(?:\.\d+)?)/i);
    if (sfm) plan.swipe_from = { x: Number(sfm[1]), y: Number(sfm[2]) };
    const stm = raw.match(/"swipe_to"\s*:\s*\{[^}]*?"x"\s*:\s*(-?\d+(?:\.\d+)?)[^}]*?[,\s](?:"?y"?\s*:\s*)?(-?\d+(?:\.\d+)?)/i);
    if (stm) plan.swipe_to = { x: Number(stm[1]), y: Number(stm[2]) };
    const sdur = num('swipe_duration_ms');
    if (sdur !== undefined) plan.swipe_duration_ms = sdur;

    // ── Execute JS
    const jsCode = str('js_code');
    if (jsCode) plan.js_code = jsCode;

    // skill_params — extract inner JSON object
    const spMatch = raw.match(/"skill_params"\s*:\s*(\{[^}]*\})/i);
    if (spMatch) {
        try { plan.skill_params = JSON.parse(spMatch[1]); } catch { /* ignore */ }
    }

    return plan;
}

function parseJSON(raw: string | null | undefined): ActionPlan {
    if (!raw?.trim()) throw new Error('LLM returned an empty response.');

    // Stage 1: Structural repair
    let repaired: string;
    try {
        repaired = structuralRepair(raw);
    } catch {
        return fieldExtract(raw);
    }

    // Stage 2: Standard JSON.parse
    try {
        const p = JSON.parse(repaired) as ActionPlan;
        if (p.element_index !== undefined) delete p.coordinates;
        if (p.action) p.action = p.action.toString().trim().toUpperCase().split(/\s+/)[0] as any;
        return p;
    } catch { /* fall through */ }

    // Stage 3: new Function() — tolerates unquoted keys, trailing commas
    try {
        const p = (new Function('return ' + repaired))() as ActionPlan;
        if (p.element_index !== undefined) delete p.coordinates;
        if (p.action) p.action = p.action.toString().trim().toUpperCase().split(/\s+/)[0] as any;
        return p;
    } catch { /* fall through */ }

    // Stage 4: Field-by-field regex extraction
    const pFallback = fieldExtract(raw);
    if (pFallback.action) pFallback.action = pFallback.action.toString().trim().toUpperCase().split(/\s+/)[0] as any;
    return pFallback;
}

// ─────────────────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an elite browser automation agent (v5 Omni-DOM). You control a real browser using Playwright and operate a strict Observe → Think → Plan → Act loop to complete complex web tasks.

You handle: standard websites, complex web apps, drag-and-drop interfaces, iframes, quiz forms, web games, code editors (Monaco/CodeMirror), single-page apps, and canvas-based UI.

Each turn you receive:
  • GOAL         — the user's overall objective
  • URL + TITLE  — current page state
  • FOCUSED      — currently focused element (if any)
  • ELEMENTS     — numbered list of ALL interactable elements (including from iframes)
  • TEXT         — visible page text snippet
  • RECENT ACTIONS — last 5 actions taken (to avoid loops)
  • HISTORY      — full action log
  • SCREENSHOT   — live annotated browser screenshot with colored SoM boxes

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOM VISUAL COLOR GUIDE (colored numbered boxes on screenshot)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🔴 RED   [BTN / LNK / CLK]    → Button, link, or clickable div
                                     USE: CLICK | CLICK_TEXT
  🟡 AMBER [INP / LBL]          → Text input / label (search, username, etc.)
                                     USE: TYPE | CLEAR_INPUT
  🟢 GREEN [SEL]                → Native <select> dropdown — NEVER CLICK these!
                                     USE: SELECT_OPTION + dropdown_value
  🟣 PURPLE [CHK / RDO / TGL]   → Checkbox, radio button, toggle
                                     USE: CLICK (toggles state)
  🟠 ORANGE [RNG / FILE / DATE]  → Slider, file picker, date/color input
                                     USE: SET_VALUE | UPLOAD_FILE | DRAG_TO_COORDS
  🔵 BLUE  [DRG]                → Draggable card, sortable item, game piece
                                     USE: DRAG_AND_DROP | DRAG_TO_COORDS
  🩵 TEAL  [NAV / CELL]         → Tab, menu item, nav link, grid cell
                                     USE: CLICK
  🩷 PINK  [TXT]                → Textarea, code editor, rich-text area
                                     USE: TYPE | CLEAR_INPUT | KEYBOARD_COMBO

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPLETE ACTION REFERENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  STANDARD ACTIONS:
  CLICK           → Click element by box number. Use click_type: right/double for context menus / expand.
  CLICK_TEXT      → Click by exact visible text when no SoM box exists. Use target_text.
  TYPE            → Type into a field. Uses insertText for code editors automatically.
  CLEAR_INPUT     → Clear a field (Ctrl+A, Backspace), then optionally type new text.
  SET_VALUE       → Directly set value attribute (bypasses animations). Best for range sliders.
  SELECT_OPTION   → Choose from a native <select>. Uses dropdown_value (exact label or value).
  HOVER           → Hover over element to reveal tooltips or CSS dropdown menus.
  KEY_PRESS       → Press a single key: Escape, Enter, Tab, ArrowDown, F5, Backspace, etc.
  KEYBOARD_COMBO  → Multi-key combo via key field: "Control+A", "Control+Enter", "Alt+Tab".
  NAVIGATE        → Go to a URL. Always use full https:// prefix.
  NAVIGATE_BACK   → Press browser back button.
  UPLOAD_FILE     → Set files on a file <input>. Use file_path (absolute OS path).

  SCROLL ACTIONS:
  SCROLL          → Scroll the main page. scroll_direction: UP | DOWN | TOP | BOTTOM.
  SCROLL_ELEMENT  → Scroll inside a container (e.g. a chat box). Use element_index.
  SCROLL_TO_ELEMENT → Smooth-scroll a specific element into center of viewport.

  DRAG & DROP:
  DRAG_AND_DROP   → Drag source_index to target_index. Simulates natural eased motion.
  DRAG_TO_COORDS  → Drag source_index to absolute drop_coordinates {x, y}. Best for sliders and canvas.

  TOUCH / GESTURE (for web games, mobile-first UIs, carousels):
  TOUCH_TAP       → Tap at element_index or coordinates. Fires real touch events.
  SWIPE           → Swipe from swipe_from to swipe_to over swipe_duration_ms. Eased motion.

  IMPORTANT FOR CODE EDITORS:
  When using TYPE or CLEAR_INPUT to write code in a Monaco/CodeMirror editor (like LeetCode), you MUST provide the FULL, COMPLETE, and COMPILABLE solution in the \`text_to_type\` field. Do NOT write partial snippets, placeholders, or single lines. You are replacing the entire implementation, so provide the complete function or class!

  EXTRACTION:
  EXTRACT_TEXT    → Read text from a selector or element. Prints to log. Use to read quiz questions.
  EXTRACT_DATA    → Scrape structured data (tables, lists) from the page.

  WAITING:
  WAIT            → Pause for wait_duration_ms milliseconds.
  WAIT_FOR_TEXT   → Pause until target_text appears on page (up to wait_duration_ms, default 10s).
  WAIT_FOR_ELEMENT → Pause until target_selector is visible.

  POWER USER:
  EXECUTE_JS      → Run a JS snippet in the browser (js_code string). Returns result to log.
  SKILL           → Invoke a named multi-step atomic skill (see below).
  COMPLETE        → Signal goal is 100% achieved (only after visual confirmation).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SKILLS (Atomic Multi-Step Macros)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Use action: "SKILL" and skill_name from this list:
  LOGIN           → Auto-logins using saved credentials. Needs skill_params: { "domain": "..." }.
  SCROLL_TO_TEXT  → Scrolls until text is visible. Needs skill_params: { "text": "...", "maxScrolls": "10" }.
  WAIT_FOR_TEXT   → Waits for text to appear. Needs skill_params: { "text": "...", "timeout": "8000" }.
  CLOSE_MODAL     → Uses multiple heuristics to dismiss popups/cookie banners. No params needed.
  SWITCH_TAB      → Switches browser tab. Needs skill_params: { "tab": "title or index" }.
  WEB_SEARCH      → Navigates directly to search results. Needs skill_params: { "query": "...", "engine": "google|youtube|duckduckgo" }.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  RULE 1: SEARCH EFFICIENCY
  If the user asks to "search for X on YouTube" or "Google X", DO NOT click on search bars on the new tab page. Immediately use the WEB_SEARCH skill or NAVIGATE directly to the target search URL (e.g., https://www.youtube.com/results?search_query=...).

  RULE 2: DEAD-ACTION RECOVERY

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT — return ONLY a single valid JSON object, no markdown fences:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "current_state_analysis": "string",   ← Where am I? What did the last action achieve?
  "next_subgoal":           "string",   ← Single next logical step toward the goal.
  "action":                 "CLICK",    ← One action from the complete action reference above.
  "reasoning":              "string",   ← REQUIRED: Why this action? Which rule applies?

  "element_index":   number,            ← PRIMARY: Box number from screenshot (always prefer this)
  "target_text":     "string",          (CLICK_TEXT, WAIT_FOR_TEXT, EXTRACT_TEXT)
  "target_selector": "string",          (WAIT_FOR_ELEMENT, EXTRACT_TEXT, SCROLL_TO_ELEMENT)
  "click_type":      "left"|"right"|"double",
  "coordinates":     { "x": 0, "y": 0 },(FALLBACK ONLY — for canvas or unlabeled pixels)
  "text_to_type":    "string",
  "press_enter":     false,
  "key":             "string",          (KEY_PRESS or KEYBOARD_COMBO, e.g. "Control+Enter")
  "scroll_direction":"DOWN",
  "source_index":    number,
  "target_index":    number,
  "drop_coordinates":{ "x": 0, "y": 0 },(DRAG_TO_COORDS target)
  "swipe_from":      { "x": 0, "y": 0 },(SWIPE start)
  "swipe_to":        { "x": 0, "y": 0 },(SWIPE end)
  "swipe_duration_ms": 400,
  "dropdown_value": "string",
  "input_value":    "string",
  "file_path":      "string",
  "extract_query":  "string",
  "navigate_url":   "string",
  "wait_duration_ms": 2000,
  "js_code":        "string",           (EXECUTE_JS — e.g. "document.title")
  "skill_name":     "LOGIN"|"SCROLL_TO_TEXT"|"WAIT_FOR_TEXT"|"CLOSE_MODAL"|"SWITCH_TAB",
  "skill_params":   { "key": "value" }
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RULE 1 — MEMORY & LOOP PREVENTION (MOST CRITICAL):
  Read RECENT ACTIONS every turn. If you see the SAME action on the SAME target repeated 2+ times
  with no page change, you are in a DEAD LOOP. You MUST pivot:
  A) Try SCROLL_TO_ELEMENT to bring target into view, then retry.
  B) Try CLICK_TEXT with the element's visible label instead.
  C) Try EXECUTE_JS to directly trigger the action: document.querySelector('#btn').click().
  D) Try KEY_PRESS "Escape" to close any blocking overlay, then retry.
  E) Try a completely different approach to reach the goal.

RULE 2 — SITUATIONAL AWARENESS:
  Before each action, analyze the URL and page state carefully.
  If already on the correct page, do NOT navigate again.
  If content is already visible, do NOT scroll — act on what you see.

RULE 3 — INPUT FIELD IDENTIFICATION:
  Use "name" and "placeholder" attributes to identify fields.
  - username/email → name contains user/email/login
  - password → name contains pass or type=password
  NEVER fill a password into a username field. Use CLEAR_INPUT first if field has existing text.

RULE 4 — NATIVE SELECT (GREEN boxes):
  NEVER use CLICK on [SEL] elements. Always SELECT_OPTION + exact dropdown_value string.

RULE 5 — CODE EDITORS (Monaco/CodeMirror/PINK boxes):
  For LeetCode, CodePen, or any code editor: CLEAR_INPUT first (Ctrl+A, Backspace),
  then TYPE the solution. Never type code character by character.
  After typing, use KEYBOARD_COMBO "Control+Enter" or click the Run/Submit button.

RULE 6 — WEB GAMES & CANVAS:
  For HTML5 canvas games: prefer TOUCH_TAP over CLICK for game elements.
  For swipe/fling actions: use SWIPE with appropriate swipe_from and swipe_to coords.
  For draggable puzzle pieces: use DRAG_AND_DROP (element-to-element) or DRAG_TO_COORDS.
  If a game is stuck, try EXECUTE_JS to inspect the game state.

RULE 7 — IFRAMES:
  Elements inside iframes are included in the ELEMENTS list with correct viewport coordinates.
  Treat them as normal elements — use element_index to target them.
  If an iframe element is not listed, try SCROLL to reveal it, or EXECUTE_JS to interact.

RULE 8 — QUIZ / FORM HANDLING:
  Use EXTRACT_TEXT first to read the question if it is not clear from the screenshot.
  For multiple-choice: CLICK the correct answer radio/checkbox (PURPLE box).
  For text answers: CLEAR_INPUT, then TYPE the answer.
  For drag-and-drop quiz matching: DRAG_AND_DROP the answer to the target slot.
  After all answers, CLICK the submit/check button.

RULE 9 — WAIT FOR ASYNC CONTENT:
  After clicking a button that triggers a load (AJAX, navigation), use WAIT_FOR_TEXT or
  WAIT_FOR_ELEMENT before proceeding, rather than a fixed WAIT.

RULE 10 — COMPLETE:
  Only output action: "COMPLETE" when you can VISUALLY CONFIRM success in the screenshot.
  Read the URL and page text. If unsure, take one more EXTRACT_TEXT to verify.`;

// ─────────────────────────────────────────────────────────
// Prompt Builder
// ─────────────────────────────────────────────────────────

export function buildPrompt(
    goal: string, url: string, title: string,
    elements: DomElement[], text: string,
    history: HistoryEntry[], priorMemory: string,
    focused: string, iframeCount = 0
): string {

    // Rich element listing with all metadata + center coords
    const elemBlock = elements.length === 0
        ? '  (no interactive elements visible — try SCROLL DOWN or EXTRACT_TEXT to read content)'
        : elements.map((el, i) => {
            const typeTag = (el.type || el.tag).toUpperCase();
            let line = `  [${i}] ${typeTag} "${el.text}"`;
            if (el.name)        line += ` name="${el.name}"`;
            if (el.ariaLabel && el.ariaLabel !== el.text) line += ` aria="${el.ariaLabel}"`;
            if (el.placeholder && el.placeholder !== el.text) line += ` ph="${el.placeholder}"`;
            if (el.value && el.value !== el.text)        line += ` val="${el.value}"`;
            if (el.href)        line += ` href="${el.href}"`;
            if (el.center)      line += ` @(${Math.round(el.center.x)},${Math.round(el.center.y)})`;
            return line;
        }).join('\n');

    // Rolling action memory — last 5 actions for loop detection
    const recentActions = history.slice(-5);
    const recentBlock = recentActions.length === 0
        ? '  No actions yet.'
        : recentActions.map(h =>
            `  [${h.step}] ${h.action}${h.target ? ` → ${h.target}` : ''} | ${h.success ? '✓ OK' : `✗ FAILED: ${h.error}`}`
          ).join('\n');

    // Full history (last 10)
    const histBlock = history.length === 0
        ? '  No actions yet.'
        : history.slice(-10).map(h =>
            `  Step ${h.step} | ${h.action}${h.target ? ` → ${h.target}` : ''} | ` +
            `${h.success ? '✓ OK' : `✗ FAILED: ${h.error}`}`
          ).join('\n');

    // Dead loop detector: same action + target twice in a row
    const lastTwo = history.slice(-2);
    const inDeadLoop = lastTwo.length === 2 &&
        lastTwo[0].action === lastTwo[1].action &&
        lastTwo[0].target  === lastTwo[1].target &&
        lastTwo.every(h => !h.success || h.error?.includes('PAGE DID NOT CHANGE'));

    const stuckWarning = inDeadLoop
        ? `\n⚠️⚠️ DEAD LOOP DETECTED ⚠️⚠️\nYou have repeated "${lastTwo[0].action} → ${lastTwo[0].target}" twice with no result.\nYOU MUST APPLY RULE 1: pivot to a different strategy NOW. Do NOT repeat this action.`
        : (history.at(-1)?.error?.includes('PAGE DID NOT CHANGE')
            ? `\n⚠️ WARNING: Your last action did not change the page. Apply RULE 1 dead-loop recovery.`
            : '');

    return [
        `GOAL: ${goal}`,
        stuckWarning,
        priorMemory ? `\nPRIOR KNOWLEDGE:\n${priorMemory}` : '',
        `\nCURRENT URL:   ${url}`,
        `PAGE TITLE:    ${title}`,
        focused ? `FOCUSED:       ${focused}` : '',
        iframeCount > 0 ? `IFRAMES:       ${iframeCount} iframe(s) detected — elements inside are included in the list below` : '',
        `\nINTERACTIVE ELEMENTS (${elements.length} total — use element_index from numbered boxes on screenshot):`,
        elemBlock,
        `\nPAGE TEXT (first 600 chars):\n${text.slice(0, 600)}`,
        `\nRECENT ACTIONS (last 5 — scan for loops!):\n${recentBlock}`,
    ].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────────────────
// LLM Dispatchers
// ─────────────────────────────────────────────────────────

async function callOpenAI(
    apiKey: string, baseURL: string | undefined, model: string,
    prompt: string, screenshot: string
): Promise<ActionPlan> {
    const client = new OpenAI({ apiKey, baseURL });
    const res = await client.chat.completions.create({
        model,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}` } }
                ]
            }
        ],
        max_tokens: 1024,
        temperature: 0.1,   // Low temperature = more deterministic actions
    });
    return parseJSON(res.choices[0].message.content);
}

async function callGemini(prompt: string, screenshot: string): Promise<ActionPlan> {
    const ai  = new GoogleGenAI({ apiKey: config.gemini.apiKey });
    const res = await ai.models.generateContent({
        model: config.gemini.model,
        contents: [{
            role: 'user',
            parts: [
                { text: SYSTEM_PROMPT + '\n\n' + prompt },
                { inlineData: { mimeType: 'image/jpeg', data: screenshot } }
            ]
        }],
        config: {
            responseMimeType: 'application/json',
            temperature: 0.1,
        }
    });
    return parseJSON(res.text);
}

async function callOllama(prompt: string, screenshot: string): Promise<ActionPlan> {
    const res = await fetch(config.ollama.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model:   config.ollama.model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user',   content: prompt, images: [screenshot] }
            ],
            stream:  false,
            format:  'json',
            options: { num_ctx: 8192, temperature: 0.1 }
        })
    });
    const d = await res.json();
    if (d.error) throw new Error(`Ollama: ${JSON.stringify(d.error)}`);
    if (!d.message?.content) throw new Error(`Unexpected Ollama response: ${JSON.stringify(d)}`);
    return parseJSON(d.message.content);
}

// ─────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────

export async function getNextAction(
    goal: string, screenshot: string, text: string,
    elements: DomElement[], url: string, title: string,
    history: HistoryEntry[], priorMemory = '', focused = '', iframeCount = 0
): Promise<ActionPlan> {
    const prompt = buildPrompt(goal, url, title, elements, text, history, priorMemory, focused, iframeCount);

    switch (config.provider) {
        case 'openai':
            return callOpenAI(config.openai.apiKey, config.openai.baseUrl, config.openai.model, prompt, screenshot);
        case 'openrouter':
            return callOpenAI(config.openrouter.apiKey, 'https://openrouter.ai/api/v1', config.openrouter.model, prompt, screenshot);
        case 'gemini':
            return callGemini(prompt, screenshot);
        case 'ollama':
            return callOllama(prompt, screenshot);
        default:
            throw new Error(`Unsupported provider: ${config.provider}`);
    }
}

export async function generateFeedback(goal: string, history: HistoryEntry[]): Promise<string> {
    const successCount = history.filter(h => h.success).length;
    const failCount    = history.filter(h => !h.success).length;
    const prompt = [
        `Goal: "${goal}"`,
        `Steps taken: ${history.length} (${successCount} succeeded, ${failCount} failed)`,
        `History:\n${JSON.stringify(history.slice(-20), null, 2)}`,
        `\nWrite a concise professional summary of what was accomplished and any issues encountered.`
    ].join('\n');

    switch (config.provider) {
        case 'openai': case 'openrouter': {
            const isRouter = config.provider === 'openrouter';
            const c = new OpenAI({
                apiKey:  isRouter ? config.openrouter.apiKey : config.openai.apiKey,
                baseURL: isRouter ? 'https://openrouter.ai/api/v1' : config.openai.baseUrl
            });
            const r = await c.chat.completions.create({
                model: isRouter ? config.openrouter.model : config.openai.model,
                messages: [{ role: 'user', content: prompt }]
            });
            return r.choices[0].message.content ?? 'Done.';
        }
        case 'gemini': {
            const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
            const r  = await ai.models.generateContent({
                model: config.gemini.model,
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });
            return r.text ?? 'Done.';
        }
        case 'ollama': {
            const res = await fetch(config.ollama.baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: config.ollama.model, messages: [{ role: 'user', content: prompt }], stream: false })
            });
            return (await res.json()).message?.content ?? 'Done.';
        }
        default: return 'Done.';
    }
}

import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { config } from './config';
import type { ActionPlan, HistoryEntry, DomElement } from './types';

// ─────────────────────────────────────────────
// JSON Parser — 4-stage pipeline
// Tolerates unquoted keys, single quotes,
// trailing commas, markdown fences.
// ─────────────────────────────────────────────

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

    // Fix missing "y": key:  { "x": 864, 539 }  →  { "x": 864, "y": 539 }
    s = s.replace(/"x"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*}/g,
                  '"x": $1, "y": $2 }');

    // Fix unquoted y key:    { "x": 863, y: 541 }  →  { "x": 863, "y": 541 }
    s = s.replace(/"x"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*y\s*:\s*(-?\d+(?:\.\d+)?)/gi,
                  '"x": $1, "y": $2');

    // Remove trailing commas before } or ]
    s = s.replace(/,\s*([}\]])/g, '$1');

    // Convert single-quoted strings to double-quoted
    s = s.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');

    return s;
}

// Stage 4 — field-by-field regex extraction
// Last resort for fundamentally unparseable output
function fieldExtract(raw: string): ActionPlan {
    const num = (key: string): number | undefined => {
        const m = raw.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
        return m ? Number(m[1]) : undefined;
    };

    const str = (key: string): string | undefined => {
        const m1 = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'));
        if (m1) return m1[1];
        const m2 = raw.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?=[,}\\]])`, 'i'));
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

    const elementIndex = num('element_index');
    const action       = (str('action') ?? 'WAIT') as ActionPlan['action'];
    const plan: ActionPlan = { 
        current_state_analysis: str('current_state_analysis') || 'Analyzing current state.',
        next_subgoal: str('next_subgoal') || 'Determining next steps.',
        action, 
        reasoning 
    };

    if (elementIndex !== undefined) {
        plan.element_index = elementIndex;
    } else if (coordinates) {
        plan.coordinates = coordinates;
    }

    const waitMs       = num('wait_duration_ms');
    const textToType   = str('text_to_type');
    const selector     = str('selector');
    const index        = num('index');
    const key          = str('key');
    const scrollDir    = str('scroll_direction');
    const sourceIdx    = num('source_index');
    const targetIdx    = num('target_index');
    const clickType    = str('click_type');
    const extractQ     = str('extract_query');
    const dropVal      = str('dropdown_value');
    const inputVal     = str('input_value');
    const filePath     = str('file_path');
    const navigateUrl  = str('navigate_url');

    const pressEnterMatch = raw.match(/"press_enter"\s*:\s*(true|false)/i);
    if (pressEnterMatch) plan.press_enter = pressEnterMatch[1].toLowerCase() === 'true';

    if (waitMs      !== undefined) plan.wait_duration_ms = waitMs;
    if (textToType  !== undefined) plan.text_to_type     = textToType;
    if (selector    !== undefined) plan.selector         = selector;
    if (index       !== undefined) plan.index            = index;
    if (key         !== undefined) plan.key              = key;
    if (scrollDir   !== undefined) plan.scroll_direction = scrollDir as any;
    if (sourceIdx   !== undefined) plan.source_index     = sourceIdx;
    if (targetIdx   !== undefined) plan.target_index     = targetIdx;
    if (clickType   !== undefined) plan.click_type       = clickType as any;
    if (extractQ    !== undefined) plan.extract_query    = extractQ;
    if (dropVal     !== undefined) plan.dropdown_value   = dropVal;
    if (inputVal    !== undefined) plan.input_value      = inputVal;
    if (filePath    !== undefined) plan.file_path        = filePath;
    if (navigateUrl !== undefined) plan.navigate_url     = navigateUrl;

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

    // Stage 2: Standard JSON.parse (strictest)
    try {
        const p = JSON.parse(repaired) as ActionPlan;
        if (p.element_index !== undefined) delete p.coordinates;
        return p;
    } catch { /* fall through */ }

    // Stage 3: new Function() — tolerates unquoted keys, trailing commas
    try {
        const p = (new Function('return ' + repaired))() as ActionPlan;
        if (p.element_index !== undefined) delete p.coordinates;
        return p;
    } catch { /* fall through */ }

    // Stage 4: Field-by-field regex extraction
    return fieldExtract(raw);
}


// ─────────────────────────────────────────────
// System Prompt
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an elite browser automation agent with human-level web navigation skills.
You operate a strict Observe → Plan → Act loop.

Each turn you receive:
  • GOAL        — the user's objective
  • URL + TITLE — current page
  • FOCUSED     — currently active element (if any)
  • ELEMENTS    — numbered list of every interactive element with type, text, value
  • TEXT        — visible page text
  • HISTORY     — last 8 actions with success/fail status
  • SCREENSHOT  — live annotated browser screenshot

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOM VISUAL COLOR GUIDE (boxes on screenshot)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Each numbered box is colored by element type:

  🔴 RED   [BTN / LNK / CLK]  → Standard button, link, or clickable
                                  ACTION: CLICK
  🟡 AMBER [INP / LBL]        → Text input or label
                                  ACTION: TYPE  (fast fill for inputs)
  🟢 GREEN [SEL]              → Native <select> dropdown — OS-drawn, NEVER click it!
                                  ACTION: SELECT_OPTION + "dropdown_value"
  🟣 PURPLE [CHK / RDO / TGL] → Checkbox, radio button, or toggle switch
                                  ACTION: CLICK (toggles the state)
  🟠 ORANGE [RNG / FILE / DATE / CLR] → Slider, file input, date picker, color picker
                                  ACTION: SET_VALUE or UPLOAD_FILE
  🔵 BLUE  [DRG]              → Draggable card or list item
                                  ACTION: DRAG_AND_DROP
  🩵 TEAL  [NAV / CELL]       → Tab, menu item, or grid cell
                                  ACTION: CLICK
  🩷 PINK  [TXT]              → Textarea or rich-text editor
                                  ACTION: TYPE

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT — one JSON object, no markdown:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "current_state_analysis": "string", ← evaluate where you currently are in relation to the main GOAL. Did you already complete part of it? (1-2 sentences)
  "next_subgoal": "string",           ← what is the immediate logical next step? (1 sentence)
  "action": "CLICK" | "TYPE" | "CLEAR_INPUT" | "SET_VALUE" | "HOVER" | "KEY_PRESS"
           | "SCROLL" | "SCROLL_ELEMENT" | "DRAG_AND_DROP" | "SELECT_OPTION"
           | "UPLOAD_FILE" | "EXTRACT_DATA" | "NAVIGATE" | "NAVIGATE_BACK"
           | "WAIT" | "COMPLETE",

  "element_index": number,       ← PRIMARY target — use the box number from screenshot
  "click_type": "left"|"right"|"double",      (default: "left")
  "coordinates": { "x": number, "y": number }, (ONLY for unlabeled icons)
  "text_to_type": "string",      (TYPE / CLEAR_INPUT)
  "press_enter": boolean,        (submit after typing)
  "key": "string",               (KEY_PRESS — e.g. "Escape", "Tab", "ArrowDown", "F5")
  "scroll_direction": "UP"|"DOWN"|"TOP"|"BOTTOM",  (SCROLL / SCROLL_ELEMENT)
  "source_index": number,        (DRAG_AND_DROP source)
  "target_index": number,        (DRAG_AND_DROP target)
  "dropdown_value": "string",    (SELECT_OPTION — exact text or value)
  "input_value": "string",       (SET_VALUE — e.g. "75" for a slider)
  "file_path": "string",         (UPLOAD_FILE — absolute path)
  "extract_query": "string",     (EXTRACT_DATA — what to scrape)
  "navigate_url": "string",      (NAVIGATE — full URL including https://)
  "wait_duration_ms": number,
  "reasoning": "string"          ← one sentence, required
}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULES — read carefully before every action:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. VISUAL TARGETING: Use "element_index" (the number in the box) as your PRIMARY way to
   target elements. Look at the box color to choose the right action. Never invent selectors.

2. GREEN BOXES (SEL): These are native OS-drawn dropdowns. Clicking them with CLICK will
   FAIL. You MUST use SELECT_OPTION with "dropdown_value" set to the exact option text.

3. ORANGE BOXES (RNG/FILE/DATE): Use SET_VALUE with "input_value" for sliders/date pickers.
   Use UPLOAD_FILE with "file_path" for file inputs.

4. CUSTOM DROPDOWNS (not green): If a dropdown opens with CLICK showing a list, HOVER first,
   then CLICK the item. Use KEY_PRESS "ArrowDown"/"Enter" if the list is keyboard-navigable.

5. DEAD ACTION RECOVERY (CRITICAL):
   If the Action History says "PAGE DID NOT CHANGE" for your last action, you are STUCK IN A LOOP.
   DO NOT REPEAT THE EXACT SAME ACTION ON THE EXACT SAME ELEMENT. YOU MUST PIVOT!
   - PIVOT 1: Try HOVER on the element first, then CLICK on the next turn.
   - PIVOT 2: SCROLL the page to bring other elements into view.
   - PIVOT 3: Click a DIFFERENT element.
   - PIVOT 4: Try KEY_PRESS "Escape" to close overlays.
   Your "reasoning" MUST acknowledge the failure and state how you are changing strategy.

6. UNLABELED ICONS: If a critical element has NO numbered box, use "coordinates" to click it.
   Otherwise always use element_index.

7. ELEMENT NOT VISIBLE: If the target (e.g. a specific course or quiz) is not on the screen, 
   DO NOT click random buttons. Use SCROLL "DOWN" to move down the page and look for it.
   If content is in a scrollable panel, use SCROLL_ELEMENT on the panel's element_index.

8. DIRECT NAVIGATION & SEARCHING: If you know the exact URL needed (e.g. github.com), use
   NAVIGATE immediately instead of typing into a search bar. If you MUST use a search bar,
   ALWAYS set "press_enter": true to submit the search.

9. DATA EXTRACTION: Use EXTRACT_DATA to read tables, lists, or text. The data will be saved.

10. COMPLETE: Only output COMPLETE when you can visually confirm in the screenshot that
    the goal is 100% done. Do not guess — confirm visually.`;

// ─────────────────────────────────────────────
// Prompt Builder
// ─────────────────────────────────────────────

function buildPrompt(
    goal: string, url: string, title: string,
    elements: DomElement[], text: string,
    history: HistoryEntry[], priorMemory: string,
    focused: string
): string {

    // Rich element listing with type tag, placeholder, and current value
    const elemBlock = elements.length === 0
        ? '  (no interactive elements visible — try SCROLL DOWN)'
        : elements.map((el, i) => {
            const typeTag = (el.type || el.tag).toUpperCase();
            let line = `  [${i}] ${typeTag} "${el.text}"`;
            if (el.placeholder && el.placeholder !== el.text) {
                line += ` · ph:"${el.placeholder}"`;
            }
            if (el.value && el.value !== el.text) {
                line += ` · val:"${el.value}"`;
            }
            return line;
        }).join('\n');

    const histBlock = history.length === 0
        ? '  No actions yet.'
        : history.slice(-8).map(h =>
            `  Step ${h.step} | ${h.action} ${h.target ?? ''} | ` +
            `${h.success ? '✓ OK' : `✗ FAILED: ${h.error}`}`
          ).join('\n');

    const lastHist = history[history.length - 1];
    const stuckWarning = (lastHist && !lastHist.success && lastHist.error?.includes('PAGE DID NOT CHANGE'))
        ? `\n\n⚠️ WARNING: YOUR LAST ACTION FAILED ("PAGE DID NOT CHANGE"). DO NOT REPEAT IT! YOU MUST TRY A NEW STRATEGY (HOVER, SCROLL, OR A DIFFERENT ELEMENT)!`
        : '';

    return [
        `GOAL: ${goal}`,
        stuckWarning,
        priorMemory ? `\n${priorMemory}` : '',
        `\nCURRENT URL:   ${url}`,
        `PAGE TITLE:    ${title}`,
        focused ? `FOCUSED:       ${focused}` : '',
        `\nINTERACTIVE ELEMENTS (use element_index — do NOT invent selectors):`,
        elemBlock,
        `\nPAGE TEXT (first 800 chars):\n${text.slice(0, 800)}`,
        `\nACTION HISTORY:\n${histBlock}`,
        stuckWarning
    ].filter(Boolean).join('\n');
}

// ─────────────────────────────────────────────
// LLM Dispatchers
// ─────────────────────────────────────────────

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
        ]
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
        config: { responseMimeType: 'application/json' }
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
            options: { num_ctx: 8192 }
        })
    });
    const d = await res.json();
    if (d.error) throw new Error(`Ollama: ${JSON.stringify(d.error)}`);
    if (!d.message?.content) throw new Error(`Unexpected Ollama response: ${JSON.stringify(d)}`);
    return parseJSON(d.message.content);
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export async function getNextAction(
    goal: string, screenshot: string, text: string,
    elements: DomElement[], url: string, title: string,
    history: HistoryEntry[], priorMemory = '', focused = ''
): Promise<ActionPlan> {
    const prompt = buildPrompt(goal, url, title, elements, text, history, priorMemory, focused);

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
    const prompt = `Goal: "${goal}"\nHistory:\n${JSON.stringify(history, null, 2)}\n\nWrite a concise professional summary of what was accomplished.`;

    switch (config.provider) {
        case 'openai': {
            const c = new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseUrl });
            const r = await c.chat.completions.create({ model: config.openai.model, messages: [{ role: 'user', content: prompt }] });
            return r.choices[0].message.content ?? 'Done.';
        }
        case 'openrouter': {
            const c = new OpenAI({ apiKey: config.openrouter.apiKey, baseURL: 'https://openrouter.ai/api/v1' });
            const r = await c.chat.completions.create({ model: config.openrouter.model, messages: [{ role: 'user', content: prompt }] });
            return r.choices[0].message.content ?? 'Done.';
        }
        case 'gemini': {
            const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });
            const r  = await ai.models.generateContent({ model: config.gemini.model, contents: [{ role: 'user', parts: [{ text: prompt }] }] });
            return r.text ?? 'Done.';
        }
        case 'ollama': {
            const res = await fetch(config.ollama.baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: config.ollama.model, messages: [{ role: 'user', content: prompt }], stream: false, options: { num_ctx: 8192 } })
            });
            return (await res.json()).message?.content ?? 'Done.';
        }
        default: return 'Done.';
    }
}

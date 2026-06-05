// ─────────────────────────────────────────────────────────
// types.ts — Shared TypeScript interfaces for the agent
// ─────────────────────────────────────────────────────────

// ── All agent actions ───────────────────────────────────
export type AgentAction =
    | 'CLICK'           // Click an element (left / right / double)
    | 'TYPE'            // Type text — fast fill for inputs, keystroke for others
    | 'CLEAR_INPUT'     // Clear a text field, optionally type new text
    | 'SET_VALUE'       // Directly set value (sliders, date pickers, color inputs)
    | 'HOVER'           // Hover to reveal tooltips or CSS dropdown menus
    | 'KEY_PRESS'       // Press a keyboard key (Escape, Enter, Tab, ArrowDown, F5…)
    | 'SCROLL'          // Scroll the main page window (UP / DOWN / TOP / BOTTOM)
    | 'SCROLL_ELEMENT'  // Scroll inside a specific scrollable container
    | 'DRAG_AND_DROP'   // Drag source_index onto target_index
    | 'DRAG_TO_COORDS'  // Drag an element to specific absolute coordinates
    | 'TOUCH_TAP'       // Simulate a touch tap at element or coordinates (mobile-like)
    | 'SWIPE'           // Swipe gesture from start to end coordinates (web games, carousels)
    | 'SCROLL_TO_ELEMENT' // Scroll element into center of viewport
    | 'EXECUTE_JS'      // Execute arbitrary JavaScript in the page context (power user)
    | 'CLICK_TEXT'      // Semantic fallback: Click element by visible text
    | 'EXTRACT_TEXT'    // Extract plain text from a specific selector or the whole page
    | 'WAIT_FOR_TEXT'   // Wait for specific text to appear
    | 'WAIT_FOR_ELEMENT'// Wait for a specific selector to appear
    | 'KEYBOARD_COMBO'  // Press a complex key combination (e.g., 'Control+Shift+P')
    | 'SELECT_OPTION'   // Select from a native <select> dropdown — GREEN boxes ONLY
    | 'UPLOAD_FILE'     // Set a file path on a file input — ORANGE/FILE boxes
    | 'EXTRACT_DATA'    // Extract and display structured data from the page
    | 'NAVIGATE'        // Navigate directly to a URL
    | 'NAVIGATE_BACK'   // Go back one page in history
    | 'WAIT'            // Wait for a specified duration
    | 'SKILL'           // Invoke a named multi-step atomic skill
    | 'COMPLETE';       // Signal that the goal has been fully achieved

// ── Skill names ─────────────────────────────────────────
export type SkillName =
    | 'LOGIN'           // Auto-fill and submit a login form
    | 'SCROLL_TO_TEXT'  // Scroll until specified text is visible
    | 'WAIT_FOR_TEXT'   // Wait until specified text appears on page
    | 'CLOSE_MODAL'     // Dismiss a popup, modal, or cookie banner
    | 'SWITCH_TAB'      // Switch to a browser tab by title/index
    | 'WEB_SEARCH';     // Perform a direct search (google, youtube, duckduckgo)

// ── The LLM's structured action plan ────────────────────
export interface ActionPlan {
    /** Where are we right now relative to the overall goal? (1-2 sentences) */
    current_state_analysis: string;
    /** What is the immediate next logical step? (1 sentence) */
    next_subgoal: string;
    /** The action to execute */
    action: AgentAction;
    /** Human-readable justification (required) */
    reasoning: string;

    // ── Targeting ─────────────────────────────────────
    /** Box number from screenshot — PRIMARY targeting method */
    element_index?: number;
    /** Playwright CSS/text selector — secondary fallback */
    selector?: string;
    /** 0-based index when selector matches multiple elements */
    index?: number;
    /** Pixel coordinates — ONLY for unlabeled icons with no SoM box */
    coordinates?: { x: number; y: number };

    // ── Click options ──────────────────────────────────
    /** left (default) | right (context menu) | double (edit/expand) */
    click_type?: 'left' | 'right' | 'double';

    // ── Type / Input options ───────────────────────────
    /** Text to type for TYPE / CLEAR_INPUT actions */
    text_to_type?: string;
    /** Submit the form after typing */
    press_enter?: boolean;

    // ── Keyboard ──────────────────────────────────────
    /** Key name (e.g., 'Escape', 'Enter', 'Tab', 'ArrowDown', 'F5') */
    key?: string;

    // ── Scroll ────────────────────────────────────────
    /** Semantic scroll direction */
    scroll_direction?: 'UP' | 'DOWN' | 'TOP' | 'BOTTOM';

    // ── Drag & Drop ───────────────────────────────────
    source_index?: number;
    target_index?: number;
    /** For DRAG_TO_COORDS: The absolute X/Y to drop the dragged element */
    drop_coordinates?: { x: number; y: number };

    // ── Form / Input values ───────────────────────────
    /** SELECT_OPTION — exact option label or value string */
    dropdown_value?: string;
    /** SET_VALUE — value to set directly (e.g., "75" for a range slider) */
    input_value?: string;
    /** UPLOAD_FILE — absolute file path */
    file_path?: string;

    // ── Extraction ────────────────────────────────────
    extract_query?: string;

    // ── Navigation ────────────────────────────────────
    /** NAVIGATE — full URL including https:// */
    navigate_url?: string;

    // ── Wait & Fallbacks ──────────────────────────────
    wait_duration_ms?: number;
    /** Target text for WAIT_FOR_TEXT or CLICK_TEXT */
    target_text?: string;
    /** Expected selector for WAIT_FOR_ELEMENT, EXTRACT_TEXT, or SCROLL_TO_ELEMENT */
    target_selector?: string;

    // ── Touch / Swipe Gestures ──────────────────────────
    /** SWIPE start coordinates */
    swipe_from?: { x: number; y: number };
    /** SWIPE end coordinates */
    swipe_to?: { x: number; y: number };
    /** SWIPE duration in ms (default 400) */
    swipe_duration_ms?: number;

    // ── Execute JS ─────────────────────────────────────
    /** EXECUTE_JS — a JS expression string to evaluate in the browser context */
    js_code?: string;

    // ── Skills ────────────────────────────────────────
    /** Name of the atomic skill to invoke */
    skill_name?: SkillName;
    /** Free-form params passed to the skill (e.g. { domain: 'github.com' }) */
    skill_params?: Record<string, string>;
}

// ── Session history entry ────────────────────────────────
export interface HistoryEntry {
    step: number;
    url: string;
    action: string;
    target?: string;
    success: boolean;
    error?: string;
}

// ── A live interactive element scraped from the page DOM ─
export interface DomElement {
    tag: string;
    /**
     * Classified element category (matches SoM color coding):
     * btn, lnk, clk  → CLICK
     * inp, lbl        → TYPE
     * sel             → SELECT_OPTION
     * chk, rdo, tgl  → CLICK (toggles)
     * rng, file, date, clr → SET_VALUE / UPLOAD_FILE
     * drg             → DRAG_AND_DROP
     * nav, cell       → CLICK (navigation)
     * txt             → TYPE (multiline)
     */
    type: string;
    text: string;
    selector: string;
    /** href for anchor elements (relative URL) */
    href?: string;
    /** name attribute (helps LLM distinguish username vs password) */
    name?: string;
    /** aria-label attribute */
    ariaLabel?: string;
    /** Current field value */
    value?: string;
    /** Placeholder text for empty text inputs */
    placeholder?: string;
    /** Absolute center coordinates (X, Y) relative to the main viewport. 
     * Used for robust clicking, especially inside cross-origin iframes. */
    center?: { x: number; y: number };
}

// ── Credential memory entry ──────────────────────────────
export interface Credential {
    domain: string;
    username: string;
    password: string;
    /** Optional field selectors if auto-detect fails */
    usernameSelector?: string;
    passwordSelector?: string;
}

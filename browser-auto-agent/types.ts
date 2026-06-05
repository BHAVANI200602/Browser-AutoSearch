// Shared types for agent.ts and llm.ts

export type AgentAction =
    | 'CLICK'          // Click an element (left / right / double)
    | 'TYPE'           // Type text — uses fast page.fill() for inputs, keystroke for others
    | 'CLEAR_INPUT'    // Clear a text field, optionally then type new text
    | 'SET_VALUE'      // Directly set value for range sliders, date pickers, color inputs
    | 'HOVER'          // Hover to reveal tooltips or CSS dropdown menus
    | 'KEY_PRESS'      // Press a keyboard key (Escape, Enter, Tab, ArrowDown, F5…)
    | 'SCROLL'         // Scroll the main page window (UP / DOWN / TOP / BOTTOM)
    | 'SCROLL_ELEMENT' // Scroll inside a specific scrollable container
    | 'DRAG_AND_DROP'  // Drag source_index onto target_index
    | 'SELECT_OPTION'  // Select from a native <select> dropdown — GREEN boxes ONLY
    | 'UPLOAD_FILE'    // Set a file path on a file input — ORANGE/FILE boxes
    | 'EXTRACT_DATA'   // Extract and display structured data from the page
    | 'NAVIGATE'       // Navigate directly to a URL
    | 'NAVIGATE_BACK'  // Go back one page in history
    | 'WAIT'           // Wait for a specified duration
    | 'COMPLETE';      // Signal that the goal has been fully achieved

export interface ActionPlan {
    current_state_analysis: string;
    next_subgoal: string;
    action: 'CLICK' | 'TYPE' | 'CLEAR_INPUT' | 'SET_VALUE' | 'HOVER' | 'KEY_PRESS' | 'SCROLL' | 'SCROLL_ELEMENT' | 'DRAG_AND_DROP' | 'SELECT_OPTION' | 'UPLOAD_FILE' | 'EXTRACT_DATA' | 'NAVIGATE' | 'NAVIGATE_BACK' | 'WAIT' | 'COMPLETE';
    /** Index into the INTERACTIVE ELEMENTS list — PRIMARY targeting method */
    element_index?: number;
    /** Playwright selector — fallback if element_index is unavailable */
    selector?: string;
    /** 0-based index when selector matches multiple elements */
    index?: number;
    /** Pixel coordinates — ONLY for icon-only elements with no colored SoM box */
    coordinates?: { x: number; y: number };
    /** left (default) | right (context menu) | double (edit / expand) */
    click_type?: 'left' | 'right' | 'double';
    /** Text to type for TYPE / CLEAR_INPUT actions */
    text_to_type?: string;
    /** Submit the form after typing */
    press_enter?: boolean;
    /** Key name for KEY_PRESS (e.g., 'Escape', 'Enter', 'Tab', 'ArrowDown', 'F5') */
    key?: string;
    /** Semantic scroll direction for SCROLL and SCROLL_ELEMENT */
    scroll_direction?: 'UP' | 'DOWN' | 'TOP' | 'BOTTOM';
    /** For DRAG_AND_DROP: element_index of the item to drag */
    source_index?: number;
    /** For DRAG_AND_DROP: element_index of the drop target */
    target_index?: number;
    /** For SELECT_OPTION: exact option label or value string */
    dropdown_value?: string;
    /** For SET_VALUE: value to set directly (e.g., "75" for a range slider) */
    input_value?: string;
    /** For UPLOAD_FILE: absolute file path */
    file_path?: string;
    /** For EXTRACT_DATA: description of what information to extract */
    extract_query?: string;
    /** For NAVIGATE: full URL to navigate to */
    navigate_url?: string;
    /** For WAIT: duration in milliseconds */
    wait_duration_ms?: number;
    reasoning: string;
}

export interface HistoryEntry {
    step: number;
    url: string;
    action: string;
    target?: string;
    success: boolean;
    error?: string;
}

/** A live interactive element scraped from the page DOM */
export interface DomElement {
    tag: string;
    /**
     * Classified element category:
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
    href?: string;
    /** Current field value (inputs, selects, aria-checked, etc.) */
    value?: string;
    /** Placeholder text for empty text inputs */
    placeholder?: string;
}

# Browser Agent v4 — Enterprise Browser Automation

An enterprise-grade AI browser automation agent that can perform **complex web task** by visually understanding the page through Set-of-Mark (SoM) grounding and making intelligent decisions using a vision-language model.

---

## Quick Start

### 1. Start Chrome with remote debugging
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-agent-profile"
```

### 2. Store your credentials (one-time setup)
```powershell
npx tsx add-credential.ts lms.industryskills.org your@email.com YourPassword
npx tsx add-credential.ts github.com yourusername yourpassword
```

### 3. Run a task
```powershell
npx tsx agent.ts "navigate to my courses and click on azure 104 and go to practice quiz 4"
npx tsx agent.ts "search for playwright documentation on google"
npx tsx agent.ts "go to github.com and create a new repository called test-repo"
npx tsx agent.ts "extract all the quiz questions from the current page and save them"
```

---

## Architecture

```
browser-auto-agent/
├── agent.ts           Main orchestrator — Observe → Plan → Act loop
├── llm.ts             LLM dispatcher + system prompt + JSON parser
├── types.ts           TypeScript interfaces for all data structures
├── memory.ts          Persistent credential + fact store (logs/memory.json)
├── add-credential.ts  CLI to store domain credentials
├── config.ts          LLM provider configuration (.env)
└── logs/
    ├── memory.json    Persisted credentials and known facts
    ├── session_*.json History of each agent run
    ├── extract_*.txt  Extracted data output
    └── screenshots/   Step-by-step annotated screenshots
```

---

## Set-of-Mark Visual Engine (SoM v4)

Every interactive element is annotated with a **colored numbered box** before each screenshot is taken. The color tells the LLM exactly which Playwright action to use:

| Color  | Category       | Elements                        | Action           |
|--------|----------------|---------------------------------|------------------|
| 🔴 Red  | BTN / LNK / CLK | Buttons, links, clickable divs  | `CLICK`          |
| 🟡 Amber | INP / LBL     | Text inputs, labels             | `TYPE`           |
| 🟢 Green | SEL           | Native `<select>` dropdowns     | `SELECT_OPTION`  |
| 🟣 Purple | CHK/RDO/TGL  | Checkboxes, radios, toggles     | `CLICK`          |
| 🟠 Orange | RNG/FILE/DATE | Sliders, file pickers, dates    | `SET_VALUE`      |
| 🔵 Blue  | DRG           | Draggable cards, sortable items | `DRAG_AND_DROP`  |
| 🩵 Teal  | NAV / CELL    | Tabs, menu items, grid cells    | `CLICK`          |
| 🩷 Pink  | TXT           | Textareas, rich-text editors    | `TYPE`           |

**SoM v4 improvements:**
- Traverses Shadow DOM and same-origin iframes
- Includes `name`, `aria-label`, `placeholder`, `value`, and `href` per element
- Elements sorted by visual priority (inputs first, then buttons, then links)
- Capped at 80 elements per frame for performance

---

## Skill Engine

The agent can invoke **atomic multi-step skills** for complex sub-tasks:

| Skill             | Description                                      | Parameters                          |
|-------------------|--------------------------------------------------|-------------------------------------|
| `LOGIN`           | Auto-fills login form from stored credentials    | `domain` (optional)                 |
| `SCROLL_TO_TEXT`  | Scrolls page until specified text is visible     | `text`, `maxScrolls` (default: 10)  |
| `WAIT_FOR_TEXT`   | Waits for text to appear after async load        | `text`, `timeout` (default: 8000ms) |
| `CLOSE_MODAL`     | Dismisses modals, popups, cookie banners         | none                                |
| `SWITCH_TAB`      | Switches browser tab by title or index           | `title` or `index`                  |

### How to trigger a skill (via natural language):
```
"log into lms.industryskills.org"         → agent uses SKILL: LOGIN
"wait for the quiz results to load"        → agent uses SKILL: WAIT_FOR_TEXT
"close the popup and continue"             → agent uses SKILL: CLOSE_MODAL
"scroll down until you find Practice Quiz" → agent uses SKILL: SCROLL_TO_TEXT
```

---

## Credential Memory

Credentials are stored in `logs/memory.json` and matched automatically by domain.

```json
{
  "credentials": [
    {
      "domain": "lms.industryskills.org",
      "username": "user@email.com",
      "password": "secret"
    },
    {
      "domain": "github.com",
      "username": "myuser",
      "password": "ghp_token"
    }
  ],
  "facts": {}
}
```

**Add credentials via CLI:**
```powershell
npx tsx add-credential.ts <domain> <username> <password>
```

---

## Configuration

Edit `.env` to choose your LLM provider:

```env
# Options: openai | gemini | ollama | openrouter
LLM_PROVIDER="openai"

# LM Studio (local)
OPENAI_API_KEY="lm-studio"
OPENAI_MODEL="qwen/qwen2.5-vl-7b"
OPENAI_BASE_URL="http://localhost:1234/v1"

# Gemini
# LLM_PROVIDER="gemini"
# GEMINI_API_KEY="AIza..."
# GEMINI_MODEL="gemini-2.5-pro"

# OpenRouter (cloud)
# LLM_PROVIDER="openrouter"
# OPENROUTER_API_KEY="sk-or-..."
# OPENROUTER_MODEL="anthropic/claude-3.5-sonnet"
```

---

## What's New in v4

### Critical Bug Fixes
- **`humanClick` signature fixed** — was called with wrong argument types (number instead of string), causing ALL coordinate clicks to silently do nothing
- **Duplicate log lines removed** — `Action:` and `Reasoning:` were printed twice per step
- **Native click with `scrollIntoViewIfNeeded`** — elements are scrolled into viewport before clicking, preventing missed clicks on sticky-header pages
- **`networkidle` wait after CLICK/NAVIGATE** — prevents dead-action false positives on async/SPA pages

### New Capabilities
- **Skill Engine** — 5 atomic skills: LOGIN, SCROLL_TO_TEXT, WAIT_FOR_TEXT, CLOSE_MODAL, SWITCH_TAB
- **Credential Memory** — `logs/memory.json` stores per-domain credentials, auto-filled on login pages
- **Chain-of-Thought output** — each step prints `Analysis:` and `SubGoal:` so you can see the model's reasoning
- **Grace-period dead-action detection** — 2 identical snapshots required before marking dead (prevents false positives on slow loaders)
- **80 max steps** (up from 40) — handles complex multi-page workflows
- **Element `name` and `aria-label` in prompt** — LLM correctly distinguishes username vs password fields
- **Temperature 0.1** — more deterministic, less hallucination

---

## Example Output

```
╔══════════════════════════════════════════╗
║  Browser Agent  v4  —  starting          ║
╚══════════════════════════════════════════╝
Goal: "navigate to my courses and click on azure 104 and go to practice quiz 4"

──── Step 1/80 ─────────────────────────
[Observe] Capturing state…
  URL:     https://lms.industryskills.org/login/index.php
  Title:   Log in | INBIOT
  Elements: 11 found [7 btns · 2 inputs · 0 checks]
[Plan]  Querying LLM…
  Analysis:  I am on the login page and need credentials to proceed.
  SubGoal:   Use the LOGIN skill to authenticate using stored credentials.
  Action:    SKILL
  Reasoning: The LOGIN skill will automatically fill and submit the login form.
  Target:    skill:LOGIN
  [Act] Skill: LOGIN
  [Skill:LOGIN] Using credential for domain: lms.industryskills.org
  [Skill:LOGIN] Username field: #username (name="username")
  [Skill:LOGIN] Password field: #password (name="password")
  [Skill:LOGIN] Clicking submit: "Log in"
  [Skill:LOGIN] Done. Current URL: https://lms.industryskills.org/my/

──── Step 2/80 ─────────────────────────
[Observe] Capturing state…
  URL:     https://lms.industryskills.org/my/
  Analysis:  I am now logged in on the dashboard. Next: find AZ-104 course.
  SubGoal:   Click on the AZ-104 course card.
  Action:    CLICK
  Target:    element[12] "AZ-104 | Microsoft Azure Administrator" (lnk)
```

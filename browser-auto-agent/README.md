# Browser Automation Agent

This project is a highly resilient browser automation agent that operates in a background Observe-Plan-Act loop. It leverages Vision LLMs to interact with any existing Chrome instance, allowing you to handle manual tasks like CAPTCHAs before unleashing the agent.

## How It Works

Instead of launching a new browser context that triggers bot protection, this agent connects to an *already running* browser using the Chrome DevTools Protocol (CDP) on Port 9222.

The agent captures screenshots and accessibility trees (Observe), passes them to a Vision LLM to pick the next step (Plan), and emulates human-like mouse movements and keystrokes (Act).

## Setup & Execution

### 1. Launch Chrome with Anti-Throttling Flags

Modern browsers pause execution when tabs lose focus. To prevent the agent from freezing while you do other work, you **must** launch Chrome using the exact shell command below. 

**Windows (PowerShell):**
```powershell
Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--no-first-run", "--no-default-browser-check"
```

**macOS:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --no-first-run --no-default-browser-check
```

### 2. Configure Environment

Copy `.env.example` to `.env` and configure your LLM providers. See `config.ts` for dynamic configuration options.

```bash
cp .env.example .env
```

### 3. Run the Agent

Run the agent with your high-level English goal as the command-line argument:

```bash
npx tsx agent.ts "Navigate to the contact page and fill out the form"
```

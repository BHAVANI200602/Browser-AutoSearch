import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";

let browser = null;
let page = null;

async function getPage() {
  if (!browser) {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    page = await context.newPage();
  }
  return page;
}

const server = new Server(
  {
    name: "playwright-browser",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "browser_navigate",
        description: "Navigate the browser to a specific URL.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The URL to navigate to (e.g., https://example.com)",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "browser_click",
        description: "Click an element on the page using a CSS selector.",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the element to click",
            },
          },
          required: ["selector"],
        },
      },
      {
        name: "browser_fill",
        description: "Fill a text input field identified by a CSS selector.",
        inputSchema: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the input element",
            },
            text: {
              type: "string",
              description: "The text to type into the field",
            },
          },
          required: ["selector", "text"],
        },
      },
      {
        name: "browser_extract_dom",
        description: "Extract the text-based DOM structure of the current page for analysis.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const p = await getPage();
  
  if (request.params.name === "browser_navigate") {
    const url = request.params.arguments.url;
    await p.goto(url);
    return {
      content: [{ type: "text", text: `Navigated to ${url}. Title is: ${await p.title()}` }],
    };
  }
  
  if (request.params.name === "browser_click") {
    const selector = request.params.arguments.selector;
    await p.click(selector);
    await p.waitForLoadState("networkidle").catch(() => {});
    return {
      content: [{ type: "text", text: `Clicked element: ${selector}` }],
    };
  }

  if (request.params.name === "browser_fill") {
    const selector = request.params.arguments.selector;
    const text = request.params.arguments.text;
    await p.fill(selector, text);
    return {
      content: [{ type: "text", text: `Filled ${selector} with text.` }],
    };
  }

  if (request.params.name === "browser_extract_dom") {
    // Extract a condensed representation of the DOM
    const data = await p.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let out = "";
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tag = node.tagName.toLowerCase();
          if (["script", "style", "noscript", "svg", "path"].includes(tag)) continue;
          
          let attributes = "";
          if (node.id) attributes += ` id="${node.id}"`;
          if (node.hasAttribute("name")) attributes += ` name="${node.getAttribute("name")}"`;
          if (node.hasAttribute("aria-label")) attributes += ` aria-label="${node.getAttribute("aria-label")}"`;
          if (node.hasAttribute("placeholder")) attributes += ` placeholder="${node.getAttribute("placeholder")}"`;
          if (tag === "a" && node.hasAttribute("href")) attributes += ` href="${node.getAttribute("href")}"`;
          if (tag === "button" || tag === "input" || tag === "a" || tag === "select" || node.id || node.hasAttribute("name")) {
              out += `<${tag}${attributes}>\n`;
          }
        } else if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent.trim();
          if (text) {
             const parentTag = node.parentElement?.tagName.toLowerCase();
             if (!["script", "style", "noscript"].includes(parentTag)) {
                 out += text + "\n";
             }
          }
        }
      }
      return out;
    });
    
    return {
      content: [{ type: "text", text: data }],
    };
  }

  throw new Error(`Unknown tool: ${request.params.name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Playwright MCP Server running on stdio");
}

main().catch(console.error);

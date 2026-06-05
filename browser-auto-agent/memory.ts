// ─────────────────────────────────────────────────────────
// memory.ts — Persistent credential + knowledge store
//
// Stores credentials per-domain in logs/memory.json.
// The agent reads this before attempting login so it never
// needs to guess or ask the user for passwords mid-run.
// ─────────────────────────────────────────────────────────
import * as fs   from 'fs';
import * as path from 'path';
import type { Credential } from './types';

const MEMORY_FILE = path.join(process.cwd(), 'logs', 'memory.json');

interface MemoryStore {
    credentials: Credential[];
    /** Key-value facts the agent has learned (e.g. page URLs) */
    facts: Record<string, string>;
}

// ── Load / Save ─────────────────────────────────────────

function loadStore(): MemoryStore {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8')) as MemoryStore;
        }
    } catch { /* corrupt file — start fresh */ }
    return { credentials: [], facts: {} };
}

function saveStore(store: MemoryStore): void {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2));
}

// ── Public API ──────────────────────────────────────────

/** Return the best-matching credential for a given URL. */
export function getCredential(url: string): Credential | undefined {
    const store = loadStore();
    const hostname = (() => {
        try { return new URL(url).hostname; }
        catch { return url; }
    })();

    // Exact domain match first, then subdomain/partial match
    return (
        store.credentials.find(c => hostname === c.domain) ??
        store.credentials.find(c => hostname.endsWith(c.domain) || c.domain.endsWith(hostname))
    );
}

/** Persist a credential (upserts by domain). */
export function setCredential(cred: Credential): void {
    const store = loadStore();
    const idx = store.credentials.findIndex(c => c.domain === cred.domain);
    if (idx >= 0) {
        store.credentials[idx] = cred;
    } else {
        store.credentials.push(cred);
    }
    saveStore(store);
    console.log(`[Memory] Credential saved for domain: ${cred.domain}`);
}

/** Store a named fact (e.g. dashboard URL after login). */
export function setFact(key: string, value: string): void {
    const store = loadStore();
    store.facts[key] = value;
    saveStore(store);
}

/** Retrieve a named fact. */
export function getFact(key: string): string | undefined {
    return loadStore().facts[key];
}

/** Load last N successful session history entries as memory hints. */
export function loadPriorSessionHints(logsDir: string, n = 12): string {
    try {
        const files = fs.readdirSync(logsDir)
            .filter(f => f.startsWith('session_') && f.endsWith('.json'))
            .sort((a, b) =>
                fs.statSync(path.join(logsDir, b)).mtimeMs -
                fs.statSync(path.join(logsDir, a)).mtimeMs
            );
        if (!files.length) return '';
        const raw = JSON.parse(fs.readFileSync(path.join(logsDir, files[0]), 'utf-8'));
        const lines = (raw as any[])
            .filter(h => h.success && h.action !== 'LLM_ERROR')
            .map(h => `${h.action}${h.target ? ` on ${h.target}` : ''} @ ${h.url}`)
            .slice(-n);
        return lines.length ? `Prior session hints (most recent first):\n${lines.join('\n')}` : '';
    } catch { return ''; }
}

/** Print current memory store summary to console. */
export function printMemorySummary(): void {
    const store = loadStore();
    console.log(`[Memory] ${store.credentials.length} credential(s) stored.`);
    store.credentials.forEach(c =>
        console.log(`  domain=${c.domain}  user=${c.username}`)
    );
}

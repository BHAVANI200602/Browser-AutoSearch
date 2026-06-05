#!/usr/bin/env npx tsx
// ─────────────────────────────────────────────────────────
// add-credential.ts — CLI to store login credentials
//
// Usage:
//   npx tsx add-credential.ts <domain> <username> <password>
//
// Example:
//   npx tsx add-credential.ts lms.industryskills.org bsekhara2@gitam.in MyPassword123
// ─────────────────────────────────────────────────────────
import { setCredential, printMemorySummary } from './memory';

const [,, domain, username, password] = process.argv;

if (!domain || !username || !password) {
    console.error('\nUsage:  npx tsx add-credential.ts <domain> <username> <password>');
    console.error('Example: npx tsx add-credential.ts lms.industryskills.org user@email.com MyPass123\n');
    process.exit(1);
}

setCredential({ domain, username, password });
console.log('\n✅ Credential saved.\n');
printMemorySummary();

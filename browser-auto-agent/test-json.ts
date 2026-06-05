// Test the JSON repair pipeline against every known malformation pattern

function structuralRepair(raw: string): string {
    let s = raw;
    s = s.replace(/```(?:json)?\s*([\s\S]*?)\s*```/ig, '$1').trim();
    const start = s.indexOf('{');
    const end   = s.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error(`No JSON object found.`);
    s = s.slice(start, end + 1);
    s = s.replace(/"x"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*}/g, '"x": $1, "y": $2 }');
    s = s.replace(/"x"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*y\s*:\s*(-?\d+(?:\.\d+)?)/gi, '"x": $1, "y": $2');
    s = s.replace(/,\s*([}\]])/g, '$1');
    s = s.replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');
    return s;
}

function fieldExtract(raw: string): any {
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
    let reasoning = 'Proceeding with goal.';
    const rm = raw.match(/"reasoning"\s*:\s*"([\s\S]*?)"(?:\s*[}\]]|\s*$)/i);
    if (rm) {
        reasoning = rm[1].replace(/"\s*[}\]]\s*$/, '').trim() || reasoning;
    }
    let coordinates: { x: number; y: number } | undefined;
    const cm = raw.match(/"coordinates"\s*:\s*\{[^}]*?"x"\s*:\s*(-?\d+(?:\.\d+)?)[^}]*?[,\s](?:"?y"?\s*:\s*)?(-?\d+(?:\.\d+)?)/i);
    if (cm) coordinates = { x: Number(cm[1]), y: Number(cm[2]) };

    const elementIndex = num('element_index');
    const action       = (str('action') ?? 'WAIT');
    const plan: any = { action, reasoning };

    if (elementIndex !== undefined) plan.element_index = elementIndex;
    else if (coordinates) plan.coordinates = coordinates;

    return plan;
}

function parseJSON(raw: string) {
    let repaired: string;
    try {
        repaired = structuralRepair(raw);
    } catch (e: any) {
        return fieldExtract(raw);
    }
    try {
        const p = JSON.parse(repaired);
        if (p.element_index !== undefined) delete p.coordinates;
        return p;
    } catch { /* fall through */ }
    try {
        const p = (new Function('return ' + repaired))();
        if (p.element_index !== undefined) delete p.coordinates;
        return p;
    } catch { /* fall through */ }
    return fieldExtract(raw);
}

const tests = [
    {
        name: 'Unescaped quotes + unquoted y key',
        input: `{\n  "action": "CLICK",\n  "element_index": 27,\n  "coordinates": { "x": 863, y: 541 },\n  "reasoning": "Click on the "Online grade card" button to proceed towards viewing sem 6."\n}`
    },
    {
        name: 'Unescaped quotes + quoted y key',
        input: `{\n  "action": "CLICK",\n  "element_index": 27,\n  "coordinates": { "x": 893, "y": 571 },\n  "reasoning": "Click on the "Online grade card" button to proceed towards viewing sem 6."\n}`
    },
    {
        name: 'Missing "y": in coordinates',
        input: '{"action": "CLICK", "element_index": 27, "coordinates": { "x": 864, 539 }, "reasoning": "test"}'
    },
    {
        name: 'Trailing comma',
        input: '{"action": "CLICK", "element_index": 3, "reasoning": "test",}'
    },
    {
        name: 'Single quotes',
        input: "{'action': 'SCROLL', 'scroll_y': 400, 'reasoning': 'test'}"
    }
];

let passed = 0;
for (const t of tests) {
    try {
        const result = parseJSON(t.input);
        console.log(`✓ PASS  [${t.name}]  →  action=${result.action} element_index=${result.element_index ?? 'none'} coords=${result.coordinates ? JSON.stringify(result.coordinates) : 'none'} reasoning="${result.reasoning.substring(0, 30)}..."`);
        passed++;
    } catch (e: any) {
        console.error(`✗ FAIL  [${t.name}]  →  ${e.message}`);
    }
}

console.log(`\n${passed}/${tests.length} tests passed`);

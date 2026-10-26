// Structured-output schemas for the hunk explainer and the whole-PR reviewer.

export const HUNK_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "trivial"],
    properties: {
        summary: { type: "string", description: "1-3 sentence plain explanation of what the change does and why it matters. Start with the verb (for example \"Adds…\"); do not start with \"This hunk\"." },
        trivial: { type: "boolean", description: "True when the hunk has no logic change. Examples: import or export changes, variable housekeeping (declare, rename, reorder, remove unused), whitespace-only changes (indentation, blank lines, line breaks, trailing spaces), formatting, comments, docs and other plain text, version bumps, generated files. False if the hunk changes a condition, call, value, type, or control flow." },
    },
};

// Shape follows the /pr-review skill: intent, approach, falsified findings that meet the five-item bar.
export const REVIEW_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["intent", "approach", "findings", "openQuestions", "bottomLine"],
    properties: {
        intent: { type: "string", description: "The intended behavior in one sentence, and the source it came from." },
        approach: { type: "string", description: "One or two sentences on how the change implements the intent." },
        findings: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["severity", "category", "file", "line", "title", "scenario", "impact", "evidence", "fix"],
                properties: {
                    severity: { type: "string", enum: ["blocking", "warning"] },
                    category: { type: "string", description: "Risk category, for example correctness, security, performance, tests, requirements." },
                    file: { type: "string", description: "Path as it appears in the diff (new side)." },
                    line: { type: "integer", description: "Changed line on the new side that causes or exposes the problem; 0 if file-level." },
                    title: { type: "string" },
                    scenario: { type: "string", description: "The input, event, or sequence that fails." },
                    impact: { type: "string", description: "The user or system consequence." },
                    evidence: { type: "string", description: "The code, test, or requirement that proves the finding." },
                    fix: { type: "string", description: "The smallest practical correction." },
                },
            },
        },
        openQuestions: { type: "array", items: { type: "string" }, description: "Only questions that block a confident assessment." },
        bottomLine: { type: "string", description: "The confirmed risks and material unknowns. No merge verdict." },
    },
};

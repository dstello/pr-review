// Extension: pr-review
// Split canvas for reviewing a PR: AI explanations/findings on the left, diff2html code view on the right.
// A small model explains each hunk; a larger model reviews the whole change.
// Results are saved per PR, head, base and model pair; the UI lists, opens and deletes saved reviews.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join, dirname, extname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { joinSession, createCanvas, defineWorkflow, CanvasError } from "@github/copilot-sdk/extension";
import { hunkAt, parseDiff } from "./diff.mjs";
import { HUNK_SCHEMA, REVIEW_SCHEMA } from "./schemas.mjs";
import { gh } from "./gh.mjs";
import { DEFAULT_MODELS, validateModels } from "./models.mjs";
import { modelCatalog } from "./model-catalog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "extensions", "pr-review", "artifacts");
const WORKFLOW = "pr-review-canvas-analyze";
const ASK_WORKFLOW = "pr-review-canvas-ask";
// ponytail: generated/lock files are never worth a per-hunk explanation
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock)$|\.min\.(js|css)$|\.snap$/;
const MAX_HUNKS = 80; // ponytail: hard cap on per-hunk agents; raise if large PRs need full coverage
const MAX_REVIEW_DIFF = 150_000; // ponytail: big-model prompt truncation; chunk the review if PRs exceed this
// ASD-STE100 rules from the /ste-writing skill, applied to all model-written text.
const STE = "Write all text in Simplified Technical English (ASD-STE100): active voice, one statement per sentence, max 20 words per sentence, short common words (use, start, get, show, make sure), one name for one thing, articles (a, an, the), no contractions, no semicolons, no marketing adjectives, American spelling. Use a verb for an action (\"check the input\", not \"perform a check of the input\"). No phrasal verbs, no \"-ing\" main verbs, no stacked auxiliaries (\"it is important to note that this may help to\"). No preamble, no summary, no closing remarks. Before you answer, split long sentences and remove filler words.";
const EMPHASIS = "Use light inline emphasis in text fields: **bold** for the key behavior change or risk, *italic* for conditions and qualifiers, __underline__ for the consequence the reader must not miss, `backticks` for identifiers. Use at most two or three emphasized phrases per field. No headings, lists, or links.";

const states = new Map(); // "owner/repo#n" → state
const clients = new Map(); // key → Set<res> (SSE)
const instances = new Map(); // instanceId → key

function parseRef(pr) {
    const m = String(pr).trim().match(/^(?:https?:\/\/[^/]+\/)?([\w.-]+\/[\w.-]+)(?:\/pull\/|#)(\d+)/);
    if (!m) throw new CanvasError("invalid_pr", `Expected a PR URL or owner/repo#number, got "${pr}"`);
    return { repo: m[1], num: m[2], key: `${m[1]}#${m[2]}` };
}

function placeFinding(files, finding) {
    const fi = files.findIndex((f) => f.path === finding.file || f.path.endsWith("/" + finding.file) || finding.file?.endsWith("/" + f.path));
    if (fi < 0) return { ...finding, fi: -1, hi: -1 };
    const hunks = files[fi].hunks;
    let hi = hunks.findIndex((h) => finding.line >= h.start && finding.line <= h.end);
    if (hi < 0 && finding.line > 0 && hunks.length) {
        const dist = (h) => Math.min(Math.abs(finding.line - h.start), Math.abs(finding.line - h.end));
        hi = hunks.reduce((best, h, i) => (dist(h) < dist(hunks[best]) ? i : best), 0);
    }
    return { ...finding, fi, hi };
}

// The diff depends on the head and the base branch; the results depend on the models too.
const identity = (meta, models) => `${meta.headRefOid}:${meta.baseRefName}:${models.hunkModel}:${models.reviewModel}`;
const cachePath = (st) => join(ARTIFACTS, `${st.repo.replace("/", "__")}-${st.num}-${createHash("sha1").update(identity(st.meta, st.models)).digest("hex").slice(0, 12)}-v6.json`);

async function save(st) {
    await mkdir(ARTIFACTS, { recursive: true });
    const { key, repo, num, meta, stack, diff, notes, review, models, chats } = st;
    await writeFile(cachePath(st), JSON.stringify({ key, repo, num, meta, stack, diff, notes, review, models, chats }));
}

function annotations(st) {
    const { status, error, progress, notes, review, meta, stack, models, chats } = st;
    return { status, error, progress, notes, review, meta, stack: stack ?? null, models, chats, file: status === "done" ? basename(cachePath(st)) : null };
}

function push(st) {
    if (states.get(st.key) !== st) return;
    const data = `data: ${JSON.stringify(annotations(st))}\n\n`;
    for (const res of clients.get(st.key) ?? []) res.write(data);
}

// A saved thread can be "running" only if the process stopped during an answer.
const settle = (chats = []) => chats.map((t) => (t.status === "running" ? { ...t, status: "error", error: "The answer was interrupted. Ask again." } : t));

// GitHub stacked pull requests: one query returns every layer. A PR outside a stack, or an API error, gives null.
const STACK_QUERY = `query($owner: String!, $name: String!, $num: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $num) {
  stack { number baseRefName entries(first: 50) { nodes { position pullRequest { number title headRefName state isDraft } } } } } } }`;
async function stackOf(repo, num) {
    const [owner, name] = repo.split("/");
    try {
        const s = JSON.parse(await gh(["api", "graphql", "-f", `query=${STACK_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `num=${num}`])).data.repository.pullRequest.stack;
        return s && { number: s.number, base: s.baseRefName, entries: s.entries.nodes.map(({ position, pullRequest: p }) => ({ position, number: p.number, title: p.title, head: p.headRefName, state: p.isDraft && p.state === "OPEN" ? "DRAFT" : p.state })) };
    } catch {
        return null;
    }
}

async function load(input) {
    const { repo, num, key } = parseRef(input.pr);
    const models = { hunkModel: input.hunkModel || DEFAULT_MODELS.hunkModel, reviewModel: input.reviewModel || DEFAULT_MODELS.reviewModel };
    const [view, stack] = await Promise.all([gh(["pr", "view", num, "--repo", repo, "--json", "title,body,url,headRefOid,headRefName,baseRefName,author"]), stackOf(repo, num)]);
    const meta = JSON.parse(view);
    const existing = states.get(key);
    if (existing && (existing.status === "running" || identity(existing.meta, existing.models) === identity(meta, models))) return Object.assign(existing, { stack });
    const st = { key, repo, num, meta, stack, models, notes: {}, review: null, chats: [], status: "idle", error: null, progress: { done: 0, total: 0 } };
    const cached = await readFile(cachePath(st), "utf8").then(JSON.parse, () => null);
    if (cached) Object.assign(st, { diff: cached.diff, notes: cached.notes, review: cached.review, chats: settle(cached.chats), status: "done" });
    else st.diff = await gh(["pr", "diff", num, "--repo", repo]);
    st.files = parseDiff(st.diff);
    states.set(key, st);
    return st;
}

// Saved reviews: one artifact per PR, head, base and model pair.
const SAVED_RE = /^[\w.-]+-v6\.json$/;

async function restore(file) {
    if (!SAVED_RE.test(file)) throw new CanvasError("invalid_review", `Unknown review "${file}"`);
    const c = JSON.parse(await readFile(join(ARTIFACTS, file), "utf8"));
    if (states.get(c.key)?.status === "running") return states.get(c.key);
    const st = { ...c, chats: settle(c.chats), status: "done", error: null, progress: { done: 0, total: 0 }, files: parseDiff(c.diff) };
    states.set(st.key, st);
    return st;
}

// ponytail: parses every saved file per call; add a summary index if the list gets long.
async function listReviews() {
    const names = (await readdir(ARTIFACTS).catch(() => [])).filter((n) => SAVED_RE.test(n));
    const saved = await Promise.all(names.map(async (file) => {
        const path = join(ARTIFACTS, file);
        const [c, s] = await Promise.all([readFile(path, "utf8").then(JSON.parse), stat(path)]);
        return { file, key: c.key, title: c.meta.title, models: c.models, status: "done", findings: c.review?.findings?.length ?? 0, updatedAt: s.mtimeMs };
    }));
    const live = [...states.values()].filter((st) => st.status !== "done")
        .map((st) => ({ file: null, key: st.key, title: st.meta.title, models: st.models, status: st.status, findings: 0, updatedAt: Date.now() }));
    return [...live, ...saved].sort((a, b) => b.updatedAt - a.updatedAt);
}

async function removeReview(file) {
    if (!SAVED_RE.test(file)) throw new CanvasError("invalid_review", `Unknown review "${file}"`);
    await unlink(join(ARTIFACTS, file));
    for (const [key, st] of states) if (st.status !== "running" && basename(cachePath(st)) === file) states.delete(key);
}

// The stack menu opens a layer with analyze: false, so moving through a stack costs no model calls.
async function openReview({ pr, file, instance, hunkModel, reviewModel, analyze: run = true }) {
    const st = file ? await restore(file) : await load({ pr, hunkModel, reviewModel });
    if (st.status === "idle" && run) analyze(st);
    if (instance) instances.set(instance, st.key);
    return st;
}

const readJson = async (req) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    return JSON.parse(body || "{}");
};

function eligibleHunks(st) {
    const out = [];
    st.files.forEach((f, fi) => {
        if (SKIP_FILES.test(f.path)) return;
        f.hunks.forEach((h, hi) => out.push({ fi, hi }));
    });
    return out;
}
const hunkTargets = (st) => eligibleHunks(st).slice(0, MAX_HUNKS);
const coverage = (st) => ({ hunks: eligibleHunks(st).length, maxHunks: MAX_HUNKS, reviewTruncated: st.diff.length > MAX_REVIEW_DIFF, maxReviewChars: MAX_REVIEW_DIFF });
const count = (lines, c) => lines.filter((l) => l[0] === c).length;
const fileSummary = (f) => {
    const lines = f.hunks.flatMap((h) => h.lines);
    return { path: f.path, hunks: f.hunks.map(({ start, end }) => ({ start, end })), add: count(lines, "+"), del: count(lines, "-") };
};

let session;

async function analyze(st, models) {
    if (st.status === "running") return;
    const selected = { ...st.models, ...Object.fromEntries(Object.entries(models ?? {}).filter(([, v]) => v)) };
    try {
        validateModels(await modelCatalog(), selected);
    } catch (error) {
        st.status = "error";
        st.error = String(error?.message ?? error);
        push(st);
        return;
    }
    if (st.status === "running") return;
    st.models = selected;
    Object.assign(st, { status: "running", error: null, notes: {}, review: null, progress: { done: 0, total: hunkTargets(st).length + 1 } });
    push(st);
    try {
        const run = await session.workflow.run(WORKFLOW, {
            args: { key: st.key },
            limits: { maxConcurrentSubagents: 8 }, // ponytail: queue only, never fails a run
            notifyOnComplete: false,
        });
        if (run.status !== "completed") throw new Error(`analysis ${run.status}: ${JSON.stringify(run.failure ?? run.error ?? "")}`);
        st.status = "done";
        await save(st);
    } catch (e) {
        st.status = "error";
        st.error = String(e?.message ?? e);
    }
    push(st);
}

const analyzeWorkflow = defineWorkflow({
    meta: {
        name: WORKFLOW,
        description: "Internal to the PR Review canvas: explains each diff hunk with a small model and reviews the whole PR with a larger one. args: { key: string }.",
        phases: [{ title: "Analyze" }],
        argsSchema: { type: "object", required: ["key"], properties: { key: { type: "string" } } },
    },
    run: async (ctx) => {
        const st = states.get(ctx.args.key);
        if (!st) throw new Error(`PR ${ctx.args.key} is not loaded in the canvas`);
        const pr = `PR: ${st.meta.title} (${st.key})\n\n${(st.meta.body || "").slice(0, 4000)}`;
        ctx.phase("Analyze");
        const jobs = hunkTargets(st).map(({ fi, hi }) => async () => {
            const f = st.files[fi], h = f.hunks[hi];
            const text = [h.header, ...h.lines].join("\n").slice(0, 8000);
            const r = await ctx.agent(
                `${pr}\n\nExplain this single diff hunk from \`${f.path}\` for a code reviewer. Do not use tools or modify files; answer only from the hunk. ${STE} ${EMPHASIS}\n\n\`\`\`diff\n${text}\n\`\`\``,
                { label: `hunk ${fi}:${hi}`, model: st.models.hunkModel, reasoningEffort: "low", schema: HUNK_SCHEMA },
            );
            if (r) st.notes[`${fi}:${hi}`] = r;
            st.progress.done++;
            push(st);
            return null;
        });
        jobs.push(async () => {
            const diff = st.diff.length > MAX_REVIEW_DIFF ? st.diff.slice(0, MAX_REVIEW_DIFF) + "\n[diff truncated]" : st.diff;
            const r = await ctx.agent(
                [
                    pr,
                    "Review this pull request and report confirmed merge risks. Never modify files, push, or post comments. You may read files in the working directory (if it is this repository) and use read-only `gh` commands for linked issues, review threads, and checks.",
                    "1. Establish the intent: linked issue or spec, then PR description, then commit messages. State it in one sentence and name the source.",
                    "2. Trace the changed behavior beyond the changed lines: callers, callees, types, tests, config, feature flags. Follow old vs new behavior through error paths, boundaries, and concurrency.",
                    "3. Two passes. Behavior and risk: incorrect behavior, broken invariants, security or data loss, material performance regressions, unsafe error/boundary/concurrency paths, missing tests for material behavior. Intent and fit: missing or incorrect requirements, unrequested behavior, violations of documented repository standards or local architecture.",
                    "4. Falsify each finding: look for a caller that prevents it, a test that proves the behavior, a flag or config, or an existing review comment or author reply that resolves it. Drop duplicate, disproved, and unsupported findings.",
                    "5. Keep a finding only with all five: concrete failing scenario, the changed line, impact, evidence, fix direction. Otherwise drop it or make it an open question.",
                    "Severity: blocking = incorrect behavior, security failure, data loss, or severe regression; warning = material risk or important behavior left untested. No informational findings. No style, formatting, import order, or naming nits. No praise. Use new-side line numbers.",
                    STE,
                    EMPHASIS,
                    "```diff\n" + diff + "\n```",
                ].join("\n\n"),
                { label: "review", model: st.models.reviewModel, schema: REVIEW_SCHEMA },
            );
            st.review = r
                ? { ...r, findings: r.findings.map((x) => placeFinding(st.files, x)) }
                : { intent: "", approach: "", bottomLine: "The review model did not return a result.", openQuestions: [], findings: [] };
            st.progress.done++;
            push(st);
            return null;
        });
        await ctx.parallel(jobs);
        return { notes: Object.keys(st.notes).length, findings: st.review?.findings.length ?? 0 };
    },
});

// Line chat: one thread per question anchor; the small model answers by default.
async function ask(st, { thread, fi, line, side, question, model }) {
    question = String(question ?? "").trim();
    if (!question) throw new CanvasError("invalid_question", "Type a question.");
    let t = st.chats.find((c) => c.id === thread);
    const chosen = model || t?.model || st.models.hunkModel;
    validateModels(await modelCatalog(), { ...st.models, hunkModel: chosen });
    if (!t) {
        const f = st.files[fi];
        if (!f || !(line > 0)) throw new CanvasError("invalid_line", "Pick a line in the diff.");
        t = { id: /^[\w-]{1,64}$/.test(thread ?? "") ? thread : randomUUID(), fi, line, side: side === "old" ? "old" : "new", path: f.path, messages: [] };
        st.chats.push(t);
    }
    if (t.status === "running") throw new CanvasError("busy", "Wait for the current answer.");
    t.model = chosen;
    t.messages.push({ role: "user", text: question });
    Object.assign(t, { status: "running", error: null });
    push(st);
    (async () => {
        try {
            const run = await session.workflow.run(ASK_WORKFLOW, { args: { key: st.key, id: t.id }, notifyOnComplete: false });
            if (run.status !== "completed") throw new Error(`question ${run.status}: ${JSON.stringify(run.failure ?? run.error ?? "")}`);
            t.status = "done";
        } catch (e) {
            Object.assign(t, { status: "error", error: String(e?.message ?? e) });
        }
        if (st.status === "done") await save(st).catch(() => {});
        push(st);
    })();
    return t.id;
}

const ANSWER_SCHEMA = { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false };

const askWorkflow = defineWorkflow({
    meta: {
        name: ASK_WORKFLOW,
        description: "Internal to the PR Review canvas: answers a question about one diff line. args: { key: string, id: string }.",
        phases: [{ title: "Answer" }],
        argsSchema: { type: "object", required: ["key", "id"], properties: { key: { type: "string" }, id: { type: "string" } } },
    },
    run: async (ctx) => {
        const st = states.get(ctx.args.key);
        const t = st?.chats.find((c) => c.id === ctx.args.id);
        if (!t) throw new Error(`Question ${ctx.args.id} is not loaded in the canvas`);
        const hunk = (hunkAt(st.files[t.fi], t.line, t.side) ?? "").slice(0, 8000);
        const history = t.messages.map((m) => `${m.role === "user" ? "Reviewer" : "You"}: ${m.text}`).join("\n\n");
        const r = await ctx.agent(
            [
                `PR: ${st.meta.title} (${st.key})`,
                `A code reviewer asks about line ${t.line} (${t.side} side) of \`${t.path}\`. The line is marked with ">>" in the hunk below. Answer the last question briefly and directly. You may read files in the working directory if it is this repository. Do not modify files, push, or post comments.`,
                STE,
                EMPHASIS,
                "```diff\n" + hunk + "\n```",
                history,
            ].join("\n\n"),
            { label: "ask", model: t.model, reasoningEffort: "low", schema: ANSWER_SCHEMA },
        );
        t.messages.push({ role: "assistant", text: r?.answer || "The model did not return an answer." });
        return null;
    },
});

// One shared loopback server; the PR key in the query string selects state.
let baseUrl;
async function ensureServer() {
    if (baseUrl) return baseUrl;
    const MIME = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8" };
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, "http://x");
        const key = url.searchParams.get("key");
        const st = key && states.get(key);
        const json = (status, v) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v));
        try {
            if (url.pathname === "/") {
                res.setHeader("Content-Type", MIME[".html"]);
                return res.end(await readFile(join(HERE, "ui.html")));
            }
            if (url.pathname === "/models.mjs") {
                res.setHeader("Content-Type", "text/javascript");
                return res.end(await readFile(join(HERE, "models.mjs")));
            }
            if (url.pathname === "/api/models") return json(200, { models: await modelCatalog(), defaults: DEFAULT_MODELS });
            if (url.pathname.startsWith("/assets/")) {
                const name = url.pathname.slice(8);
                if (!/^[\w.-]+$/.test(name)) return res.writeHead(400).end();
                res.setHeader("Content-Type", MIME[extname(name)] ?? "application/octet-stream");
                return res.end(await readFile(join(HERE, "assets", name)));
            }
            if (url.pathname === "/api/reviews" && req.method === "GET") return json(200, await listReviews());
            if (url.pathname === "/api/reviews" && req.method === "DELETE") {
                await removeReview(url.searchParams.get("file"));
                return json(200, { ok: true });
            }
            if (url.pathname === "/api/open" && req.method === "POST") {
                try {
                    return json(200, { key: (await openReview(await readJson(req))).key });
                } catch (e) {
                    return json(400, { error: String(e?.message ?? e) });
                }
            }
            if (!st) return json(404, { error: `The review of ${key} is not loaded.` });
            if (url.pathname === "/api/state") {
                res.setHeader("Content-Type", "application/json");
                return res.end(JSON.stringify({ ...annotations(st), diff: st.diff, files: st.files.map(fileSummary), coverage: coverage(st) }));
            }
            if (url.pathname === "/api/events") {
                res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
                res.write(`data: ${JSON.stringify(annotations(st))}\n\n`);
                if (!clients.has(key)) clients.set(key, new Set());
                clients.get(key).add(res);
                req.on("close", () => clients.get(key)?.delete(res));
                return;
            }
            if (url.pathname === "/api/analyze" && req.method === "POST") {
                const models = await readJson(req);
                validateModels(await modelCatalog(), { ...st.models, ...models });
                analyze(st, models);
                return json(200, { ok: true });
            }
            if (url.pathname === "/api/ask" && req.method === "POST") return json(200, { thread: await ask(st, await readJson(req)) });
            if (url.pathname === "/api/ask" && req.method === "DELETE") {
                st.chats = st.chats.filter((c) => c.id !== url.searchParams.get("thread") || c.status === "running");
                if (st.status === "done") await save(st);
                push(st);
                return json(200, { ok: true });
            }
            res.writeHead(404).end();
        } catch (e) {
            json(e instanceof CanvasError ? 400 : 500, { error: String(e?.message ?? e) });
        }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return (baseUrl = `http://127.0.0.1:${server.address().port}`);
}

function stateFor(instanceId) {
    const st = states.get(instances.get(instanceId));
    if (!st) throw new CanvasError("not_open", "No PR is loaded in this canvas. Start a review in the canvas or open it with a PR.");
    return st;
}

const canvas = createCanvas({
    id: "pr-review",
    displayName: "PR Review",
    description: "Review a GitHub PR: diff with file tree on the right, AI hunk explanations and review findings inline on the left.",
    inputSchema: {
        type: "object",
        properties: {
            pr: { type: "string", description: "PR URL or owner/repo#number. Omit to show the saved reviews and a field to start a new review." },
            hunkModel: { type: "string", description: `Small model for per-hunk explanations (default ${DEFAULT_MODELS.hunkModel})` },
            reviewModel: { type: "string", description: `Larger model for the whole-PR review (default ${DEFAULT_MODELS.reviewModel})` },
        },
    },
    actions: [
        {
            name: "analyze",
            description: "Re-run the AI analysis (hunk explanations + full review), optionally with different models.",
            inputSchema: { type: "object", properties: { hunkModel: { type: "string" }, reviewModel: { type: "string" } } },
            handler: (ctx) => {
                const st = stateFor(ctx.instanceId);
                analyze(st, ctx.input ?? {});
                return { started: true, key: st.key, models: st.models };
            },
        },
        {
            name: "get_review",
            description: "Return the current analysis: status, review (intent, findings, open questions, bottom line), and per-hunk explanations.",
            handler: (ctx) => {
                const st = stateFor(ctx.instanceId);
                const notes = Object.entries(st.notes).map(([k, v]) => {
                    const [fi, hi] = k.split(":").map(Number);
                    return { file: st.files[fi]?.path, hunk: st.files[fi]?.hunks[hi]?.header, ...v };
                });
                return { ...annotations(st), notes };
            },
        },
    ],
    open: async (ctx) => {
        const inst = `inst=${encodeURIComponent(ctx.instanceId)}`;
        if (!ctx.input?.pr) return { url: `${await ensureServer()}/?${inst}`, title: "PR Review" };
        const st = await openReview({ ...ctx.input, instance: ctx.instanceId });
        const url = `${await ensureServer()}/?key=${encodeURIComponent(st.key)}&${inst}`;
        return { url, title: `Review ${st.key}`, status: st.status };
    },
    onClose: (ctx) => void instances.delete(ctx.instanceId),
});

session = await joinSession({ canvases: [canvas], workflows: [analyzeWorkflow, askWorkflow] });

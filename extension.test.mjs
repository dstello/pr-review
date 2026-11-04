import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = await readFile(new URL("./extension.mjs", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const state = () => ({
    key: "example/repo#1", repo: "example/repo", num: "1",
    meta: { title: "PR", headRefOid: "head", baseRefName: "main", baseRefOid: "base" },
    models: { hunkModel: "small", reviewModel: "large" },
    diff: "", files: [], notes: {}, review: { findings: [] }, chats: [], status: "done",
});
const context = (extra = {}) => ({
    join, basename, createHash, randomUUID, readFile, writeFile, rename, unlink, mkdir, readdir, stat,
    CanvasError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    states: new Map(), ...extra,
});
function storage(c) {
    runInNewContext(section("// The diff depends", "function annotations(")
        + section("// Saved reviews: one artifact", "async function removeReview(")
        + ";Object.assign(globalThis, { save, cachePath, identity, listReviews, restore });", c);
    return c;
}

test("finding placement prefers exact paths and rejects ambiguous partial paths", () => {
    const c = context();
    runInNewContext(section("function placeFinding(", "// The diff depends") + ";globalThis.placeFinding = placeFinding;", c);
    const files = ["src/a.js", "a.js", "other/a.js"].map(path => ({ path, hunks: [] }));
    assert.equal(c.placeFinding(files, { file: "a.js", line: 1 }).fi, 1);
    assert.equal(c.placeFinding([files[0]], { file: "a.js", line: 1 }).fi, 0);
    assert.equal(c.placeFinding([files[0], files[2]], { file: "a.js", line: 1 }).fi, -1);
});

test("cache identity changes with the base commit and preserves explicit saved paths", async () => {
    const c = storage(context({ ARTIFACTS: "/unused", settle: x => x, parseDiff: () => [] }));
    const st = state(), old = c.cachePath(st);
    st.meta.baseRefOid = "new-base";
    assert.notEqual(c.cachePath(st), old);
    c.readFile = async () => JSON.stringify(state());
    const restored = await c.restore("legacy-v6.json");
    assert.equal(c.cachePath(restored), "/unused/legacy-v6.json");
});

test("restoring a saved review repairs its old file placement", async () => {
    const saved = state();
    saved.review.findings.push({ file: "a.js", line: 1, fi: 0, hi: -1 });
    const c = storage(context({
        ARTIFACTS: "/unused", settle: x => x,
        parseDiff: () => ["src/a.js", "a.js"].map(path => ({ path, hunks: [] })),
        readFile: async () => JSON.stringify(saved),
    }));
    runInNewContext(section("function placeFinding(", "// The diff depends") + ";globalThis.placeFinding = placeFinding;", c);
    const restored = await c.restore("legacy-v6.json");
    assert.equal(restored.review.findings[0].fi, 1);
});

test("a failed save preserves the old file, removes the temporary file, and can retry", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pr-review-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const c = storage(context({ ARTIFACTS: dir }));
    const st = state(), path = c.cachePath(st);
    await c.save(st);
    const previous = await readFile(path, "utf8");
    st.chats.push({ id: "answer", messages: [] });
    c.rename = async () => { throw new Error("Disk failure"); };
    await assert.rejects(c.save(st), /Disk failure/);
    assert.equal(await readFile(path, "utf8"), previous);
    assert.deepEqual(await readdir(dir), [basename(path)]);
    c.rename = rename;
    await c.save(st);
    assert.equal(JSON.parse(await readFile(path, "utf8")).chats.length, 1);
});

test("overlapping saves keep the latest conversation", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pr-review-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let unblock, entered;
    const blocked = new Promise(resolve => { unblock = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let writes = 0;
    const c = storage(context({
        ARTIFACTS: dir,
        writeFile: async (...args) => {
            if (++writes === 1) { entered(); await blocked; }
            return writeFile(...args);
        },
    }));
    const st = state();
    const first = c.save(st);
    await started;
    st.chats.push({ id: "latest" });
    const second = c.save(st);
    await new Promise(setImmediate);
    try { assert.equal(writes, 1); }
    finally { unblock(); }
    await Promise.all([first, second]);
    assert.equal(JSON.parse(await readFile(c.cachePath(st), "utf8")).chats.length, 1);
});

test("loading a PR fetches a fresh diff when only the base commit changes", async () => {
    const st = state();
    let diffs = 0;
    const c = storage(context({
        ARTIFACTS: "/unused", DEFAULT_MODELS: st.models,
        parseRef: () => ({ repo: st.repo, num: st.num, key: st.key }),
        parseDiff: () => [], stackOf: async () => null,
        readFile: async () => { throw Object.assign(new Error("Missing"), { code: "ENOENT" }); },
        gh: async args => {
            if (args[1] === "view") {
                assert.ok(args.at(-1).split(",").includes("baseRefOid"));
                return JSON.stringify({ ...st.meta, baseRefOid: "new-base" });
            }
            diffs++;
            return "fresh diff";
        },
    }));
    c.states.set(st.key, st);
    runInNewContext(section("async function load(", "// Saved reviews:") + ";globalThis.load = load;", c);
    const loaded = await c.load({ pr: st.key });
    assert.notEqual(loaded, st);
    assert.equal(loaded.diff, "fresh diff");
    assert.equal(diffs, 1);
});

test("a damaged saved review does not hide valid reviews", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pr-review-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "bad-v6.json"), "{");
    await writeFile(join(dir, "good-v6.json"), JSON.stringify(state()));
    const c = storage(context({ ARTIFACTS: dir }));
    const list = await c.listReviews();
    assert.equal(list.find(x => x.file === "good-v6.json").title, "PR");
    assert.match(list.find(x => x.file === "bad-v6.json").error, /./);
});

test("a missing review result fails the workflow", async () => {
    const st = { ...state(), review: null, progress: { done: 0 } };
    const c = context({
        defineWorkflow: x => x, WORKFLOW: "test", MAX_REVIEW_DIFF: 150000, STE: "", EMPHASIS: "",
        REVIEW_SCHEMA: {}, hunkTargets: () => [], push: () => {},
    });
    c.states.set(st.key, st);
    runInNewContext(section("const analyzeWorkflow =", "// Line chat:") + ";globalThis.workflow = analyzeWorkflow;", c);
    await assert.rejects(c.workflow.run({
        args: { key: st.key }, phase: () => {}, agent: async () => null,
        parallel: jobs => Promise.all(jobs.map(job => job())),
    }), /did not return a result/);
    assert.equal(st.review, null);
    let saved = false;
    Object.assign(c, {
        modelCatalog: async () => [], validateModels: () => {},
        identity: () => "same", save: async () => { saved = true; },
        session: { workflow: { run: () => c.workflow.run({
            args: { key: st.key }, phase: () => {}, agent: async () => null,
            parallel: jobs => Promise.all(jobs.map(job => job())),
        }) } },
    });
    runInNewContext(section("async function analyze(", "const analyzeWorkflow") + ";globalThis.analyze = analyze;", c);
    await c.analyze(st);
    assert.equal(st.status, "error");
    assert.match(st.error, /did not return a result/);
    assert.equal(saved, false);
});

test("chat save failures stay visible until a successful retry", async () => {
    const st = state(), updates = [];
    const c = context({
        save: async () => { throw new Error("Disk full"); },
        push: st => updates.push(st.saveError),
    });

    runInNewContext(section("async function persistChats(", "const ANSWER_SCHEMA") + ";globalThis.persistChats = persistChats;", c);
    assert.equal(await c.persistChats(st), false);
    assert.match(st.saveError, /Disk full/);
    c.save = async () => {};
    assert.equal(await c.persistChats(st), true);
    assert.equal(st.saveError, null);
    assert.equal(updates.length, 2);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const html = await readFile(new URL("./ui.html", import.meta.url), "utf8");
const section = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));

test("the UI module parses", () => {
    const script = html.split('<script type="module">')[1].split("</script>")[0];
    const result = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: script, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
});

test("renderDiff relies on draw for one syntax highlight pass", () => {
    let passes = 0;
    const c = {
        diffPanes: {}, view: { format: "line-by-line" }, state: { diff: "" },
        $: () => ({ appendChild: el => el }), document: { createElement: () => ({}) },
        wrappers: () => [], applyFiles: () => {},
        Diff2HtmlUI: class {
            draw() { this.highlightCode(); }
            highlightCode() { passes++; }
        },
    };
    runInNewContext(section("function renderDiff()", "function diffstat(") + ";renderDiff();", c);
    assert.equal(passes, 1);
});

test("GitHub links leave sentence punctuation outside the link", () => {
    const c = { key: "example/repo#1" };
    runInNewContext(section("const esc =", "const hunkSummary =") + ";globalThis.md = md;", c);
    for (const suffix of [".", ",", ")", ").", "!"]) {
        assert.match(c.md(`https://github.com/example/repo/pull/42${suffix}`),
            new RegExp(`href="https://github.com/example/repo/pull/42"[^>]*>#42</a>`));
        assert.ok(c.md(`https://github.com/example/repo/pull/42${suffix}`).endsWith(suffix));
    }
    assert.match(c.md("https://github.com/other/repo/issues/42#issuecomment-1"), /href="https:\/\/github.com\/other\/repo\/issues\/42#issuecomment-1"/);
    assert.match(c.md('"https://github.com/example/repo/pull/42"'), /href="https:\/\/github.com\/example\/repo\/pull\/42"/);
    assert.equal(c.md("`#42`"), "<code>#42</code>");
    assert.match(c.md("#42"), /href="https:\/\/github.com\/example\/repo\/issues\/42"/);
    assert.ok(!c.md('<img src=x onerror="bad">').includes("<img"));
});

test("new chats use the review model while the catalog loads", () => {
    const c = {
        $: () => ({ disabled: true, value: "Loading models" }),
        state: { models: { hunkModel: "small" } },
    };
    runInNewContext(section("const chatModel =", "function fillChatModel(") + ";globalThis.chatModel = chatModel;", c);
    assert.equal(c.chatModel(), "small");
});

test("Ask stays disabled until the selected model is available", () => {
    const button = {}, select = { value: "small" }, messages = { innerHTML: "" };
    const el = { querySelector: s => s === "select" ? select : s === ".chat-msgs" ? messages : button };
    const c = { catalog: [], modelLoadError: "", md: x => x, esc: x => x };
    runInNewContext(section("function updateChat(", "function syncChats(") + ";globalThis.updateChat = updateChat;", c);
    const thread = { messages: [], status: "done" };
    c.updateChat(el, thread);
    assert.equal(button.disabled, true);
    c.catalog.push({ id: "small" });
    c.updateChat(el, thread);
    assert.equal(button.disabled, false);
    c.updateChat(el, { ...thread, status: "running" });
    assert.equal(button.disabled, true);
    c.modelLoadError = "Cannot load models";
    c.updateChat(el, thread);
    assert.equal(button.disabled, true);
});

test("Retry save shows errors and clears the warning after success", async () => {
    let handler;
    const c = {
        state: { saveError: "Disk full" }, q: "key=example",
        document: { addEventListener: (type, fn) => { handler = fn; } },
        api: async () => { throw new Error("Still full"); },
        renderReview: () => {}, queueLayout: () => {},
    };
    runInNewContext(section('document.addEventListener("click", async (e) => {', "const sizeVar ="), c);
    const e = { target: { closest: () => ({ disabled: false }) } };
    await handler(e);
    assert.equal(c.state.saveError, "Still full");
    c.api = async (path, init) => { assert.equal(path, "/api/save?key=example"); assert.equal(init.method, "POST"); };
    await handler(e);
    assert.equal(c.state.saveError, null);
});

test("the first chat sync and answer updates preserve both tab controls", () => {
    const threads = [], controls = new Map();
    const finding = { title: "Risk", line: 1 };
    const c = {
        state: { review: { findings: [finding] }, chats: threads },
        findingChats: controls, findingsKey: "", chatEls: new Map(),
        updateChat: (el, t) => { el.thread = t; }, createChat: () => assert.fail("not a line chat"),
        saveFocus: () => null, saveWarning: () => "", reviewCoverage: () => "", hunkCoverage: () => "",
        SEV_ORDER: ["warning"], sevLabel: () => "", md: x => x ?? "", loc: () => "",
        esc: x => x ?? "", $: () => ({}),
        mountFindingChats: () => controls.set("review:0", { thread: { finding: 0 } }),
    };
    runInNewContext(section("function syncChats()", "function openChat(")
        + section("function renderReview()", "// A finding link")
        + ";Object.assign(globalThis, { syncChats, renderReview });", c);
    // Review creates controls before the first layout and before Code mounts.
    c.renderReview();
    c.syncChats();
    assert.equal(controls.size, 1);
    for (const scope of ["review", "code"]) controls.set(`${scope}:0`, { thread: { finding: 0 } });
    c.syncChats();
    assert.equal(controls.size, 2);
    threads.push({ id: "finding-0", finding: 0, status: "done", messages: [{ text: "Answer" }] });
    c.syncChats();
    for (const el of controls.values()) assert.equal(el.thread.messages[0].text, "Answer");
    c.state.review.findings = [{ ...finding, line: 2 }];
    c.syncChats();
    assert.equal(controls.size, 0);
});

test("clicking the trash SVG keeps the menu open for confirmation", async () => {
    const html = await readFile(new URL("./ui.html", import.meta.url), "utf8");
    const handlers = {};
    const menu = { open: true, contains: (target) => target.connected };
    const button = {
        dataset: {},
        set textContent(value) { target.connected = false; },
    };
    const target = {
        connected: true,
        closest: (selector) => selector === ".review-delete" ? button : null,
    };
    const context = {
        $: (id) => id === "reviews" ? menu : {
            addEventListener: (type, fn) => { handlers.list = fn; },
        },
        document: {
            addEventListener: (type, fn) => { handlers[type] = fn; },
        },
    };
    runInNewContext(html.slice(
        html.indexOf('$("review-list").addEventListener("click"'),
        html.indexOf('$("reviews-icon").outerHTML'),
    ), context);
    runInNewContext(html.split("\n").find((line) => line.startsWith('document.addEventListener("click"')), context);
    const event = {
        target,
        composedPath: () => [target, button, menu],
    };
    await handlers.list(event);
    handlers.click(event);
    assert.equal(button.dataset.armed, "1");
    assert.equal(menu.open, true);
});

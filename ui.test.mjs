import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

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

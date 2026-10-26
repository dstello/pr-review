import assert from "node:assert/strict";
import { test } from "node:test";
import { gh } from "./gh.mjs";

test("gh works without Homebrew on PATH and preserves command errors", async () => {
    const original = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
        assert.match(await gh(["--version"]), /^gh version /);
        await assert.rejects(gh(["--not-a-real-flag"]), (error) => {
            assert.notEqual(error.code, "ENOENT");
            assert.match(error.stderr, /unknown flag/);
            return true;
        });
    } finally {
        if (original === undefined) delete process.env.PATH;
        else process.env.PATH = original;
    }
});

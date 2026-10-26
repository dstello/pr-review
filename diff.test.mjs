// node --test ~/.copilot/extensions/pr-review/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff } from "./diff.mjs";

const diff = `diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -1,3 +1,3 @@ fn
 keep
-  x = 1
+    x = 1
-y = 1
+y = 2
@@ -10,2 +10,3 @@
 a
+b
 c
diff --git a/gone.txt b/gone.txt
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye`;

test("parseDiff extracts files and new-side hunk ranges", () => {
    const files = parseDiff(diff);
    assert.deepEqual(files.map((f) => f.path), ["src/a.js", "gone.txt"]);
    assert.deepEqual(files[0].hunks.map((h) => [h.start, h.end]), [[1, 3], [10, 12]]);
    assert.equal(files[1].hunks.length, 1);
});

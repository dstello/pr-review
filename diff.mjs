export function parseDiff(diff) {
    const files = [];
    let f = null, h = null;
    for (const line of diff.split("\n")) {
        if (line.startsWith("diff --git ")) {
            f = { path: line.match(/ b\/(.*)$/)?.[1] ?? line.slice(11), hunks: [] };
            files.push(f);
            h = null;
            continue;
        }
        if (!f) continue;
        if (!h && line.startsWith("+++ ")) {
            if (line !== "+++ /dev/null") f.path = line.replace(/^\+\+\+ (b\/)?/, "");
            continue;
        }
        const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (m) {
            const start = +m[1];
            h = { header: line, start, end: start + Math.max(+(m[2] ?? 1), 1) - 1, lines: [] };
            f.hunks.push(h);
        } else if (h) h.lines.push(line);
    }
    return files;
}

// The hunk that holds `line` on `side` ("old" | "new"), with the target line marked ">>".
export function hunkAt(file, line, side = "new") {
    for (const h of file?.hunks ?? []) {
        const m = h.header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
        let o = +m[1], n = +m[2], hit = false;
        const lines = h.lines.map((l) => {
            const c = l[0];
            const here = side === "old" ? c !== "+" && o === line : c !== "-" && n === line;
            if (c !== "+") o++;
            if (c !== "-") n++;
            if (here && !hit) return (hit = true), ">>" + l;
            return "  " + l;
        });
        if (hit) return [h.header, ...lines].join("\n");
    }
    return null;
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

export async function gh(args) {
    // Desktop apps may not inherit the shell's Homebrew PATH.
    for (const command of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", join(homedir(), ".local/bin/gh")]) {
        try {
            return (await exec(command, args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    throw new Error("GitHub CLI (gh) was not found. Install it, then restart the Copilot app.");
}

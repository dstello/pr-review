import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { availableModels } from "./models.mjs";

export async function modelCatalog() {
    const directories = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin")].filter(Boolean);
    let executable;
    for (const dir of directories) {
        const candidate = join(dir, process.platform === "win32" ? "copilot.exe" : "copilot");
        try {
            await access(candidate, constants.X_OK);
            executable = candidate;
            break;
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
        }
    }
    if (!executable) throw new Error("Copilot CLI was not found. Install it to load available models.");
    // joinSession exposes session RPCs, not the account-wide model catalog.
    const client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: executable }) });
    try {
        await client.start();
        return availableModels(await client.listModels());
    } finally {
        await client.stop();
    }
}

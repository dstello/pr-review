export const DEFAULT_MODELS = { hunkModel: "gpt-6-luna", reviewModel: "claude-opus-5.5" };

export function availableModels(models) {
    return models.filter((m) => m.id !== "auto" && m.policy?.state !== "disabled");
}

export function modelChoices(models, role, selected) {
    const available = availableModels(models);
    const candidates = available.filter((m) => {
        if (m.modelPickerCategory) return role === "hunkModel"
            ? m.modelPickerCategory === "lightweight" : m.modelPickerCategory !== "lightweight";
        // ponytail: name-based grouping only when runtime categories are missing.
        return role === "hunkModel" ? /luna|haiku|mini|flash/i.test(m.id) : /opus|sonnet|sol|codex|pro/i.test(m.id);
    }).slice(0, 5);
    const chosen = available.find((m) => m.id === selected);
    if (chosen && !candidates.some((m) => m.id === selected)) candidates.push(chosen);
    return candidates;
}

export function validateModels(models, selected) {
    const available = availableModels(models);
    for (const role of Object.keys(DEFAULT_MODELS)) {
        if (!available.some((m) => m.id === selected[role])) {
            throw new Error(`${role === "hunkModel" ? "Inline notes" : "Review"} model "${selected[role] ?? ""}" is not available. Choose another model.`);
        }
    }
    return selected;
}

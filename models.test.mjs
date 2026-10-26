import assert from "node:assert/strict";
import { test } from "node:test";
import { availableModels, modelChoices, validateModels } from "./models.mjs";

test("model pickers use runtime categories and preserve unavailable selections", () => {
    const models = [
        { id: "small", modelPickerCategory: "lightweight" },
        { id: "large", modelPickerCategory: "powerful" },
        { id: "blocked", modelPickerCategory: "powerful", policy: { state: "disabled" } },
        { id: "auto" },
        ...Array.from({ length: 8 }, (_, i) => ({ id: `review-${i}`, modelPickerCategory: "versatile" })),
    ];
    assert.deepEqual(availableModels(models).map((m) => m.id).slice(0, 2), ["small", "large"]);
    assert.deepEqual(modelChoices(models, "hunkModel", "").map((m) => m.id), ["small"]);
    assert.equal(modelChoices(models, "reviewModel", "").length, 5);
    assert.equal(modelChoices(models, "reviewModel", "review-7").at(-1).id, "review-7");
    assert.deepEqual(validateModels(models, { hunkModel: "small", reviewModel: "large" }), { hunkModel: "small", reviewModel: "large" });
    assert.throws(() => validateModels(models, { hunkModel: "retired", reviewModel: "large" }), /retired.*not available/);
    assert.throws(() => validateModels(models, { hunkModel: "small", reviewModel: "blocked" }), /blocked.*not available/);
});

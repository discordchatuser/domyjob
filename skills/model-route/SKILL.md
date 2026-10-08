---
name: model-route
description: Classify a task as easy, medium, or hard and recommend the corresponding Codex model when choosing a model or routing work.
---

Choose by reasoning difficulty and uncertainty, rather than task length:

| Tier | Model | Criteria |
| --- | --- | --- |
| easy | `gpt-6-luna` | Clear, bounded work: formatting, extraction, small edits, obvious fixes. |
| medium | `gpt-6.1-sol` | Everyday coding, features, debugging, reviews with several connected decisions. |
| hard | `gpt-6-astra` | Ambiguous requirements, complex architecture, elusive bugs, reasoning across systems. |

Default to medium when uncertain. Respect an explicitly requested model.

Return `Tier: <tier> · Model: <model>` and one sentence explaining the choice.

This recommends a model; it does not switch the current model. For already-authorized delegated work, use the selected model only if the tools support it. Do not spawn agents merely to apply this skill. If the model is unavailable, report that and recommend an available alternative.

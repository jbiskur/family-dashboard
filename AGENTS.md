<!-- klokkan:managed:start -->
## Klokkan time tracking

- For implementation, debugging, review, research, or other substantive work in this repository, start Klokkan as your first action after understanding the task: `"$(git rev-parse --show-toplevel)/.agents/skills/klokkan/scripts/klokkan.sh" --config "$(git rev-parse --show-toplevel)/.agents/skills/klokkan/config.json" start "<concise task description>"`.
- Do not start a timer for a quick clarification, greeting, or status-only answer that requires no repository work.
- If the active task changes materially, run the start command again with the new description; it updates the running timer.
- Before sending the final response for tracked work, stop the timer: `"$(git rev-parse --show-toplevel)/.agents/skills/klokkan/scripts/klokkan.sh" --config "$(git rev-parse --show-toplevel)/.agents/skills/klokkan/config.json" stop`.
- To inspect it, use `"$(git rev-parse --show-toplevel)/.agents/skills/klokkan/scripts/klokkan.sh" --config "$(git rev-parse --show-toplevel)/.agents/skills/klokkan/config.json" status` or `"$(git rev-parse --show-toplevel)/.agents/skills/klokkan/scripts/klokkan.sh" --config "$(git rev-parse --show-toplevel)/.agents/skills/klokkan/config.json" project`.
- The project is resolved from the current git branch through the committed `.klokkan.json` at the repository root. Run `"$(git rev-parse --show-toplevel)/.agents/skills/klokkan/scripts/klokkan.sh" --config "$(git rev-parse --show-toplevel)/.agents/skills/klokkan/config.json" branch` to see which project the current branch resolves to and why.
- To retarget a branch, list the choices with `"$(git rev-parse --show-toplevel)/.agents/skills/klokkan/scripts/klokkan.sh" --config "$(git rev-parse --show-toplevel)/.agents/skills/klokkan/config.json" projects`, then run `"$(git rev-parse --show-toplevel)/.agents/skills/klokkan/scripts/klokkan.sh" --config "$(git rev-parse --show-toplevel)/.agents/skills/klokkan/config.json" map "<branch-or-glob>" --project <full-project-uuid>`. Omit `--project` to pick in the browser. Commit the resulting `.klokkan.json` — that is the point of it, so nobody needs local-only edits.
- Never shorten a project UUID in `.klokkan.json`, and never put a token, API key, or secret in it. It is committed, and the wrapper refuses the whole file if it finds one.
- Authentication is handled by the wrapper through `~/.klokkan/auth.py`; never place tokens or API keys in this repository.
- Do not install or invoke Klokkan through agent lifecycle hooks. If tracking fails, report the error instead of hiding it.
<!-- klokkan:managed:end -->

## Documentation storage

Store and maintain Heima documentation as Usable fragments in the private My Life workspace `f37b9773-0e9f-4ccd-8e85-05c5971af264`, tagged `repo:family-dashboard` and `project:family-dashboard`. Search for and update the existing fragment before creating another. README links to the canonical documents.

Keep only README.md, CHANGELOG.md, AGENTS.md and CLAUDE.md as repository Markdown documentation, including nested agent instructions. Do not add local Markdown architecture notes, runbooks, feature guides or verification reports. Import existing documents and verify their saved content before deleting repository copies. Keep screenshot and machine-readable evidence links working.

# Harness skills: supporting files

A Harness skill (sidebar Skills modal) is plain text, max 8,000 characters, stored in Harness's database. It cannot hold attachments, and it is only used when the user types its slash command. So long reference material lives here, and the skill text tells the agent which files to read.

## Layout
One folder per skill: `skills/<skill-name>/`
- `skill-text.txt`: the exact text pasted into the Skills modal. Keep it under 8,000 characters.
- Other files (guides, examples, templates) the skill text points to.
- `samples/`: personal material. Its contents are gitignored; only `.gitkeep` is tracked.

## Rules for agents
- Always reference supporting files by absolute path in the main checkout (`C:\Users\Joshua\Projects\Agentic Harness\skills\<name>\...`). Worktrees are per-chat copies and gitignored files do not exist in them.
- Edit supporting files in your worktree and land them, but gitignored `samples/` files must be written directly to the main checkout path.
- If you change `skill-text.txt`, tell the user to re-paste it into the Skills modal; you cannot update the database yourself.
- A file marked `STATUS: TEMPLATE` is unfilled. Do not invent content.
- Never commit personal writing; keep it in `samples/`.

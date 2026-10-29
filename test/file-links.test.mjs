import assert from "node:assert/strict";
import test from "node:test";
import { marked } from "marked";
import { agentInstructions } from "../src/core/history.mjs";
import {
  resolveFileLink,
  rewriteHarnessLinks,
} from "../src/ui/file-links.mjs";

const roots = {
  worktree: "C:/wt",
  project: "C:/proj",
  references: [{ name: "near", path: "C:/ref" }, { name: "far", path: "D:/other" }],
};

test("agents link the first mention of a file in each message", () => {
  const instructions = agentInstructions(
    { path: "C:\\repo", repositories: [], scratch: true },
    { id: "chat", scope: "all", provider: "codex" },
  );
  assert.match(instructions, /harness:\/\/file\/relative\/path#L12/);
  assert.match(instructions, /once per document per message/);
  assert.match(instructions, /later mentions in that message stay plain text/);
  assert.match(instructions, /A path inside a code block does not count/);
  assert.match(instructions, /Do not announce the link/);
  assert.match(instructions, /absolute path only for an upstream reference/);
});

test("only an explicit file link is rewritten, once for that mention", () => {
  const html = rewriteHarnessLinks(
    marked.parse(
      [
        "Source [note](harness://conversation/abc#m1).",
        "Open [app.jsx](harness://file/src/ui/app.jsx#L4) and then src/ui/app.jsx again.",
        "Also [notes](harness://file/src/my%20file.mjs).",
        "",
        "```",
        "harness://file/secret.mjs",
        "```",
      ].join("\n"),
      { breaks: true },
    ),
  );
  assert.match(html, /href="\/\?chat=abc#m1"/);
  assert.match(html, /href="\/\?file=src%2Fui%2Fapp\.jsx&line=4"/);
  assert.match(html, /href="\/\?file=src%2Fmy%20file\.mjs"/);
  assert.equal(html.match(/href="\/\?file=/g).length, 2);
  assert.match(html, /and then src\/ui\/app\.jsx again/);
  assert.doesNotMatch(html, /href="[^"]*secret\.mjs"/);
});

test("a file link resolves to the longest matching repository", () => {
  assert.deepEqual(
    resolveFileLink("harness://file/src/ui/app.jsx#L4", roots),
    { repo: "primary", file: "src/ui/app.jsx", line: 4 },
  );
  assert.deepEqual(
    resolveFileLink("c:/WT/src/app.jsx", roots),
    { repo: "primary", file: "src/app.jsx", line: null },
  );
  assert.deepEqual(
    resolveFileLink("C:\\proj\\README.md", roots),
    { repo: "primary", file: "README.md", line: null },
  );
  assert.deepEqual(
    resolveFileLink("D:/other/lib/a.mjs", { ...roots, line: 9 }),
    { repo: "1", file: "lib/a.mjs", line: 9 },
  );
  assert.equal(resolveFileLink("D:/refs/other-more/a.mjs", roots), null);
  assert.equal(resolveFileLink("../secret", roots), null);
  assert.equal(resolveFileLink("C:/somewhere/else.txt", roots), null);
  assert.equal(resolveFileLink("src/app.jsx", { references: [] }), null);
});

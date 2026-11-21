# Reviewable Markdown and WebGAL conversion

Keep a single UTF‑8 `story.md`, usually one level-two heading per scene. Place a scene ID on its own line directly after the heading (blank lines are fine). Start every fragment with a fragment ID on its own line. Use globally unique scene and fragment IDs such as `S001` and `F001`, using at least three decimal digits. Keep IDs on title, content, and same-scene order edits. Assign fresh IDs for new fragments. First resolve copied, missing or ambiguous IDs with the user when the mapping cannot be inferred from the reviewed story and saved baseline.

```markdown
# 車站的燈

## 第一幕 · 候車亭
<!-- scene: S001 -->

<!-- fragment: F001 -->
**對白 · 小禾**　「你還在等車嗎？」

<!-- fragment: F002 -->
**旁白**　雨點落在候車亭的屋頂上。

<!-- fragment: F003 -->
**心聲**　（但願這是同一班車。）

<!-- fragment: F004 -->
**演出**　雨聲漸弱。小禾望向路口。
```

Use readable labels in the author's language for dialogue, narration, thoughts, and staging. Keep messages under a named speaker with a medium marker such as `訊息`. Let the user's Markdown edits stay readable. Use stable IDs to connect each change to a scene, including when the user refers to a quote rather than an ID.

After creative approval and [asset readiness](assets-and-staging.md#asset-readiness-after-script-review), map fragments to complete WebGAL commands, preserving the author's punctuation and voice. Keep timing and effects in staging instructions rather than rewriting the story for engine convenience.

```text
小禾:「你還在等車嗎？」;
say:雨點落在候車亭的屋頂上。 -clear;
say:（但願這是同一班車。） -clear;
```

- Apply `-clear` to nameless lines and verify the transition from a named line in the actual game.
- Give the linear path an explicit entry, scene transitions, and an ending. Check that paths and target commands exist. Treat semicolons and other script syntax inside source dialogue as data. Verify the generated representation with the installed parser and Chrome instead of assuming a universal escape sequence.
- Treat the approved hash as an exact byte snapshot, including line endings. If only formatting changed, demonstrate that the semantic content is unchanged and bind a new byte snapshot to the existing approval. If the equivalence is uncertain or meaning changed, show affected passages for a fresh approval.
- Keep generated script candidates in the private staging area. Fixing a WebGAL conversion or presentation detail after approval must stay within the approved script and authorization, and any changed formal plan requires fresh application approval.

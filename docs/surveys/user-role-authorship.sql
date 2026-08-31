-- Survey backing docs/plans/genuine-prompt-filtering.md
--
-- Question: of everything carrying `role: "user"` in the opencode transcript,
-- how much was actually typed by a human?
--
-- Run against the live opencode store (read-only):
--   sqlite3 ~/.local/share/opencode/opencode.db < docs/surveys/user-role-authorship.sql
--
-- The LEFT JOIN is load-bearing: an inner join silently drops parts whose
-- session is absent from `session_v2`, which is where the `unknown` parentage
-- bucket comes from (8.2% of the corpus when this was run, 2026-08).

SELECT
  CASE
    WHEN s.id IS NULL       THEN 'unknown-parentage'
    WHEN s.parent_id IS NULL THEN 'root'
    ELSE 'child'
  END AS parentage,
  CASE
    WHEN json_extract(p.data, '$.ignored')   = 1 THEN 'ignored'
    WHEN json_extract(p.data, '$.synthetic') = 1 THEN 'synthetic'
    ELSE 'clean'
  END AS flags,
  COUNT(*) AS parts
FROM part p
JOIN message m     ON m.id = p.message_id
LEFT JOIN session_v2 s ON s.id = p.session_id
WHERE json_extract(m.data, '$.role') = 'user'
  AND json_extract(p.data, '$.type') = 'text'
GROUP BY 1, 2
ORDER BY 3 DESC;

-- Result, 2026-08 (17,054 user-role text parts):
--   root  | clean     | 8651   <- human-typed, 50.7%
--   child | clean     | 6282   <- agent-authored delegated prompts, 36.8%
--   unknown-parentage | clean     | 1372   <- 8.0%
--   root  | ignored   |  537   <- TUI plugin status blocks, 3.1%
--   root  | synthetic |   94
--   child | synthetic |   86
--   unknown-parentage | synthetic |   32

-- Companion: what the non-clean buckets actually contain.
-- SELECT substr(replace(json_extract(p.data,'$.text'), char(10), ' '), 1, 110), COUNT(*)
-- FROM part p JOIN message m ON m.id = p.message_id
-- WHERE json_extract(m.data,'$.role') = 'user' AND json_extract(p.data,'$.synthetic') = 1
-- GROUP BY substr(json_extract(p.data,'$.text'), 1, 40) ORDER BY 2 DESC LIMIT 10;

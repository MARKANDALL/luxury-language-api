You are performing monthly hygiene on the Lux Pronunciation Tool BACKEND (luxury-language-api). Focus: cleanup candidates and slow-moving structural concerns.

SCOPE: Skip _ARCHIVE/, node_modules/, .vercel/, any underscore-prefixed folder.

CRITICAL DETECTION RULE — READ BEFORE CHECK 1:
The backend .gitignore lists `*.GOLD` as ignored. Any scan using `git ls-files`, `git grep`, or git-based file enumeration WILL NOT SEE .GOLD files even when they exist on disk. For Check 1 you MUST use filesystem enumeration (`find . -name '*.GOLD*'` or recursive directory walk) — NOT git commands.

CHECKS:

1. .GOLD BACKUP CLEANUP CANDIDATES
   Filesystem enumeration (not git) for every file matching `.GOLD` or `.GOLD.<number>`.
   For each: full path, file size in KB, date last modified, age in days.
   Flag any older than 60 days as strong cleanup candidates.
   As of 2026-04-15, known .GOLD.2 files: routes/attempt.js, routes/migrate.js, routes/pronunciation-gpt.js, routes/update-attempt.js, routes/user-recent.js. Report the count delta vs the prior monthly run if a prior report exists in kodama-reports/backend-monthly/.
   Self-check: did you use filesystem enumeration? If you only checked tracked files, rerun — you missed gitignored backups.

2. UNUSED DEPENDENCIES
   Read package.json. For each entry in dependencies/devDependencies, grep the repo for import/require referencing that package.
   DO NOT flag as unused:
   - Any package starting with @types/
   - Any package in vercel.json or package.json scripts
   - Core tooling: any @vercel/* package
   Self-check per candidate: grep vercel.json and scripts again — build/deploy tools appear only in config.

3. STALE BRANCHES (informational) — List branches with no commits in 60+ days. Never flag main, master, or any branch referenced in open PRs.

4. ENV VAR DRIFT — Compare process.env.X references in code against .env.example. Report entries in code but missing from example, and entries in example unused in code. If .env.example does not exist, report that.

5. README ACCURACY — Verify README.md Setup/Getting Started/Development section commands exist in package.json scripts or are valid standalone. Flag only if a user following the README would actually error.

OUTPUT:
- Create kodama-reports/backend-monthly/YYYY-MM.md
- Draft PR titled "Backend monthly hygiene sweep — Month YYYY"
- Summary comment on GitHub issue titled "Backend Monthly Hygiene Tracker" (create if missing)

REPORT STRUCTURE:
# Backend Monthly Hygiene Sweep — Month YYYY

## Summary
- .GOLD files: [X] total, [Y] older than 60 days (delta from prior: [+N / -N / no change / first run])
- Unused dependency candidates: [X]
- Stale branches: [X]
- Env var drift: [X] missing from .env.example, [Y] unused in code
- README mismatches: [X]

## Findings
[Per check]

## Notes
[Observations]

RULES:
- Report only. Never delete anything.
- False positives worse than silence — say "✅ Nothing to clean up" freely.
- Self-check every finding.
- Be exact with paths, line numbers, counts.

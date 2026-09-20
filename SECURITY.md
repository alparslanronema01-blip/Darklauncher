# Vulnerability reporting

Found a security issue (e.g. token leakage, path traversal in the mod
manager, IPC escalation)? Please do **not** open a public issue.

Use GitHub's **"Report a vulnerability"** button on the Security tab of this
repository, or open a draft security advisory. You'll get a reply within a
few days.

Scope notes:

- Accounts are stored locally (`appdata/` in dev, OS user-data when packaged).
  The logger masks JWTs/tokens before anything touches disk — reports around
  secret handling are very welcome.
- The CurseForge API key lives in local settings only and is never sent
  anywhere except `api.curseforge.com`.
- Mod/shader installs verify sha1 checksums; path-traversal protection exists
  on every delete/remove IPC (`mods:remove`, `shaders:remove`, `bg:delete`).

# Releasing

TorrentFlow uses semantic versions and `v<major>.<minor>.<patch>` Git tags.

1. Start from an up-to-date release branch with a clean worktree.
2. Choose the SemVer increment and run
   `npm version <major|minor|patch> --no-git-tag-version`. Commit both
   `package.json` and `package-lock.json`.
3. Review additive Prisma migrations and complete every gate in
   [CONTRIBUTING.md](../CONTRIBUTING.md). The default release gate excludes
   live indexer tests and must not perform real downloads.
4. Merge the reviewed version change.
5. From the exact merged commit, create an annotated tag:
   `git tag -a vX.Y.Z -m "TorrentFlow vX.Y.Z"`.
6. Push that tag and create the matching GitHub Release with concise user-facing
   changes and migration notes.

Never move or reuse a published version tag. If a release is faulty, fix it in a
new patch release.

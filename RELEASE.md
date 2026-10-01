# Releasing stride-pi

Releasing this extension happens entirely inside this repository: bump the
version, write the changelog entry, tag, and publish a GitHub release. Read
the "what a release does for users" note below before treating the tag as a
delivery mechanism — here it is a record.

## The three facts

**Where the version lives.** The root `package.json` (`"version"`). The two
nested manifests, `extensions/hook-bridge/package.json` and
`extensions/subagent-dispatch/package.json`, carry their own version that
releases have never bumped — leave them alone unless you mean to start
versioning those packages separately. No test checks the root version against
the changelog.

**Changelog shape — two shapes on the record.**

- **Through 1.17.0:** work commits appended under `## [Unreleased]`, and the
  release commit renamed that heading to `## [X.Y.Z] - YYYY-MM-DD` and bumped
  `package.json`.
- **From 1.18.0 on:** work commits leave `CHANGELOG.md` and `package.json`
  alone; the release commit writes the whole entry and bumps the version, and
  touches nothing else.

There is no `[Unreleased]` heading now, so the file is set up for the second
shape. Work landed since the last tag has no entry yet — the release commit
writes it.

**Catalog: none.** This extension is not listed in any marketplace or catalog
repository, so there is nothing to sync. Users install with the `install.sh`
one-liner in the README, which clones the default branch (`main`) rather than
a tag. Two consequences worth knowing:

- Users receive whatever is on `main` once it is pushed, released or not. The
  push is the delivery; the tag and GitHub release record what a version
  contained.
- So run the gate before pushing `main`, not just before tagging.

## Before you write the entry: is the top heading already tagged?

A tagged heading describes something that already shipped. Adding entries
under it rewrites that record — the lite ports did exactly this once and had
to move the entries to a new heading. Check first:

```bash
git tag -l "v$(awk -F'[][]' '/^## \[[0-9]/{print $2; exit}' CHANGELOG.md)"
```

Any output means the top version heading is already released: open a new
heading. No output means it has not been tagged yet. The "Release record"
section near the top of the changelog is not a version heading and is
skipped.

## Steps

1. Run the gate. The root `npm test` covers the hook bridge only, so run the
   subagent-dispatch tests as well:

   ```bash
   npm test
   (cd extensions/subagent-dispatch && node --test *.test.ts)
   ```

2. Run the top-heading check, then write the `## [X.Y.Z] - YYYY-MM-DD` entry
   covering every commit since the last tag
   (`git log --oneline "$(git describe --tags --abbrev=0)"..HEAD`) and set
   `"version"` in the root `package.json`. Match the existing entries:
   `### Added — <what changed> (Wnnnn)` with a prose paragraph.

3. Commit those two files on `main` (recent releases use
   `Release X.Y.Z - <summary>`) and push:

   ```bash
   git push origin main
   ```

4. Tag the release commit with an annotated tag and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

5. Publish the GitHub release from the changelog entry:

   ```bash
   gh release create vX.Y.Z --repo cheezy/stride-pi --notes-file <notes.md>
   ```

6. Confirm the tag and the release exist:

   ```bash
   git tag -l "v$(awk -F'[][]' '/^## \[[0-9]/{print $2; exit}' CHANGELOG.md)"
   gh release view vX.Y.Z --repo cheezy/stride-pi
   ```

## Known gaps on the record

- Three early tags have no GitHub release; that is accepted and recorded in
  the changelog's "Release record" section. Do not backfill.
- Not every older tag sits on the commit that bumped the version (the 1.8.0
  and 1.15.0 tags point at other commits). Releases from 1.16.0 on are annotated tags on
  the release commit itself; keep it that way.
- Whether Pi has its own package-install route for this repository is not
  documented here; the README's `install.sh` is the supported path.

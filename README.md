---
last_updated: 2026-10-20T11-25
---

# Inline commands

Use /name or /skill:name anywhere in interactive editor input to include a skill. Autocomplete includes enabled and disabled skills. Native commands and unknown names remain unchanged.

Use periods to browse a skill's directories and Markdown files, such as /ai-to-leader.references.help.md. Selecting a file includes that file instead of the whole skill. Exact skill and native command tokens receive separate colors.

The extension decorates the current editor, including taller-editor, instead of replacing its behavior. Regression tests create isolated skill fixtures and need no personal Pi configuration.

## Install from GitHub

This is a private personal extension. Git needs access to giladbarnea/inline-commands. It does not publish to npm.

```sh
pi install git:github.com/giladbarnea/inline-commands
```

The unpinned source follows the default branch when you run `pi update --extensions`. Add `@v0.1.0` to pin a release. Run `/reload` after changing the install.

## Develop and release

Use Node.js 24 or newer.

```sh
npm ci --ignore-scripts
npm run setup
npm run check
npm run release -- patch
git push origin main --follow-tags
```

The pre-push hook runs the checks. GitHub checks main, pull requests, and version tags. A passing version tag creates a GitHub release with generated notes. The tag must match package.json. No workflow publishes to npm or GitHub Packages, and package.json sets `private: true`.

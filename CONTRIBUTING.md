# Contributing to GitCharm

Thanks for your interest. Bug reports, ideas and pull requests are welcome.

- **Questions and ideas:** [Discussions](https://github.com/nbigot/gitcharm/discussions)
- **Bugs:** [Issues](https://github.com/nbigot/gitcharm/issues), using the bug report form
- **Security problems:** see [SECURITY.md](SECURITY.md), never a public issue

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need Node.js 24 and Git.

```bash
npm install          # also installs the commit-msg hook
npm run build        # bundle with esbuild (npm run watch to rebuild on change)
npm run typecheck
npm test             # unit tests + git integration tests on temp repos
npm run test:e2e     # runs the extension inside VS Code on a temp repo
npm run package      # builds gitcharm.vsix
```

Press F5 in VS Code to start an Extension Development Host with your changes.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
The release version and the release notes are computed from them, so the type
matters:

| Type | Example | Release |
| --- | --- | --- |
| `fix` | `fix(log): keep selection after refresh` | patch (1.2.3 → 1.2.4) |
| `feat` | `feat(commit): add Amend shortcut` | minor (1.2.3 → 1.3.0) |
| `feat!` or a `BREAKING CHANGE:` footer | `feat!: drop VS Code 1.95 support` | major (1.2.3 → 2.0.0) |
| `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `style` | `docs: explain settings` | none |

A `commit-msg` hook checks the format locally, and CI checks it again on pull
requests.

## Pull requests

- Keep each pull request to one change, and add tests where it makes sense.
- `npm run typecheck` and `npm test` must pass.
- Describe what changed and how you tested it.

## Releases

Releases are fully automated. Every push to `main` runs
[semantic-release](https://github.com/semantic-release/semantic-release),
which:

1. works out the next version from the commits since the last tag,
2. updates `CHANGELOG.md` and the version in `package.json`,
3. builds the `.vsix`,
4. commits those files as `chore(release): X.Y.Z [skip ci]`, tags `vX.Y.Z`,
5. publishes a GitHub Release with the notes and the `.vsix` attached.

Versions are always plain `X.Y.Z` (no `-beta` suffix), the only format the
VS Code Marketplace accepts.

Note for maintainers: the release job pushes a commit to `main`. If branch
protection is turned on for `main`, the release job needs a token or GitHub
App that is allowed to bypass it.

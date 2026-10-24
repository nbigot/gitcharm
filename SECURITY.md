# Security policy

## Supported versions

Only the latest release of GitCharm receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report them privately through GitHub instead: open the
[Security tab](https://github.com/nbigot/gitcharm/security) and click
**Report a vulnerability**. Include the GitCharm, VS Code, Git and OS versions,
and the steps or repository setup needed to reproduce it.

You can expect a first reply within 7 days. Once a fix is released, the
advisory is published and you are credited unless you prefer otherwise.

## Scope

GitCharm runs the `git` command line on the repositories you open and shows
their content (commit messages, branch names, file names) in webviews. Issues
of particular interest:

- Git commands run from an untrusted workspace (GitCharm is disabled in
  Restricted Mode).
- Repository content that is executed or interpreted as HTML or script in a
  webview.
- Branch names, refs or paths that are turned into Git options.

export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    // Release commits carry the full release notes in their body.
    (message) => message.startsWith('chore(release):'),
    // Dependabot bodies contain long lines (links, tables) that would fail the length rules.
    (message) => message.includes('Signed-off-by: dependabot[bot]'),
  ],
};

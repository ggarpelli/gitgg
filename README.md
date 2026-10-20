<p align="center">
  <img src="https://raw.githubusercontent.com/ggarpelli/gitgg/master/images/banner.png" alt="Gitgg Banner">
</p>

<p align="center">
    <a href="https://marketplace.visualstudio.com/items?itemName=ggarpelli.GuilhermeGarpelli">
        <img src="https://img.shields.io/visual-studio-marketplace/v/ggarpelli.GuilhermeGarpelli?style=for-the-badge&logo=visualstudiocode&label=VS%20Marketplace&color=blue" alt="Version">
    </a>
    <a href="https://marketplace.visualstudio.com/items?itemName=ggarpelli.GuilhermeGarpelli">
        <img src="https://img.shields.io/visual-studio-marketplace/i/ggarpelli.GuilhermeGarpelli?style=for-the-badge&color=green" alt="Installs">
    </a>
    <a href="https://marketplace.visualstudio.com/items?itemName=ggarpelli.GuilhermeGarpelli&ssr=false#review-details">
        <img src="https://img.shields.io/visual-studio-marketplace/r/ggarpelli.GuilhermeGarpelli?style=for-the-badge&color=purple" alt="Rating">
    </a>
</p>

# Gitgg – Compare Branches & Files

Know exactly what is changing before you promote, merge, or deploy. **Gitgg** compares files and folders in your current Git repository with another branch or commit, right inside VS Code. It can also bring selected versions into your working branch and stage them.

Gitgg works within one repository; it does not compare separate repositories. It is especially useful for Salesforce DX teams, release managers, and developers reviewing changes across environment branches.

## Who is Gitgg for?

- “Does my branch match UAT before promotion?”
- “What has changed since the last release?”
- “I only want to bring a few files from develop into my branch.”

Select a file, a group of files, or a folder to compare with a branch. Use release drift detection to check changes since a commit, or PR Comparison to validate a promotion against an environment branch.

## ✨ Features

### 🔎 Compare with another branch
Right-click a file, several files, a folder or an SCM change group and choose **Compare with another branch...** (or press `Ctrl+Alt+\` / `Cmd+Alt+\`).

-   Lists local branches and branches that only exist on `origin`, with ⭐ favorites listed first.
-   Compares against the latest `origin/<branch>` (fetched automatically, configurable) and falls back to the local branch.
-   Up to 5 files (configurable): choose between **separate diff tabs** or a **single view**. More files always open the single view.
-   In a diff tab, the title bar shows the same actions as the single view (only when they apply; hover for a description): **Use compared version**, **Stage**, **Unstage**, **Revert** and **Restore Changes**.
-   Your side is always the file on disk; when it has uncommitted changes it is labeled `(working tree)`.

### 📊 Single-view report
A webview with a summary and the files grouped as Added, Changed, Deleted and Unchanged, with inline diffs that follow your VS Code theme.

-   **Use `<branch>`** / **Use all from `<branch>`**: replaces your file with the version from the compared branch (or deletes it, if it does not exist there) and stages it. **Restore Changes** undoes it while VS Code is open (backups are shared between the single view and diff tabs).
-   **Stage / Unstage**: shown only when the file has unstaged (or staged) changes; stages the file exactly as it is on disk.
-   **Revert**: shown only when the file differs from your current branch (local edits or after **Use `<branch>`**). After confirmation it puts the file back as it is in your branch (HEAD), dropping staged and unstaged changes. **Restore Changes** brings them back while VS Code is open (backups are shared between the single view and diff tabs).
-   **View full Diff**: opens VS Code's diff editor with syntax highlighting.
-   **Search** (`Ctrl+F`): filter thousands of files by name or folder, e.g. `AccountService` or `lwc/payment`.
-   Built for big comparisons: files are listed 200 at a time, unchanged files are collapsed, and bulk actions run as a few batched Git commands with a progress indicator. Hover any button to see what it does.
-   **Always know what is happening**: long actions show the current step, a progress bar and the elapsed time; when they finish, a banner shows the result with an **Undo** button and the changed rows are highlighted. Errors show **Details** and are logged in the **Gitgg** output channel.

### 🎯 Release Drift Detection
Pick a commit (from a branch, by SHA or from your ⭐ favorite hashes) and see whether every file it touched still matches your working tree. Handles merge commits, root commits and renames. Use **Use `<sha>`** to bring the version from that commit.

### ✅ PR Comparison
Before promoting code, validate it against the target environment:

1.  Your current branch is the promotion branch (its working tree is used).
2.  Choose the **destination** branch (where the PR goes): defines which files are in the PR.
3.  Choose the **environment** branch (source of truth, e.g. UAT): each file is compared with it.

Files are classified as `IDENTICAL`, `DIFFERENT`, `MISSING_IN_ENVIRONMENT` or `MISSING_IN_PROMOTION`. A Markdown report grouped by Salesforce component type (Apex classes, triggers, flows, LWC, Aura, objects, fields, layouts, profiles...) can be saved with the **Save Report** button in the panel: you choose where, and it reflects the current state of the comparison (including files you changed with **Use `<environment>`**). Nothing is written to your repository unless you save it.

### 📦 Export PR Snapshot
Writes both versions of every file changed between your branch and a target branch into a `snapshot/` folder (configurable), preserving the original folder structure, plus a `SNAPSHOT_SUMMARY.md`. Handy for code reviews and deployments.

The folder is replaced on each export, but Gitgg only deletes a folder it created itself (marked with a `.gitgg-snapshot` file). If a folder with that name already exists, you are asked first. Consider adding it to your `.gitignore`.

## 🎬 See Gitgg in Action

### Right-click a file and compare branches
Right-click a file and choose **Compare with another branch...** to inspect the file versions side by side.

![Animation showing single file comparison](https://raw.githubusercontent.com/ggarpelli/gitgg/master/images/demo1.gif)

### Compare an LWC folder and apply branch changes
Select the `lwc` folder to compare its files with another branch, apply the branch versions in bulk, and restore the previous state.

![Animation showing multi-file comparison](https://raw.githubusercontent.com/ggarpelli/gitgg/master/images/demo2.gif)

### Compare PR changes and start a report export
Run **Compare PR Changes...**, select the destination and environment branches, review the results, and choose **Save Report** to start exporting the comparison.

![Animation showing PR comparison and starting report export](https://raw.githubusercontent.com/ggarpelli/gitgg/master/images/demo3.gif)

## ⌨️ Shortcuts

| Shortcut | Where |
| --- | --- |
| `Ctrl+Alt+\` (`Cmd+Alt+\` on macOS) | Editor, Explorer and Source Control |
| `Shift+\` | Explorer and Source Control only (not in the editor, where it types `\|`) |

All commands are also available in the Command Palette under the **Gitgg** category.

## ⚙️ Extension Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gitgg.fetchBeforeCompare` | `true` | Fetch the branch from `origin` before comparing. |
| `gitgg.separateTabsMaxFiles` | `5` | Up to this many files, ask between separate tabs and a single view. |
| `gitgg.diffLineLimit` | `100` | Diff lines rendered inline per file in the single view. |
| `gitgg.snapshotFolder` | `snapshot` | Folder used by **Export PR Snapshot**. |

## ✅ Requirements

-   Git 2.26 or later must be installed and available in your system's PATH.
-   You must be working inside a project with an initialized Git repository.

## 🛠️ Development

```bash
npm install
npm test          # unit tests (including tests against a temporary Git repository)
npm run lint
npm run compile   # production bundle in dist/
```

Press `F5` in VS Code to launch an Extension Development Host.

## Release History

For a detailed list of all changes, please see the [CHANGELOG.md](CHANGELOG.md) file.

---

**Enjoy!**

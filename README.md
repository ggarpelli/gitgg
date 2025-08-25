# Gitgg: Simplified Branch Comparison

Gitgg is an essential tool for developers who need to quickly and intuitively compare files across different Git branches, all within Visual Studio Code.

With just a single command, you can select a branch and view the exact differences between your local file and the version on the target branch, without needing complex terminal commands.

## Features

- **File Comparison:** Select any file in the Explorer, the Source Control view (SCM), or the editor tab, and compare it with any other branch in your repository.
- **"Working Tree" Detection:** When comparing a file with its own branch, if there are unsaved local changes, the extension will display the "Working Tree" label to indicate that the comparison is against the current working state. This prevents confusion and ensures you are always aware of uncommitted changes.
- **Quick Access:** Use the right-click context menu on files and folders to start the comparison, or use the keyboard shortcut `Shift + \` for even faster access.

### Demo

![](shortcut.png)

> Replace the empty link above with an image or GIF (like a .gif file) showing the extension in action. A GIF is highly recommended to demonstrate the workflow.

## Requirements

To use this extension, you must have:

- Git installed and configured on your system.
- A project with an initialized Git repository.

## Extension Settings

This extension does not add any customizable settings.

## Known Issues

Currently, the extension supports comparing only one file at a time. The functionality for comparing multiple files is being improved for future versions.

## Release Notes

### 0.0.1

- Initial release of Gitgg.
- Functionality for comparing a single file between Git branches.
- Quick access via context menu and `Shift + \` keyboard shortcut.
- Automatic "Working Tree" detection for local changes.

---

## For more information

- [Visual Studio Code's Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)
- [Git Documentation](https://git-scm.com/doc)

**Enjoy!**
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

# Gitgg: Simplified Git Branch Comparison

Tired of complex commands just to see the difference between file versions on other branches? **Gitgg** is your essential tool for a quick and intuitive comparison experience, directly inside VS Code.

With just a couple of clicks, you can select files—or even entire folders—and instantly diff them against any local branch in your repository.

## ✨ Features

-   **🔎 Flexible Comparison**: Instantly compare a single file, multiple files, or entire folders against any branch. The extension handles it all seamlessly.

-   **🧠 Smart Workflow**: To optimize your experience, Gitgg only asks for your preference (separate tabs vs. single view) when comparing a small number of files (2-5). For larger comparisons, it automatically opens the powerful single view report to prevent workspace clutter.

-   **🌳 "Working Tree" Awareness**: When comparing against the current branch, Gitgg intelligently detects uncommitted changes (including deletions) and labels your version as the `(Working Tree)`, so you always know what you're looking at.

-   **🚀 Quick & Easy Access**: No need to leave your editor. Access the compare feature directly from the right-click context menu in the File Explorer. For even faster access, use the unified `Shift + \` keyboard shortcut for any context.

-   **📊 Modern Multi-File Report**: When comparing multiple files or folders, Gitgg presents a clean Webview report with a high-level summary and categorized file lists (Added, Changed, Deleted), making it easy to review large changes at a glance.

## 🎬 Demo in Action

### Comparing a Single File
Quickly see the changes between your current file and its version on another branch.

![Animation showing single file comparison](https://raw.githubusercontent.com/ggarpelli/gitgg/master/images/demo1.gif)

### Comparing Multiple Files
Select several files at once and compare them simultaneously—ideal for reviewing bigger changes.

![Animation showing multi-file comparison](https://raw.githubusercontent.com/ggarpelli/gitgg/master/images/demo2.gif)

### Quick Access Shortcut
Use the context menu or the `Shift + \` shortcut to start a comparison instantly.

![](https://raw.githubusercontent.com/ggarpelli/gitgg/master/images/shortcut.png)


## ✅ Requirements

-   Git must be installed and available in your system's PATH.
-   You must be working inside a project with an initialized Git repository.

## ⚙️ Extension Settings

This extension does not add any customizable settings.

## Release History

For a detailed list of all changes, please see the [CHANGELOG.md](CHANGELOG.md) file.

---

**Enjoy!**
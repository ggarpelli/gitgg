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

Tired of complex commands just to see the difference between file versions on other branches? **Gitgg** is your essential tool for a quick and intuitive file comparison experience, directly inside VS Code.

With just a couple of clicks, you can select one or more files and instantly diff them against any local branch in your repository.

## ✨ Features

-   **🔎 Flexible File Comparison**: Instantly compare a single file or a selection of multiple files against any branch. The extension handles it all seamlessly.

-   **🌳 "Working Tree" Awareness**: When comparing a file against its own branch, Gitgg intelligently detects uncommitted changes and labels your version as the `(Working Tree)`, so you always know what you're looking at.

-   **🚀 Quick & Easy Access**: No need to leave your editor. Access the compare feature directly from the right-click context menu in the File Explorer or on the editor tab. For even faster access, use the `Shift + \` keyboard shortcut.

## 🎬 Demo in Action

### Comparing a Single File
Quickly see the changes between your current file and its version on another branch.

![Animation showing single file comparison](https://raw.githubusercontent.com/ggarpelli/gitgg/master/images/demo1.gif)

### Comparing Multiple Files
Select several files at once and compare them simultaneously—ideal for reviewing bigger changes.

![Animation showing multi-file comparison](https://raw.githubusercontent.com/ggarpelli/gitgg/master/images/demo2.gif)

### Quick Access Shortcut
Use the context menu or the `Shift + \` shortcut to start a comparison instantly.

![](images/shortcut.png)


## ✅ Requirements

-   Git must be installed and configured on your system.
-   You must be working inside a project with an initialized Git repository.

## ⚙️ Extension Settings

This extension does not add any customizable settings.

## 릴 Release Notes

### 0.0.3
- **NEW:** Added functionality to compare multiple files between branches simultaneously.
- Improved the logic for detecting selected files from different contexts within VS Code (Explorer, SCM, active editor).
- Optimized the process for checking and fetching remote branches.

### 0.0.1
- Initial release of Gitgg.
- Functionality for comparing a single file between Git branches.
- Quick access via context menu and `Shift + \` keyboard shortcut.
- Automatic "Working Tree" detection for local changes.

---

**Enjoy!**
# Gitgg Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- 🚀 Add the ability to stage or revert changes for each file directly from the multi-file comparison view.

### Fixed
- 🐛 Fixed a visual bug in the multi-file report where line numbers would overlap the code during horizontal scrolling.

---

## [0.1.3] - 2025-10-03

### Added
- ✨ Add the ability to favorite branches (⭐️) for quicker access in the selection list.

---

## [0.1.2] - 2025-10-01

### Added
- 📂 **Folder Comparison**: You can now select and compare entire folders. The extension will find all files within them and show a complete diff report.

### Changed
- 🎨 **Complete Webview Overhaul**: The multi-file comparison report has been redesigned for clarity and better organization.
- 📊 **Comparison Summary**: The report now starts with a high-level summary showing the total number of added, changed, and deleted files.
- 🗂️ **Categorized File Lists**: Files are now grouped by their status (Added, Changed, Deleted, Unchanged) to make reviewing changes easier.
- ⚙️ **Enhanced Workspace Detection**: Improved logic for finding the Git repository, adding better support for multi-root workspaces.
- 🧠 **Smarter Multi-File Handling**: The extension now provides a more intelligent workflow. It will only ask for your preference (separate tabs vs. single view) when comparing 2-5 files. For 6 or more files, it automatically opens the single view report to optimize performance and usability.
- 🏗️ **Professional Code Refactoring**: The extension's internal structure has been completely reorganized for better performance and maintainability. The Webview's HTML, CSS, and JavaScript are now separated into dedicated files, following VS Code best practices.

### Fixed
- 🐛 **Correct Diff for Deleted Files**: Fixed a major bug where comparing a single deleted file would show an incorrect diff. It now correctly shows the file's previous content against a deleted state.
- 🏷️ **Accurate 'Working Tree' Label**: The `(Working Tree)` label now correctly appears when comparing against the current branch if a selected file has been changed or deleted locally.

---

## [0.1.0] - 2025-09-28

### Changed
- **🎨 Webview Report Enhancements**: Files in the multi-file Webview are now ordered as ADDED → CHANGED → UNCHANGED. UNCHANGED files stay at the bottom with a gray badge; added/removed badges use green/red colors for clarity. Single-file comparisons now show the filename in the panel title.

- **⚡ Improved Multi-File Comparison UI**: Only changed files display added/removed line badges. Helper functions were added for calculating line changes and extracting filenames to clean up Webview rendering.

- **🖌️ Visual Improvements**: Badge styling improved for added (green), removed (red), and unchanged (gray) files.

---

## [0.0.10] - 2025-09-27

### Added
- **✨ Single-Page Webview Report (Multi-File Comparison)**: Added the ability to compare multiple files at once within a single, dedicated Webview panel in VS Code.

- **🔍 Cohesive Diff Rendering**: Utilizes the diff2html library to display Git patches in a clean, visually appealing format fully integrated with the current VS Code theme.

- **🖱️ Quick Diff Access**: Each changed file includes a "View full Diff" button, enabling users to instantly open the native VS Code diff for that specific file.

- **⚙️ Untracked File Support**: New files are properly handled by generating diffs against /dev/null, ensuring they appear correctly in the report.

### Changed
- **🎨 Smart Display Logic**: The extension now prompts the user, when selecting more than one file, whether they want to compare them in "Separate Tabs" (separate native comparisons) or in a "Single View" (the new Webview report).

- **⚙️ Enhanced File Selection**: The logic for extracting file URIs from the VS Code arguments was completely reworked to remove duplicates and be more robust, ensuring correct counting (single vs. multi-file) in all contexts (Explorer, Editor, etc.).

- **⚙️Optimized "Working Tree" Logic**: The "Working Tree" label is now applied if there are modified or untracked (not_added) files among the selected ones, ensuring new files are correctly identified as local changes.

---

## [0.0.9] - 2025-09-02

### Changed
- Improved `README.md` to link to the Marketplace's Changelog tab instead of the raw file.

---

## [0.0.8] - 2025-09-02

### Changed
- **🐛 Fetch Reliability**: Reworked the remote branch fetch logic to be more efficient and to explicitly warn the user if the fetch fails, preventing comparisons against outdated local branches.

### Fixed
- **📦 Packaging**: Implemented a `files` whitelist in `package.json` to definitively control package contents and ensure a small file size.
- **📦 Dependencies**: Moved all dependencies to `devDependencies` as is standard for bundled extensions, finalizing the package optimization.

---

## [0.0.7] - 2025-09-01

### Added
- ✨ **Multi-File Comparison**: Implemented the core functionality to select and compare multiple files between branches simultaneously.
- 🎨 **Smart Display Logic**: The extension now uses the native VS Code diff view for single-file comparisons and a custom webview report for multi-file comparisons.
- 🔔 **Progress Notifications**: Added UI feedback for long-running Git operations, improving user experience on large repositories.

### Changed
- 🚀 **Major Performance Overhaul**: Implemented Webpack to bundle the extension, drastically reducing the package size from ~15MB to under 1MB for faster downloads and installation.
- ⚙️ **Enhanced "Working Tree" Logic**: Restored and improved the logic to correctly label locally modified files in both single and multi-file comparison views.

### Fixed
- 🐛 **Stability and Reliability**: Corrected numerous activation, dependency, and packaging bugs that occurred after installation.

---

## [0.0.2] - 2025-08-26

### Changed
- 🎨 Updated the extension logo and fixed minor visual details.

---

## [0.0.1] - 2025-08-25

### Added
- 🎉 Initial release of Gitgg.
- Functionality for comparing a single file between Git branches.
- Automatic "Working Tree" detection for local changes.
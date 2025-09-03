# Gitgg Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- ✨ Add the ability to favorite branches (⭐️) for quicker access in the selection list.
- ✨ Implement a single-page webview report for multi-file comparisons.

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
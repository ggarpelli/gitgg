# Gitgg Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.1.5] - 2026-05-18

### Added
- 🎯 **Release Drift Detection**: New command to detect and visualize changes between current branch and any other commit/branch
- 🔍 **Interactive Branch/Commit Selection**: Easy-to-use UI to select target branch or enter commit SHA manually
- 📊 **Drift Visualization**: View detailed file changes in a dedicated Webview panel with staging capabilities
- 🚀 **Quick Access**: Available via Command Palette as "Gitgg: Release Drift Detection..."

### Changed
- 📦 **Package Updates**: Updated dependencies and added new command to package.json
- ⌨️ **Command Registration**: Added new command to extension activation events and command palette

---

## [0.1.4] - 2026-05-15

### Added
- 🔄 **Dynamic Global Action Buttons**: Smart button display that adapts to your Git state - Stage All, Unstage All, Revert All, and Restore All Changes
- 💾 **File Revert with Backup**: Revert individual or all files with automatic backup - restore them anytime before closing the panel
- 🎨 **Consistent Button Styling**: All action buttons now share the same visual style for a cohesive experience
- ⌨️ **Keyboard Shortcut**: `Shift + \` shortcut now works across Editor, Explorer, and Source Control contexts

### Changed
- 📝 **Improved Revert Logic**: "Revert All" now only reverts non-staged files, preserving your staged changes
- 🎯 **Button Ordering**: Global buttons now appear in logical order: Stage All → Unstage All → Revert All
- 📋 **Enhanced README**: Updated documentation with new features and release notes

### Fixed
- 🐛 **File Classification**: Fixed file state detection to properly track files after revert operations
- 🐛 **Restore Functionality**: Fixed backup/restore system to properly recover reverted files

---

---

## [0.1.4] - 2026-05-14

### Added
- 🔒 **Webview Security**: Nonce dinâmico gerado por requisição no `getWebviewContent()`, eliminando o nonce fixo inseguro
- 📦 **diff2html Bundled**: O diff2html agora é instalado localmente e empacotado via webpack (`target: 'web'`), eliminando dependência de CDN externa
- 🧹 **Limpeza de Arquivos Temporários**: Temp files agora são rastreados e removidos automaticamente ao fechar difffs, painéis ou ao desativar a extensão
- 🎯 **Stage/Stage/Stage/Stage/Revert na Webview**: Botões "Stage" e "Revert" em cada arquivo no relatório multi-arquivo, permitindo staging/reversão direta da interface
- 🔧 **QuickPick Dispose**: Corrigido vazamento de memória — QuickPick agora é descartado corretamente ao fechar
- ✅ **GitHub Actions CI/CD**: Workflow automatizado com build, lint, testes e publicação automática no Marketplace via tags
- 🧪 **Infraestrutura de Testes**: Scripts `npm test` e `npm run compile` configurados

### Changed
- 📝 **ESLint Expandido**: Novas regras (`no-explicit-any`, `no-floating-promises`, `no-unused-vars`) para maior qualidade de código
- 🏷️ **Tipos Melhorados**: Uso de `unknown` em vez de `any` em funções como `extractUris` e handlers de erro
- 📦 **Dependências Corrigidas**: `simple-git` movido de `devDependencies` para `dependencies` (era usado em runtime)
- 🎨 **Webview Template Limpo**: Removidos links CDN, CSP agora usa apenas `webview.cspSource` e nonce dinâmico

### Fixed
- 🐛 **Typos Corrigidos**: `Preparing` (estava `Preparing`), `workspace` (estava `workspace` com 'c'), e diversos erros de sintaxe em `extension.ts`

---

## [0.1.3] - 2025-10-03

### Added
- 🚀 Add the ability to favorite branches (⭐️) for quicker access in the selection list.

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

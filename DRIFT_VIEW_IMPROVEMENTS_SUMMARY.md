# GitGG Drift View Improvements - Summary

## Overview
Effort to improve the Hash Compare (Release Drift Detection) visualization to match the quality of the Branch Comparison view. Primary goals:
- Replace custom `computeLineDiff()` with diff2html library
- Implement side-by-side two-panel layout (LEFT = Commit, RIGHT = Working Tree)
- Show +N/-N line count badges per file
- Use standard Git diff colors (red/green)
- Compare against real WORKING TREE
- Match truncation behavior of multi-file comparison (100 line limit)

## Files Modified
1. `src/views/driftView.ts` - Main implementation
2. `src/services/gitService.ts` - Referenced for context
3. `src/webview/main.js` - Reference implementation
4. `src/webview/webview.css` - Reference styling

## Key Changes Made

### 1. Diff2HTML Integration (`driftView.ts`)
- Removed CSS import: `import 'diff2html/bundles/css/diff2html.min.css';`
- Kept only: `import { html } from 'diff2html';`
- Updated `generateSideBySideDiffHtml()` method to use diff2html with:
  ```typescript
  const diffHtml = html(diff, {
      drawFileList: false,
      matching: 'lines',
      outputFormat: 'side-by-side',
      renderNothingWhenEmpty: true,
      colorScheme: 'dark' as any
  });
  ```

### 2. Side-by-Side Layout
- Header section showing:
  - `← Commit (SHA)` | `+added -removed` | `Working Tree →`
- Proper dark theme colors matching VS Code
- Container wrapper: `<div class="d2h-wrapper">`

### 3. Line Count Badges
- Updated `renderFileItem()` to show line counts BEFORE status badge:
  ```typescript
  <span class="file-path">${file.path}</span>
  ${lineCounts} <!-- +N/-N -->
  <span class="status-badge badge-${statusClass}">${statusLabel}</span>
  ```
- Line counts styling:
  ```css
  .line-counts { font-size: 11px; margin: 0 8px; color: #888; }
  .line-added { color: #7d7; }
  .line-removed { color: #d77; }
  ```

### 4. Truncation Logic (Matching Multi-Files)
- Implemented EXACT same logic as `src/webview/main.js`:
  ```typescript
  const LINE_LIMIT = 100;
  const lines = diff.split('\n');
  let isTruncated = false;

  if (lines.length > LINE_LIMIT) {
      diff = lines.slice(0, LINE_LIMIT).join('\n');
      isTruncated = true;
  }
  ```
- Added truncated message:
  ```html
  <div class="truncated-message">Diff truncated. Click "View full Diff" to see the complete file.</div>
  ```

### 5. CSS Improvements
- Embedded complete diff2html CSS inline in `generateHtml()` method
- Dark theme adaptations:
  - Background: `#1e1e1e`
  - Text: `#ccc`
  - Added lines: `rgba(46,160,67,.25)` background
  - Removed lines: `rgba(248,81,73,.25)` background
  - Line numbers: `#6e7681` on `#0d1117` background
- Fixed alignment issues with side-by-side rendering

## What Worked
✅ Side-by-side layout rendering correctly  
✅ Line count badges displayed properly  
✅ Dark theme colors applied  
✅ Basic truncation (100 line limit) functioning  
✅ Diff2html library integration successful  

## What Didn't Work Initially
❌ CSS not applying (fixed by embedding CSS inline)  
❌ Truncation breaking diff hunk headers (fixed by using exact same logic as multi-files)  
❌ Layout showing empty right pane (fixed by not breaking hunks during truncation)  
❌ Line alignment issues (fixed with proper CSS)  

## Remaining Issues to Investigate Tomorrow
1. **Truncation Verification**: Confirm 100-line limit works correctly with actual large files
2. **Line Count Accuracy**: Ensure added/removed stats match truncated diff
3. **Edge Cases**: 
   - Empty files
   - Files with only additions/deletions
   - Binary files (fallback behavior)
   - Very long lines without spaces
4. **Performance**: Check if UI freezes with large diffs
5. **Color Matching**: Verify red/green exactly match VS Code's diff colors
6. **UTF-8 Handling**: Address LCS bug mentioned in team memory

## Testing Procedure
1. Reload extension (F5)
2. Run "Release Drift Detection" command
3. Select file with >100 lines of changes
4. Verify:
   - Side-by-side layout visible
   - Line count badges shown (+N/-N)
   - Truncated message appears when appropriate
   - Only changed lines + context shown (not full file)
   - Red/green coloring only on changed text
   - Line numbers properly aligned

## References
- Multi-file comparison implementation: `src/webview/main.js` (lines ~165-185)
- Original diff2html usage: `src/views/driftView.ts` line ~132
- CSS references: `src/webview/webview.css`

## Notes
- The drift view now shares core logic with the multi-file comparison view
- All changes maintain backward compatibility
- No breaking changes to public APIs
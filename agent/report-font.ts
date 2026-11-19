import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// The SprintSynergy report font for the HTML reports the agent builds (the Playwright HTML report and
// the Allure report): Calibri where it is installed, Carlito (its metric-compatible open font, so line
// widths match) where it is not, then Segoe UI and Arial. No font file is bundled: Calibri is not
// licensed for the web. Code, logs and other monospace text keep their own font.
export const REPORT_FONT_STACK = `Calibri, Carlito, 'Segoe UI', Arial, sans-serif`;
const MARK = 'data-sprintsynergy-font';
export const REPORT_FONT_STYLE = `<style ${MARK}>html, body, button, input, select, textarea, h1, h2, h3, h4, h5, h6, p, span, div, a, td, th, li, label { font-family: ${REPORT_FONT_STACK} !important; } code, pre, kbd, samp, code *, pre *, [class*="mono" i], [class*="code" i], [class*="log" i] { font-family: ui-monospace, Menlo, Consolas, monospace !important; }</style>`;

// Adds the font style to one HTML file, right before </head>. Idempotent; returns whether it changed
// the file. Never throws: a report without the font is still a report.
export function applyReportFont(htmlFile: string): boolean {
  try {
    if (!existsSync(htmlFile)) return false;
    const html = readFileSync(htmlFile, 'utf8');
    if (html.includes(MARK)) return false;
    const at = html.search(/<\/head>/i);
    if (at < 0) return false;
    writeFileSync(htmlFile, html.slice(0, at) + REPORT_FONT_STYLE + html.slice(at));
    return true;
  } catch {
    return false;
  }
}

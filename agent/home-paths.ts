// Replaces a home folder in error text with ~/ so a user name never reaches summary.json or the UI:
// /Users/<name>/ (macOS, also /private/Users), /home/<name>/ (Linux) and C:\Users\<name>\ (Windows,
// either slash, any drive letter; Windows user names may contain spaces).
export function redactHomeFolders(text: string): string {
  return text
    .replace(/(?:\/private)?\/(?:Users|home)\/[^/\s]+\//g, '~/')
    .replace(/\b[A-Za-z]:[\\/]Users[\\/][^\\/:\r\n"'`]+[\\/]/gi, '~/');
}

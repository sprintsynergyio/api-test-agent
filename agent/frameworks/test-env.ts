// Environment for the test runner child process (Playwright or Mocha). The tests get the auth value
// they need from .env through the ctx file; the model provider keys must never reach them (rule 6).
export function testEnv(inputFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, INPUT_FILE: inputFile };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  return env;
}

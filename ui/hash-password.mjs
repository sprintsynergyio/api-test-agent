// Prints a bcrypt hash for UI_USERS. Usage: npm run ui:hash -- <password>
// Put the output in .env as UI_USERS=name:<hash>. The password itself is never stored.
import { createRequire } from "node:module";

const bcrypt = createRequire(import.meta.url)("bcryptjs");
const password = process.argv[2];
if (!password || password.length < 8) {
  console.error("Usage: npm run ui:hash -- <password>   (at least 8 characters)");
  process.exit(1);
}
console.log(bcrypt.hashSync(password, 10));

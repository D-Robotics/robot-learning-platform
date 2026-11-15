import { main } from '../mcp/bundle.mjs';
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

import { main } from './deployment-preflight.cli';

main().catch((error: unknown) => {
  console.error(
    `Deployment preflight failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
});

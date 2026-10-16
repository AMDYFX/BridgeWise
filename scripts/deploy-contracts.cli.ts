import { main } from './deploy-contracts';

main().catch((error: unknown) => {
  console.error(
    `Deployment failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
});

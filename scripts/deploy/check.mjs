import { loadDeployment, validateDeployment } from './config.mjs';
try {
  const { backend, frontend } = await loadDeployment();
  const problems = validateDeployment(backend, frontend);
  if (problems.length) { process.stderr.write(`Deployment is not ready:\n${problems.map(value => `- ${value}`).join('\n')}\n`); process.exitCode = 1; }
  else process.stdout.write('Deployment environment checks passed. Secrets were not printed. Run smoke.mjs after deploying.\n');
} catch (error) { process.stderr.write(`Cannot read deployment environment files (${error.code || 'INVALID_ENV'}). Pass backend and frontend env file paths.\n`); process.exitCode = 1; }

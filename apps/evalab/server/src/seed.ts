import { createContext, closeContext } from './context.js';
import { seedDemo } from './demoSeed.js';

const ctx = await createContext();
try {
  if (ctx.config.nodeEnv === 'production') throw new Error('seed command refused in production');
  await seedDemo(ctx);
  console.log(JSON.stringify({ component: 'seed', event: 'completed' }));
} finally {
  await closeContext(ctx);
}

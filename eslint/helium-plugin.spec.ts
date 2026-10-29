import path from 'node:path';
import { RuleTester, type Rule } from 'eslint';
import { describe, it } from 'vitest';
import helium from './helium-plugin.js';

// Run RuleTester cases as Vitest tests.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const SRC = path.resolve(import.meta.dirname, '..', 'src');
const at = (file: string): string => path.join(SRC, ...file.split('/'));

const rule = helium.rules?.['module-boundaries'] as Rule.RuleModule;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } });

tester.run('helium/module-boundaries', rule, {
  valid: [
    // Inside one module, anything goes.
    { filename: at('modules/orders/orders.service.ts'), code: "import { x } from './orders.repository.js';" },
    { filename: at('modules/orders/sub/a.ts'), code: "import { x } from '../shared/b.js';" },
    // Another module only through its index.
    { filename: at('modules/orders/orders.service.ts'), code: "import { x } from '../payments/index.js';" },
    { filename: at('modules/orders/sub/a.ts'), code: "import { x } from '../../payments/index.js';" },
    { filename: at('modules/orders/a.ts'), code: "export * from '../payments/index.js';" },
    { filename: at('modules/orders/a.ts'), code: "const m = import('../payments/index.js');" },
    // Modules may use config, common and infrastructure.
    { filename: at('modules/orders/a.ts'), code: "import { x } from '../../common/errors/app-error.js';" },
    { filename: at('modules/orders/a.ts'), code: "import { x } from '../../infrastructure/database/db.js';" },
    { filename: at('modules/orders/a.ts'), code: "import { x } from '../../config/app.config.js';" },
    // Lower layers.
    { filename: at('infrastructure/database/db.ts'), code: "import { x } from '../../common/x.js';" },
    { filename: at('infrastructure/database/db.ts'), code: "import { x } from '../../config/db.config.js';" },
    { filename: at('infrastructure/database/db.ts'), code: "import { x } from '../redis/redis.js';" },
    { filename: at('common/errors/a.ts'), code: "import { x } from '../../config/app.config.js';" },
    { filename: at('config/a.ts'), code: "import { x } from './b.js';" },
    { filename: at('lambdas/webhook.ts'), code: "import { x } from '../common/utils/hmac.js';" },
    {
      filename: at('migrations/0001-a.ts'),
      code: "import { x } from '../infrastructure/migrations/index.js';",
    },
    // Root files compose everything.
    { filename: at('main.ts'), code: "import { x } from './modules/orders/orders.service.js';" },
    { filename: at('app.module.ts'), code: "import { x } from './infrastructure/health/health.module.js';" },
    // Package imports and files outside src/ are not checked.
    { filename: at('common/a.ts'), code: "import { Injectable } from '@nestjs/common';" },
    {
      filename: path.resolve(SRC, '..', 'test', 'a.ts'),
      code: "import { x } from '../src/modules/orders/internal.js';",
    },
  ],
  invalid: [
    {
      filename: at('modules/orders/orders.service.ts'),
      code: "import { x } from '../payments/payments.service.js';",
      errors: [{ messageId: 'deepImport' }],
    },
    {
      filename: at('modules/orders/a.ts'),
      code: "export { x } from '../payments/internal/y.js';",
      errors: [{ messageId: 'deepImport' }],
    },
    {
      filename: at('modules/orders/a.ts'),
      code: "const m = import('../payments/y.js');",
      errors: [{ messageId: 'deepImport' }],
    },
    {
      filename: at('modules/orders/a.ts'),
      code: "import { AppModule } from '../../app.module.js';",
      errors: [{ messageId: 'layer' }],
    },
    {
      filename: at('common/a.ts'),
      code: "import { x } from '../modules/orders/index.js';",
      errors: [{ messageId: 'layer' }],
    },
    {
      filename: at('common/a.ts'),
      code: "import { x } from '../infrastructure/database/db.js';",
      errors: [{ messageId: 'layer' }],
    },
    {
      filename: at('infrastructure/database/db.ts'),
      code: "import { x } from '../../modules/orders/index.js';",
      errors: [{ messageId: 'layer' }],
    },
    {
      filename: at('config/a.ts'),
      code: "import { x } from '../common/x.js';",
      errors: [{ messageId: 'layer' }],
    },
    {
      filename: at('lambdas/webhook.ts'),
      code: "import { x } from '../infrastructure/queue/sqs.js';",
      errors: [{ messageId: 'layer' }],
    },
    {
      filename: at('lambdas/webhook.ts'),
      code: "import { x } from '../modules/messaging/index.js';",
      errors: [{ messageId: 'layer' }],
    },
    {
      filename: at('common/a.ts'),
      code: "import { x } from '../main.js';",
      errors: [{ messageId: 'layer' }],
    },
    {
      filename: at('migrations/0002-b.ts'),
      code: "import { CampaignSchema } from '../modules/messaging/index.js';",
      errors: [{ messageId: 'layer' }],
    },
  ],
});

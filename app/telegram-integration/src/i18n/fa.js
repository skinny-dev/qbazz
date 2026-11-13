import { common } from './fa/common.js';
import { discovery } from './fa/discovery.js';
import { cart } from './fa/cart.js';
import { onboarding } from './fa/onboarding.js';
import { seller } from './fa/seller.js';
import { admin } from './fa/admin.js';
import { channel } from './fa/channel.js';
import { router } from './fa/router.js';

/** The bot's Persian strings, one file per area of the product. */
export const fa = { ...common, ...discovery, ...cart, ...onboarding, ...seller, ...admin, ...channel, ...router };

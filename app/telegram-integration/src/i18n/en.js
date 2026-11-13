import { common } from './en/common.js';
import { discovery } from './en/discovery.js';
import { cart } from './en/cart.js';
import { onboarding } from './en/onboarding.js';
import { seller } from './en/seller.js';
import { admin } from './en/admin.js';
import { channel } from './en/channel.js';
import { router } from './en/router.js';

/** The bot's English strings, one file per area of the product. */
export const en = { ...common, ...discovery, ...cart, ...onboarding, ...seller, ...admin, ...channel, ...router };

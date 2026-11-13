/**
 * Boot-time setup that must hold true on every start, not just the first.
 *
 * Platform staff are declared in config (`QBAZZ_ADMIN_TELEGRAM_IDS`,
 * `QBAZZ_ADMIN_EMAILS`) and reconciled here. A Telegram admin gets an account
 * before they have ever opened the bot, so anything addressed to admins —
 * shops waiting for review, quality flags — is already queued for them when
 * they press Start.
 */
export async function bootstrapAdmins(ctx) {
  const { config, services, log } = ctx;
  const granted = [];

  for (const externalId of config.platform.adminTelegramIds) {
    const id = String(externalId).trim();
    if (!id) continue;
    const { account } = await services.accounts.resolveChannelIdentity({
      channel: 'telegram',
      externalId: id,
      profile: { displayName: `Platform admin ${id.slice(-4)}` },
    });
    if (account.role !== 'admin') {
      await services.accounts.setRole(account.id, 'admin');
      granted.push(`telegram:${id}`);
    }
  }

  for (const email of config.platform.adminEmails) {
    const address = String(email).trim().toLowerCase();
    if (!address) continue;
    const existing = await services.accounts.findByIdentity('email', address);
    // Only promote an account that exists — never mint a passwordless one that
    // someone could later claim by registering that address.
    if (existing && existing.role !== 'admin') {
      await services.accounts.setRole(existing.id, 'admin');
      granted.push(`email:${address}`);
    }
  }

  // A phone admin signs in with the SMS code like anyone; the account is made ahead of time so the first sign-in already has the role.
  for (const entry of config.platform.adminPhones || []) {
    const [rawPhone, ...nameParts] = String(entry).split('=');
    const name = nameParts.join('=').trim();
    if (!rawPhone.trim()) continue;
    let account;
    try {
      account = await services.accounts.findOrCreateByPhone(rawPhone.trim());
    } catch (err) {
      log.warn(`QBAZZ_ADMIN_PHONES: ${rawPhone.trim()} skipped (${err.message})`);
      continue;
    }
    const patch = {};
    if (name && account.displayName !== name) patch.displayName = name;
    if (Object.keys(patch).length) await services.accounts.update(account.id, patch);
    if (account.role !== 'admin') {
      await services.accounts.setRole(account.id, 'admin');
      granted.push(`phone:${rawPhone.trim()}`);
    }
  }

  if (granted.length) log.info(`granted admin to ${granted.join(', ')}`);
  return granted;
}

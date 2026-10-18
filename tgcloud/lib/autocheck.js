import { AUTO_CHECK_INTERVAL, PLATFORM_MONITORING } from './config.js';
import { checkAll } from './monitor.js';
import * as store from './accounts.js';
import { getState, setState } from './state.js';
import { nowSecs } from './util.js';

/**
 * This platform has no timer, so monitoring is driven by activity: every
 * message and every button tap re-runs the check, at most once per
 * AUTO_CHECK_INTERVAL. Returns true when a check was actually started.
 */
export async function autoCheck() {
  if (!PLATFORM_MONITORING) return false;
  try {
    const last = Number(await getState('last_auto_check', 0)) || 0;
    if (nowSecs() - last < AUTO_CHECK_INTERVAL) return false;

    const total = await store.countAccounts();
    if (!total) return false;

    // Claim the slot first so parallel invocations don't all start a check.
    await setState('last_auto_check', nowSecs());
    await checkAll({ manual: false });
    return true;
  } catch (error) {
    console.error('auto check failed', error);
    return false;
  }
}

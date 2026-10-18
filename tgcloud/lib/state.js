import { db } from 'sdk';
import { eq } from 'sdk/db';
import { state } from '../schema.js';

export async function getState(key, fallback = null) {
  const row = await db.select().from(state).where(eq(state.key, key)).get();
  if (!row || row.value == null) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export async function setState(key, value) {
  const encoded = JSON.stringify(value);
  await db
    .insert(state)
    .values({ key, value: encoded })
    .onConflictDoUpdate({ target: state.key, set: { value: encoded } })
    .run();
}

export async function clearState(key) {
  await db.delete(state).where(eq(state.key, key)).run();
}

export async function getPending() {
  return getState('pending', null);
}

export async function setPending(pending) {
  if (!pending) return clearState('pending');
  return setState('pending', pending);
}

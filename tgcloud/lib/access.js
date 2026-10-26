// Access control: who may use the bot, and who may change things.
//
// The owner (OWNER_CHAT_ID in config) is always a full admin. LIMITED_CHAT_IDS
// are read-only viewers defined in config. Everyone else must be added to the
// `authorized_chats` table by an admin from the 👥 Users screen; a row's
// `isAdmin` flag decides whether that chat may manage accounts and users.

import { db } from 'sdk';
import { asc, eq } from 'sdk/db';
import { authorizedChats } from '../schema.js';
import { LIMITED_CHAT_IDS, OWNER_CHAT_ID } from './config.js';

const toId = (chatId) => Number(chatId);

export function isOwner(chatId) {
  return toId(chatId) === OWNER_CHAT_ID;
}

export async function getAuthorized(chatId) {
  return db
    .select()
    .from(authorizedChats)
    .where(eq(authorizedChats.chatId, toId(chatId)))
    .get();
}

export async function isAuthorized(chatId) {
  const id = toId(chatId);
  if (id === OWNER_CHAT_ID) return true;
  if (LIMITED_CHAT_IDS.map(Number).includes(id)) return true;
  return Boolean(await getAuthorized(id));
}

export async function isAdmin(chatId) {
  const id = toId(chatId);
  if (id === OWNER_CHAT_ID) return true;
  const row = await getAuthorized(id);
  return Boolean(row?.isAdmin);
}

/**
 * Every chat that may talk to the bot, owner first. Config-only viewers are
 * included (marked `fixed`) so an admin can promote them; they are not stored
 * until promoted, so they cannot be removed from here.
 */
export async function listAuthorized() {
  const rows = await db
    .select()
    .from(authorizedChats)
    .orderBy(asc(authorizedChats.addedAt))
    .all();

  const byId = new Map(rows.map((row) => [toId(row.chatId), { ...row, chatId: toId(row.chatId) }]));
  for (const id of LIMITED_CHAT_IDS) {
    const num = toId(id);
    if (!byId.has(num)) byId.set(num, { chatId: num, isAdmin: false, fixed: true });
  }

  const others = [...byId.values()].sort((a, b) => a.chatId - b.chatId);
  return [{ chatId: OWNER_CHAT_ID, isAdmin: true, owner: true }, ...others];
}

/** Adds a chat, or updates its admin flag if it already exists. */
export async function addAuthorized(chatId, isAdminFlag = false) {
  const id = toId(chatId);
  if (id === OWNER_CHAT_ID) return id;
  await db
    .insert(authorizedChats)
    .values({ chatId: id, isAdmin: Boolean(isAdminFlag) })
    .onConflictDoUpdate({ target: authorizedChats.chatId, set: { isAdmin: Boolean(isAdminFlag) } })
    .run();
  return id;
}

export async function removeAuthorized(chatId) {
  const id = toId(chatId);
  if (id === OWNER_CHAT_ID) return;
  if (LIMITED_CHAT_IDS.map(Number).includes(id)) return; // config viewers stay
  await db.delete(authorizedChats).where(eq(authorizedChats.chatId, id)).run();
}

/** Every chat that should receive videos: owner, config viewers and DB chats. */
export async function listRecipientChatIds() {
  const ids = new Set([OWNER_CHAT_ID, ...LIMITED_CHAT_IDS.map(Number)]);
  const rows = await db.select({ chatId: authorizedChats.chatId }).from(authorizedChats).all();
  for (const row of rows) ids.add(toId(row.chatId));
  return [...ids];
}

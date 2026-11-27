import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { CONVERSATION_COOKIE_NAME } from "@/core/session";

/**
 * Главная страница стенда — точка входа жюри.
 *
 * Без cookie доступа отправляем на `/access`, с cookie — на `/start`:
 * жюри попадает сразу на экран с тремя вкладками, не ища адрес вручную.
 */
export default async function RootPage() {
  const cookieStore = await cookies();
  const hasAccess = cookieStore.has("support_access");
  const hasConversation = cookieStore.has(CONVERSATION_COOKIE_NAME);
  redirect(hasAccess || hasConversation ? "/start" : "/access");
}

import { api, unwrap } from '@/api';

/** Copies text through the main process, which works even without document focus. */
export async function copyText(text: string): Promise<void> {
  await unwrap(api().app.copyText(text));
}

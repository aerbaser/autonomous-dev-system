import { api, ApiError } from '$lib/api';
import type { AccountListItem } from '$lib/types';

interface AccountState {
  accounts: AccountListItem[];
  loading: boolean;
  error: string | null;
}

// Reactive state using Svelte 5 $state rune
let state = $state<AccountState>({
  accounts: [],
  loading: false,
  error: null,
});

export function getAccountState() {
  return state;
}

export async function loadAccounts(): Promise<void> {
  state.loading = true;
  state.error = null;
  try {
    state.accounts = await api.get<AccountListItem[]>('/api/accounts');
  } catch (err) {
    if (err instanceof ApiError) {
      state.error = err.message;
    } else {
      state.error = String(err);
    }
  } finally {
    state.loading = false;
  }
}

export function clearAccounts(): void {
  state.accounts = [];
  state.error = null;
}

export function hasAccount(): boolean {
  return state.accounts.length > 0;
}

<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { api, ApiError } from '$lib/api';
  import type { AccountListItem } from '$lib/types';
  import LoadingSpinner from '$lib/components/LoadingSpinner.svelte';

  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const accounts = await api.get<AccountListItem[]>('/api/accounts');
      if (accounts.length === 0) {
        goto('/setup');
      } else {
        goto('/inbox');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // No accounts endpoint yet — treat as empty
        goto('/setup');
      } else {
        // Backend is not running or unexpected error
        error = err instanceof Error ? err.message : String(err);
      }
    }
  });
</script>

<div class="flex min-h-screen flex-col items-center justify-center gap-4 bg-white dark:bg-gray-950">
  {#if error}
    <div class="text-center px-4">
      <p class="text-red-600 dark:text-red-400 text-sm mb-2">Could not connect to backend</p>
      <p class="text-gray-500 dark:text-gray-400 text-xs max-w-xs">{error}</p>
      <button
        class="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 transition-colors"
        onclick={() => { error = null; location.reload(); }}
      >
        Retry
      </button>
    </div>
  {:else}
    <LoadingSpinner size="lg" />
    <p class="text-sm text-gray-500 dark:text-gray-400">Loading...</p>
  {/if}
</div>

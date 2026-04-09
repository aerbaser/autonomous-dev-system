<script lang="ts">
  import { getToasts, removeToast } from '$lib/stores/toast.svelte';

  const toasts = $derived(getToasts());

  const variantClasses: Record<string, string> = {
    success: 'bg-green-50 border-green-400 text-green-800 dark:bg-green-900/30 dark:border-green-500 dark:text-green-200',
    error: 'bg-red-50 border-red-400 text-red-800 dark:bg-red-900/30 dark:border-red-500 dark:text-red-200',
    info: 'bg-blue-50 border-blue-400 text-blue-800 dark:bg-blue-900/30 dark:border-blue-500 dark:text-blue-200',
  };

  const iconClasses: Record<string, string> = {
    success: 'text-green-500 dark:text-green-400',
    error: 'text-red-500 dark:text-red-400',
    info: 'text-blue-500 dark:text-blue-400',
  };
</script>

<!-- Fixed top-right toast container -->
<div
  class="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
  aria-live="polite"
  aria-label="Notifications"
>
  {#each toasts as toast (toast.id)}
    <div
      class="pointer-events-auto flex items-start gap-3 min-w-72 max-w-sm rounded-lg border px-4 py-3 shadow-lg
             animate-in fade-in slide-in-from-right-4 duration-200
             {variantClasses[toast.variant]}"
      role="alert"
    >
      <!-- Icon -->
      <span class="mt-0.5 shrink-0 {iconClasses[toast.variant]}">
        {#if toast.variant === 'success'}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd" />
          </svg>
        {:else if toast.variant === 'error'}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
          </svg>
        {:else}
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
          </svg>
        {/if}
      </span>

      <!-- Message -->
      <p class="flex-1 text-sm font-medium leading-5">{toast.message}</p>

      <!-- Close button -->
      <button
        class="shrink-0 ml-1 opacity-60 hover:opacity-100 transition-opacity focus:outline-none"
        onclick={() => removeToast(toast.id)}
        aria-label="Dismiss notification"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
        </svg>
      </button>
    </div>
  {/each}
</div>

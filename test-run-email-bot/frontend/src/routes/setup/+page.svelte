<script lang="ts">
  import { goto } from '$app/navigation';
  import type { AccountCreatedResponse } from '$lib/types';
  import ConnectionForm from '$lib/components/ConnectionForm.svelte';

  // Success state — set after a successful account connection
  let successResult = $state<AccountCreatedResponse | null>(null);

  function handleSuccess(result: AccountCreatedResponse) {
    successResult = result;
    // Redirect to inbox after a short confirmation delay
    setTimeout(() => {
      goto('/inbox');
    }, 2000);
  }
</script>

<svelte:head>
  <title>Connect Your Email Account</title>
</svelte:head>

<div class="flex min-h-screen items-start justify-center bg-gray-50 px-4 py-16 sm:py-24">
  <div class="w-full max-w-xl">
    <!-- Header -->
    <div class="mb-8 text-center">
      <div class="mb-4 flex items-center justify-center">
        <span class="flex h-12 w-12 items-center justify-center rounded-full bg-blue-100">
          <svg
            class="h-6 w-6 text-blue-600"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke-width="1.5"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"
            />
          </svg>
        </span>
      </div>
      <h1 class="text-2xl font-bold text-gray-900">Connect Your Email Account</h1>
      <p class="mt-2 text-sm text-gray-500">
        Your credentials stay on this machine — no data is sent to external servers.
        The AI assistant runs locally via Ollama.
      </p>
    </div>

    <!-- Card -->
    <div class="rounded-xl bg-white px-6 py-8 shadow-sm ring-1 ring-gray-200">
      {#if successResult}
        <!-- Success message -->
        <div class="text-center">
          <div class="mb-4 flex items-center justify-center">
            <span class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
              <svg
                class="h-6 w-6 text-green-600"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="2"
                stroke="currentColor"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </span>
          </div>
          <h2 class="text-lg font-semibold text-gray-900">Account connected!</h2>
          <p class="mt-2 text-sm text-gray-600">
            <span class="font-medium">{successResult.email}</span> is connected.
            Found <span class="font-medium">{successResult.inbox_count}</span>
            {successResult.inbox_count === 1 ? 'email' : 'emails'} in your inbox.
          </p>
          <p class="mt-4 text-xs text-gray-400">Redirecting to your inbox...</p>
          <div class="mt-3 flex justify-center">
            <svg
              class="h-5 w-5 animate-spin text-blue-500"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
          </div>
        </div>
      {:else}
        <ConnectionForm onsuccess={handleSuccess} />
      {/if}
    </div>

    <!-- Privacy note -->
    <p class="mt-6 text-center text-xs text-gray-400">
      Credentials are encrypted with AES-128 (Fernet) and stored only in the local SQLite database.
    </p>
  </div>
</div>

<script lang="ts">
  import { api } from '$lib/api';
  import type { PingResponse } from '$lib/types';

  let ping = $state<PingResponse | null>(null);
  let error = $state<string | null>(null);

  async function checkBackend() {
    try {
      ping = await api.get<PingResponse>('/api/ping');
    } catch (err) {
      error = String(err);
    }
  }
</script>

<div class="flex min-h-screen flex-col items-center justify-center gap-4">
  <h1 class="text-3xl font-bold">Email Assistant</h1>
  <p class="text-gray-500">Local AI-powered email client</p>
  <button
    class="rounded bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
    onclick={checkBackend}
  >
    Check backend
  </button>
  {#if ping}
    <p class="text-green-600">Backend: {ping.status}</p>
  {/if}
  {#if error}
    <p class="text-red-600">{error}</p>
  {/if}
</div>

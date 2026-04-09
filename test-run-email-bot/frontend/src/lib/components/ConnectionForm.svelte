<script lang="ts">
  import { api, ApiError } from '$lib/api';
  import type { AccountCreate, AccountCreatedResponse } from '$lib/types';
  import LoadingSpinner from './LoadingSpinner.svelte';

  interface Props {
    onsuccess?: (result: AccountCreatedResponse) => void;
  }

  let { onsuccess }: Props = $props();

  // Provider preset definitions
  type ProviderKey = 'gmail' | 'outlook' | 'fastmail' | 'custom';

  const providers: Record<ProviderKey, { label: string; imap_host: string; imap_port: number; smtp_host: string; smtp_port: number }> = {
    gmail: {
      label: 'Gmail',
      imap_host: 'imap.gmail.com',
      imap_port: 993,
      smtp_host: 'smtp.gmail.com',
      smtp_port: 587,
    },
    outlook: {
      label: 'Outlook',
      imap_host: 'outlook.office365.com',
      imap_port: 993,
      smtp_host: 'smtp.office365.com',
      smtp_port: 587,
    },
    fastmail: {
      label: 'Fastmail',
      imap_host: 'imap.fastmail.com',
      imap_port: 993,
      smtp_host: 'smtp.fastmail.com',
      smtp_port: 587,
    },
    custom: {
      label: 'Custom',
      imap_host: '',
      imap_port: 993,
      smtp_host: '',
      smtp_port: 587,
    },
  };

  // Form state
  let selectedProvider = $state<ProviderKey>('gmail');
  let email = $state('');
  let display_name = $state('');
  let imap_host = $state(providers.gmail.imap_host);
  let imap_port = $state(providers.gmail.imap_port);
  let smtp_host = $state(providers.gmail.smtp_host);
  let smtp_port = $state(providers.gmail.smtp_port);
  let username = $state('');
  let password = $state('');

  // Submission state
  let loading = $state(false);
  let errorMessage = $state<string | null>(null);

  function applyPreset(key: ProviderKey) {
    selectedProvider = key;
    const preset = providers[key];
    imap_host = preset.imap_host;
    imap_port = preset.imap_port;
    smtp_host = preset.smtp_host;
    smtp_port = preset.smtp_port;
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault();
    errorMessage = null;
    loading = true;

    const payload: AccountCreate = {
      email,
      display_name: display_name || undefined,
      imap_host,
      imap_port,
      smtp_host,
      smtp_port,
      username,
      password,
    };

    try {
      const result = await api.post<AccountCreatedResponse>('/api/accounts', payload);
      onsuccess?.(result);
    } catch (err) {
      if (err instanceof ApiError) {
        // Try to parse the error body — FastAPI returns JSON detail
        try {
          const parsed = JSON.parse(err.message);
          errorMessage = parsed.detail ?? err.message;
        } catch {
          errorMessage = err.message;
        }
      } else {
        errorMessage = String(err);
      }
    } finally {
      loading = false;
    }
  }
</script>

<form onsubmit={handleSubmit} class="space-y-6">
  <!-- Provider preset selector -->
  <div>
    <label for="provider" class="block text-sm font-medium text-gray-700 mb-1">
      Email Provider
    </label>
    <select
      id="provider"
      value={selectedProvider}
      onchange={(e) => applyPreset((e.currentTarget as HTMLSelectElement).value as ProviderKey)}
      class="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
    >
      {#each Object.entries(providers) as [key, preset]}
        <option value={key}>{preset.label}</option>
      {/each}
    </select>
  </div>

  <!-- Account info -->
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
    <div>
      <label for="email" class="block text-sm font-medium text-gray-700 mb-1">
        Email Address <span class="text-red-500">*</span>
      </label>
      <input
        id="email"
        type="email"
        bind:value={email}
        required
        placeholder="you@example.com"
        class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
    <div>
      <label for="display_name" class="block text-sm font-medium text-gray-700 mb-1">
        Display Name <span class="text-gray-400 font-normal">(optional)</span>
      </label>
      <input
        id="display_name"
        type="text"
        bind:value={display_name}
        placeholder="Your Name"
        class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  </div>

  <!-- IMAP settings -->
  <fieldset class="rounded-lg border border-gray-200 p-4">
    <legend class="px-2 text-sm font-semibold text-gray-600">IMAP (Incoming Mail)</legend>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <div class="sm:col-span-2">
        <label for="imap_host" class="block text-sm font-medium text-gray-700 mb-1">
          Host <span class="text-red-500">*</span>
        </label>
        <input
          id="imap_host"
          type="text"
          bind:value={imap_host}
          required
          placeholder="imap.example.com"
          class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div>
        <label for="imap_port" class="block text-sm font-medium text-gray-700 mb-1">
          Port <span class="text-red-500">*</span>
        </label>
        <input
          id="imap_port"
          type="number"
          bind:value={imap_port}
          required
          min="1"
          max="65535"
          class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
    </div>
  </fieldset>

  <!-- SMTP settings -->
  <fieldset class="rounded-lg border border-gray-200 p-4">
    <legend class="px-2 text-sm font-semibold text-gray-600">SMTP (Outgoing Mail)</legend>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <div class="sm:col-span-2">
        <label for="smtp_host" class="block text-sm font-medium text-gray-700 mb-1">
          Host <span class="text-red-500">*</span>
        </label>
        <input
          id="smtp_host"
          type="text"
          bind:value={smtp_host}
          required
          placeholder="smtp.example.com"
          class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      <div>
        <label for="smtp_port" class="block text-sm font-medium text-gray-700 mb-1">
          Port <span class="text-red-500">*</span>
        </label>
        <input
          id="smtp_port"
          type="number"
          bind:value={smtp_port}
          required
          min="1"
          max="65535"
          class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
    </div>
  </fieldset>

  <!-- Credentials -->
  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
    <div>
      <label for="username" class="block text-sm font-medium text-gray-700 mb-1">
        Username <span class="text-red-500">*</span>
      </label>
      <input
        id="username"
        type="text"
        bind:value={username}
        required
        autocomplete="username"
        placeholder="your@email.com"
        class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
    <div>
      <label for="password" class="block text-sm font-medium text-gray-700 mb-1">
        Password <span class="text-red-500">*</span>
      </label>
      <input
        id="password"
        type="password"
        bind:value={password}
        required
        autocomplete="current-password"
        placeholder="••••••••"
        class="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
    </div>
  </div>

  <!-- Error banner -->
  {#if errorMessage}
    <div class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
      <p class="font-medium">Connection failed</p>
      <p class="mt-1">{errorMessage}</p>
    </div>
  {/if}

  <!-- Submit button -->
  <button
    type="submit"
    disabled={loading}
    class="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
  >
    {#if loading}
      <LoadingSpinner size="sm" color="text-white" />
      Connecting...
    {:else}
      Connect Account
    {/if}
  </button>
</form>

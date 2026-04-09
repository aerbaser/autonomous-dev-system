<script lang="ts">
  import '../app.css';
  import Toast from '$lib/components/Toast.svelte';
  import { page } from '$app/stores';

  interface Props {
    children: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  // Sidebar collapse state — hidden on mobile by default
  let sidebarOpen = $state(false);

  // Navigation links
  const navLinks = [
    { href: '/inbox', label: 'Inbox', icon: 'inbox' },
    { href: '/compose', label: 'Compose', icon: 'compose' },
    { href: '/chat', label: 'Chat', icon: 'chat' },
    { href: '/setup', label: 'Settings', icon: 'settings' },
  ];

  // Close sidebar when navigating on mobile
  $effect(() => {
    $page.url.pathname;
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      sidebarOpen = false;
    }
  });

  // Hide layout chrome on root redirect page and setup page
  const currentPath = $derived($page.url.pathname);
  const hideLayout = $derived(currentPath === '/' || currentPath === '/setup');
</script>

<!-- Overlay for mobile sidebar -->
{#if sidebarOpen && !hideLayout}
  <div
    class="fixed inset-0 z-20 bg-black/40 lg:hidden"
    role="presentation"
    onclick={() => (sidebarOpen = false)}
  ></div>
{/if}

<div class="flex h-screen overflow-hidden bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
  {#if !hideLayout}
    <!-- Sidebar -->
    <aside
      class="fixed inset-y-0 left-0 z-30 flex w-60 flex-col border-r border-gray-200 dark:border-gray-800
             bg-gray-50 dark:bg-gray-900 transition-transform duration-200 ease-in-out
             {sidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:relative lg:translate-x-0"
      aria-label="Sidebar navigation"
    >
      <!-- Sidebar header / logo -->
      <div class="flex h-14 items-center gap-2 px-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <svg class="h-6 w-6 text-blue-600 dark:text-blue-400 shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
          <path d="M1.5 8.67v8.58a3 3 0 003 3h15a3 3 0 003-3V8.67l-8.928 5.493a3 3 0 01-3.144 0L1.5 8.67z" />
          <path d="M22.5 6.908V6.75a3 3 0 00-3-3h-15a3 3 0 00-3 3v.158l9.714 5.978a1.5 1.5 0 001.572 0L22.5 6.908z" />
        </svg>
        <span class="text-base font-semibold tracking-tight text-gray-800 dark:text-gray-100">Email Assistant</span>
      </div>

      <!-- Navigation -->
      <nav class="flex-1 overflow-y-auto py-3 px-2">
        {#each navLinks as link}
          <a
            href={link.href}
            class="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors
                   {currentPath.startsWith(link.href)
                     ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                     : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100'}"
          >
            <!-- Icons -->
            {#if link.icon === 'inbox'}
              <svg class="h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path fill-rule="evenodd" d="M6.912 3a3 3 0 00-2.868 2.118l-2.411 7.838a3 3 0 00-.133.882V18a3 3 0 003 3h15a3 3 0 003-3v-4.162c0-.299-.045-.596-.133-.882l-2.412-7.838A3 3 0 0017.088 3H6.912zm13.823 9.75H16.5a3 3 0 00-3 3 1.5 1.5 0 01-3 0 3 3 0 00-3-3H3.265l2.33-7.574A1.5 1.5 0 016.912 4.5h10.176a1.5 1.5 0 011.434 1.176L20.735 12.75z" clip-rule="evenodd" />
              </svg>
            {:else if link.icon === 'compose'}
              <svg class="h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path d="M21.731 2.269a2.625 2.625 0 00-3.712 0l-1.157 1.157 3.712 3.712 1.157-1.157a2.625 2.625 0 000-3.712zM19.513 8.199l-3.712-3.712-12.15 12.15a5.25 5.25 0 00-1.32 2.214l-.8 2.685a.75.75 0 00.933.933l2.685-.8a5.25 5.25 0 002.214-1.32L19.513 8.2z" />
              </svg>
            {:else if link.icon === 'chat'}
              <svg class="h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path fill-rule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97z" clip-rule="evenodd" />
              </svg>
            {:else if link.icon === 'settings'}
              <svg class="h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path fill-rule="evenodd" d="M11.078 2.25c-.917 0-1.699.663-1.85 1.567L9.05 4.889c-.02.12-.115.26-.297.348a7.493 7.493 0 00-.986.57c-.166.115-.334.126-.45.083L6.3 5.508a1.875 1.875 0 00-2.282.819l-.922 1.597a1.875 1.875 0 00.432 2.385l.84.692c.095.078.17.229.154.43a7.598 7.598 0 000 1.139c.015.2-.059.352-.153.43l-.841.692a1.875 1.875 0 00-.432 2.385l.922 1.597a1.875 1.875 0 002.282.818l1.019-.382c.115-.043.283-.031.45.082.312.214.641.405.985.57.182.088.277.228.297.35l.178 1.071c.151.904.933 1.567 1.85 1.567h1.844c.916 0 1.699-.663 1.85-1.567l.178-1.072c.02-.12.114-.26.297-.349.344-.165.673-.356.985-.57.167-.114.335-.125.45-.082l1.02.382a1.875 1.875 0 002.28-.819l.923-1.597a1.875 1.875 0 00-.432-2.385l-.84-.692c-.095-.078-.17-.229-.154-.43a7.614 7.614 0 000-1.139c-.016-.2.059-.352.153-.43l.84-.692c.708-.582.891-1.59.433-2.385l-.922-1.597a1.875 1.875 0 00-2.282-.818l-1.02.382c-.114.043-.282.031-.449-.083a7.49 7.49 0 00-.985-.57c-.183-.087-.277-.227-.297-.348l-.179-1.072a1.875 1.875 0 00-1.85-1.567h-1.843zM12 15.75a3.75 3.75 0 100-7.5 3.75 3.75 0 000 7.5z" clip-rule="evenodd" />
              </svg>
            {/if}
            {link.label}
          </a>
        {/each}
      </nav>
    </aside>
  {/if}

  <!-- Main column: header + content -->
  <div class="flex flex-1 flex-col overflow-hidden min-w-0">
    {#if !hideLayout}
      <!-- Top header -->
      <header class="flex h-14 shrink-0 items-center gap-3 border-b border-gray-200 dark:border-gray-800
                     bg-white dark:bg-gray-950 px-4">
        <!-- Hamburger button (mobile only) -->
        <button
          class="lg:hidden -ml-1 rounded-md p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          onclick={() => (sidebarOpen = !sidebarOpen)}
          aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          aria-expanded={sidebarOpen}
        >
          {#if sidebarOpen}
            <svg class="h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          {:else}
            <svg class="h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          {/if}
        </button>

        <!-- App title (visible on mobile where sidebar is hidden) -->
        <span class="text-sm font-semibold text-gray-700 dark:text-gray-200 lg:hidden">Email Assistant</span>

        <!-- Spacer -->
        <div class="flex-1"></div>

        <!-- Health indicator slot area -->
        <div class="health-indicator-slot flex items-center">
          <!-- HealthIndicator component will be placed here in T-019 -->
        </div>

        <!-- Sync status slot area -->
        <div class="sync-status-slot flex items-center">
          <!-- SyncStatus component will be placed here in T-028 -->
        </div>
      </header>
    {/if}

    <!-- Main content -->
    <main class="flex-1 overflow-y-auto {hideLayout ? '' : 'bg-gray-50 dark:bg-gray-950'}">
      {@render children()}
    </main>
  </div>
</div>

<!-- Global toast container -->
<Toast />
